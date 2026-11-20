// Run with the pinned toolchain described in B2-DESIGN.md.
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const toolsRoot = process.env.B2_CHAIN_TOOLS;
if (!toolsRoot) throw Error('Set B2_CHAIN_TOOLS to the toolchain install directory.');
const toolRequire = createRequire(join(toolsRoot, 'package.json'));
const { HDNodeWallet, Mnemonic, Interface, randomBytes, keccak256 } = toolRequire('ethers');
const solc = toolRequire('solc');
const anvil = join(toolsRoot, 'node_modules', '@foundry-rs', 'anvil-win32-amd64', 'bin', 'anvil.exe');
const port = Number(process.env.B2_CHAIN_PROBE_PORT || 18545);
const endpoint = `http://127.0.0.1:${port}`;
const transactionCount = Number(process.argv[2] || 100_000);
if (!Number.isSafeInteger(transactionCount) || transactionCount < 1) throw Error('Provide a positive transaction count.');

const source = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract TicketWriteProbe {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public version;
    mapping(uint256 => uint256) public paid;
    uint256 public count;
    event Issued(uint256 indexed slot, address indexed holder);
    function issue(uint256 slot) external {
        require(owner[slot] == address(0));
        owner[slot] = msg.sender;
        version[slot] = 1;
        paid[slot] = 200_000;
        ++count;
        emit Issued(slot, msg.sender);
    }
}`;

let nextRpcId = 0;
async function rpcBatch(calls) {
  const body = calls.map(([method, params = []]) => ({ jsonrpc: '2.0', id: ++nextRpcId, method, params }));
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const items = await response.json();
  const byId = new Map(items.map(item => [item.id, item]));
  return body.map(({ id, method }) => {
    const item = byId.get(id);
    if (!item || item.error) throw Error(`${method}: ${JSON.stringify(item?.error || 'missing response')}`);
    return item.result;
  });
}

async function rpc(method, params) {
  return (await rpcBatch([[method, params]]))[0];
}

async function main() {
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'Probe.sol': { content: source } },
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const artifact = compiled.contracts?.['Probe.sol']?.TicketWriteProbe;
  if (!artifact) throw Error(JSON.stringify(compiled.errors));
  const abi = new Interface(artifact.abi);
  const mnemonic = Mnemonic.fromEntropy(randomBytes(16)).phrase;
  const wallets = Array.from({ length: 4 }, (_, lane) =>
    HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${lane}`));
  const node = spawn(anvil, [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--accounts', '4', '--balance', '10000', '--mnemonic', mnemonic,
    '--no-mining', '--gas-limit', '30000000', '--hardfork', 'shanghai', '--silent',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  node.stderr.on('data', chunk => { launchError = String(chunk).trim(); });
  node.on('error', error => { launchError = error.message; });
  let evidenceRoot;
  let records;
  let evidenceWritten;
  try {
    const maxTries = 100;
    for (let attempt = 0; ; attempt++) {
      if (launchError || node.exitCode !== null) throw Error(launchError || 'Anvil exited');
      try {
        const accounts = await rpc('eth_accounts');
        if (accounts[0]?.toLowerCase() !== wallets[0].address.toLowerCase()) throw Error('Unexpected local chain');
        break;
      } catch (error) {
        if (attempt >= maxTries) throw error;
        await delay(100);
      }
    }
    const sign = (lane, nonce, fields) => wallets[lane].signTransaction({
      chainId: 31337, type: 2, nonce, maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n, ...fields,
    });
    const deploy = await rpc('eth_sendRawTransaction', [await sign(0, 0, {
      data: '0x' + artifact.evm.bytecode.object, gasLimit: 2_000_000n,
    })]);
    await rpc('evm_mine');
    const deployment = await rpc('eth_getTransactionReceipt', [deploy]);
    if (deployment?.status !== '0x1') throw Error('Probe deployment failed.');
    const to = deployment.contractAddress;
    const runtimeCodeHash = keccak256(await rpc('eth_getCode', [to, 'latest']));
    const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
    if (process.env.B2_CHAIN_EVIDENCE) {
      await mkdir(process.env.B2_CHAIN_EVIDENCE, { recursive: true });
      evidenceRoot = await mkdtemp(join(process.env.B2_CHAIN_EVIDENCE, 'anvil-probe-'));
      records = createGzip();
      evidenceWritten = pipeline(records, createWriteStream(join(evidenceRoot, 'receipts.ndjson.gz'), { flags: 'wx' }));
      evidenceWritten.catch(() => {});
    }
    const start = performance.now();
    const hashes = new Set();
    const nextNonce = [1, 0, 0, 0];
    let mined = 0;
    let largestGas = 0;
    let firstBlock;
    let lastBlock;
    for (let offset = 0; offset < transactionCount; offset += 100) {
      const size = Math.min(100, transactionCount - offset);
      const signed = await Promise.all(Array.from({ length: size }, (_, index) => {
        const lane = index % wallets.length;
        return sign(lane, nextNonce[lane]++, {
          to, gasLimit: 150_000n, data: abi.encodeFunctionData('issue', [offset + index + 1]),
        });
      }));
      const submitted = await rpcBatch(signed.map(raw => ['eth_sendRawTransaction', [raw]]));
      await rpc('evm_mine');
      const receipts = await rpcBatch(submitted.map(hash => ['eth_getTransactionReceipt', [hash]]));
      const waveRecords = [];
      for (const [index, receipt] of receipts.entries()) {
        const hash = submitted[index];
        const entry = receipt?.logs.length === 1 && abi.parseLog(receipt.logs[0]);
        if (hashes.has(hash) || receipt?.transactionHash !== hash || receipt.status !== '0x1' ||
            !receipt.blockHash || !receipt.blockNumber || !entry || entry.name !== 'Issued' ||
            receipt.logs[0].address.toLowerCase() !== to.toLowerCase() ||
            entry.args.slot !== BigInt(offset + index + 1) ||
            entry.args.holder !== wallets[index % wallets.length].address) {
          throw Error(`Missing, duplicate, reverted or mismatched receipt at operation ${offset + index + 1}`);
        }
        hashes.add(hash);
        const block = Number(BigInt(receipt.blockNumber));
        firstBlock ??= block;
        lastBlock = block;
        largestGas = Math.max(largestGas, Number(BigInt(receipt.gasUsed)));
        mined++;
        if (records) waveRecords.push(JSON.stringify({
          hash, block, blockHash: receipt.blockHash, status: 1, event: entry.name,
          slot: Number(entry.args.slot), holder: entry.args.holder,
        }));
      }
      if (records && !records.write(waveRecords.join('\n') + '\n')) await once(records, 'drain');
      if (mined % 10_000 === 0) console.log(`Verified ${mined} committed writes`);
    }
    const encodedCount = await rpc('eth_call', [{ to, data: abi.encodeFunctionData('count') }, 'latest']);
    const [storedCount] = abi.decodeFunctionResult('count', encodedCount);
    if (storedCount !== BigInt(transactionCount) || hashes.size !== transactionCount) throw Error('Final count mismatch.');
    const seconds = (performance.now() - start) / 1000;
    const summary = {
      successfulDistinctStateChangingTransactions: mined, contractCount: Number(storedCount),
      seconds: Number(seconds.toFixed(2)), writesPerSecond: Number((mined / seconds).toFixed(2)),
      maxObservedGas: largestGas, chainId: 31337, genesisHash: genesis.hash,
      contract: to, runtimeCodeHash, firstBlock, lastBlock,
    };
    if (records) {
      records.end();
      await evidenceWritten;
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(join(evidenceRoot, 'receipts.ndjson.gz'))) checksum.update(chunk);
      summary.receiptFileSha256 = checksum.digest('hex');
      await writeFile(join(evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
      console.log(`Evidence: ${evidenceRoot}`);
    }
    console.log(JSON.stringify(summary));
  } finally {
    if (records && !records.writableEnded) records.destroy();
    if (evidenceWritten) await evidenceWritten.catch(() => {});
    node.kill();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
