const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, renameSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { ethers, makeRpc, signAttestation, signGateCredential } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const artifactPath = join(root, 'artifacts', 'FairTickets.json');
const journalDir = join(root, 'artifacts', 'journal');
const gateClaimsDir = join(root, 'artifacts', 'gate-claims');

function loadArtifact() {
  if (!existsSync(artifactPath)) {
    throw new Error('Missing artifacts/FairTickets.json. Run `node src/compile.cjs` first.');
  }
  return JSON.parse(readFileSync(artifactPath, 'utf8'));
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { cmd, opts };
}

function getJournalPath(address) {
  mkdirSync(journalDir, { recursive: true });
  return join(journalDir, `${address.toLowerCase()}.json`);
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function readJournal(address) {
  const p = getJournalPath(address);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJournalEntry(address, entry) {
  const p = getJournalPath(address);
  const existing = readJournal(address);
  existing.push(entry);
  writeJsonAtomic(p, existing);
}

function updateJournalEntry(address, txHash, patch) {
  const p = getJournalPath(address);
  const existing = readJournal(address);
  const idx = existing.findIndex((e) => e.txHash === txHash);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], ...patch };
    writeJsonAtomic(p, existing);
  }
}

function getGateClaimPath(scanId) {
  mkdirSync(gateClaimsDir, { recursive: true });
  const safe = scanId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(gateClaimsDir, `${safe}.json`);
}

function claimGateScanAtomic(scanId, initialData) {
  const claimPath = getGateClaimPath(scanId);
  let fd;
  try {
    fd = openSync(claimPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { claimed: false, claimPath };
    }
    throw err;
  }
  try {
    const payload = JSON.stringify(initialData, null, 2);
    require('node:fs').writeSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  return { claimed: true, claimPath };
}

function updateGateClaim(scanId, patch) {
  const claimPath = getGateClaimPath(scanId);
  const current = existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) : {};
  writeJsonAtomic(claimPath, { ...current, ...patch });
}

function parseAdmittedEvent(iface, contractAddress, receipt, scanId, slot, version) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contractAddress.toLowerCase())
    .map((l) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find(
      (e) =>
        e &&
        e.name === 'Admitted' &&
        e.args.scanId === scanId &&
        e.args.slot === BigInt(slot) &&
        e.args.version === BigInt(version)
    );
}

async function waitForReceipt(rpc, txHash, maxPolls = 60) {
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`Receipt timeout for ${txHash}`);
}

async function sendSignedTx({ rpc, wallet, to, data, value = 0n, gasLimit = 500_000n, opId = null, meta = null }) {
  const nonceHex = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
  const nonce = Number(BigInt(nonceHex));
  const chainIdHex = await rpc('eth_chainId');
  const chainId = Number(BigInt(chainIdHex));

  const signed = await wallet.signTransaction({
    chainId,
    type: 2,
    nonce,
    to: to || undefined,
    data,
    value,
    gasLimit,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const txHash = ethers.keccak256(signed);

  writeJournalEntry(wallet.address, {
    opId: opId || `${Date.now()}-${nonce}`,
    nonce,
    to: to || null,
    txHash,
    signedBytes: signed,
    status: 'PENDING',
    meta: meta || undefined,
    timestamp: new Date().toISOString(),
  });

  await rpc('eth_sendRawTransaction', [signed]);

  const receipt = await waitForReceipt(rpc, txHash);
  updateJournalEntry(wallet.address, txHash, {
    status: receipt.status === '0x1' ? 'CONFIRMED' : 'REVERTED',
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: Number(BigInt(receipt.gasUsed)),
    confirmedAt: new Date().toISOString(),
  });
  return { txHash, receipt };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const rpcUrl = opts.rpc || 'http://127.0.0.1:8545';
  const { rpc } = makeRpc(rpcUrl);
  const artifact = loadArtifact();
  const iface = new ethers.Interface(artifact.abi);

  if (!cmd || cmd === 'help') {
    console.log(
      'Commands: deploy, status, attest, enter, lock-draw, draw, claim, list, buy, sign-gate, redeem, resume, withdraw, ticket, advance-time, mine'
    );
    return;
  }

  if (cmd === 'deploy') {
    const wallet = new ethers.Wallet(opts.key);
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const now = Number(BigInt(block.timestamp));
    const editionId = opts['edition-id'] || ethers.hexlify(ethers.randomBytes(32));
    const capacity = BigInt(opts.capacity || 100);
    const facePrice = BigInt(opts['face-price'] || 200_000);
    const entryDeadline = BigInt(now + Number(opts['entry-window'] || 60));
    const claimDuration = BigInt(opts['claim-window'] || 60);
    const resaleDuration = BigInt(opts['resale-window'] || 60);
    const gateDuration = BigInt(opts['gate-window'] || 60);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
    const deployTx = await factory.getDeployTransaction(
      opts.organiser || wallet.address,
      opts.attester || wallet.address,
      opts.gate || wallet.address,
      capacity,
      facePrice,
      editionId,
      entryDeadline,
      claimDuration,
      resaleDuration,
      gateDuration
    );

    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet,
      to: null,
      data: deployTx.data,
      gasLimit: 4_000_000n,
      opId: 'deploy',
    });
    if (receipt.status !== '0x1') throw new Error(`Deploy reverted: ${txHash}`);
    const runtimeCode = await rpc('eth_getCode', [receipt.contractAddress, 'latest']);
    console.log(
      JSON.stringify(
        {
          contractAddress: receipt.contractAddress,
          txHash,
          chainId: Number(BigInt(await rpc('eth_chainId'))),
          editionId,
          codeHash: ethers.keccak256(runtimeCode),
          entryDeadline: Number(entryDeadline),
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'status') {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const c = new ethers.Contract(opts.contract, artifact.abi, provider);
    const [
      chainId,
      editionId,
      phase,
      entrantsCount,
      winnersCount,
      issuedCount,
      admittedCount,
      drawn,
      drawLocked,
      claimDeadline,
      resaleCutoff,
      gateClose,
      balance,
      code,
    ] = await Promise.all([
      rpc('eth_chainId').then((x) => Number(BigInt(x))),
      c.editionId(),
      c.phase(),
      c.entrantsCount(),
      c.winnersCount(),
      c.issuedCount(),
      c.admittedCount(),
      c.drawn(),
      c.drawLocked(),
      c.claimDeadline(),
      c.resaleCutoff(),
      c.gateClose(),
      provider.getBalance(opts.contract),
      provider.getCode(opts.contract),
    ]);
    console.log(
      JSON.stringify(
        {
          chainId,
          contract: opts.contract,
          codeHash: ethers.keccak256(code),
          editionId,
          phase,
          drawLocked,
          drawn,
          entrantsCount: Number(entrantsCount),
          winnersCount: Number(winnersCount),
          issuedCount: Number(issuedCount),
          admittedCount: Number(admittedCount),
          claimDeadline: Number(claimDeadline),
          resaleCutoff: Number(resaleCutoff),
          gateClose: Number(gateClose),
          balanceWei: balance.toString(),
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'attest') {
    const attester = new ethers.Wallet(opts.key);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const subject = opts.subject.startsWith('0x') && opts.subject.length === 66
      ? opts.subject
      : ethers.id(opts.subject);
    const sig = await signAttestation(
      attester,
      chainId,
      opts.contract,
      opts['edition-id'],
      subject,
      opts.wallet,
      BigInt(opts.expiry)
    );
    console.log(JSON.stringify({ subject, wallet: opts.wallet, expiry: opts.expiry, attestation: sig }, null, 2));
    return;
  }

  if (cmd === 'enter') {
    const wallet = new ethers.Wallet(opts.key);
    const subject = opts.subject.startsWith('0x') && opts.subject.length === 66
      ? opts.subject
      : ethers.id(opts.subject);
    const data = iface.encodeFunctionData('enter', [subject, BigInt(opts.expiry), opts.attestation]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 300_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
    return;
  }

  if (cmd === 'lock-draw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('lockDraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 200_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status }, null, 2));
    return;
  }

  if (cmd === 'draw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('draw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 12_000_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
    return;
  }

  if (cmd === 'claim') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('claim', []);
    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet,
      to: opts.contract,
      data,
      value: BigInt(opts.value),
      gasLimit: 300_000n,
    });
    console.log(JSON.stringify({ txHash, status: receipt.status }, null, 2));
    return;
  }

  if (cmd === 'list') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('list', [BigInt(opts.slot), BigInt(opts.version), BigInt(opts.price)]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 250_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status }, null, 2));
    return;
  }

  if (cmd === 'buy') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('buy', [BigInt(opts.slot), BigInt(opts.version), BigInt(opts.price)]);
    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet,
      to: opts.contract,
      data,
      value: BigInt(opts.price),
      gasLimit: 300_000n,
    });
    console.log(JSON.stringify({ txHash, status: receipt.status }, null, 2));
    return;
  }

  if (cmd === 'sign-gate') {
    const owner = new ethers.Wallet(opts.key);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const sig = await signGateCredential(
      owner,
      chainId,
      opts.contract,
      opts['edition-id'],
      BigInt(opts.slot),
      BigInt(opts.version),
      BigInt(opts.expiry)
    );
    console.log(JSON.stringify({ slot: opts.slot, version: opts.version, expiry: opts.expiry, ownerSig: sig }, null, 2));
    return;
  }

  if (cmd === 'redeem') {
    const gate = new ethers.Wallet(opts.key);
    const scanId = opts['scan-id'] || ethers.hexlify(ethers.randomBytes(32));
    const claim = claimGateScanAtomic(scanId, {
      status: 'CLAIMED',
      acted: false,
      contract: opts.contract,
      slot: String(opts.slot),
      version: String(opts.version),
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    });
    if (!claim.claimed) {
      throw new Error(`Scan ID ${scanId} already claimed or acted on.`);
    }

    const data = iface.encodeFunctionData('redeem', [
      BigInt(opts.slot),
      BigInt(opts.version),
      BigInt(opts.expiry),
      opts.sig,
      scanId,
    ]);
    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet: gate,
      to: opts.contract,
      data,
      gasLimit: 250_000n,
      opId: scanId,
      meta: {
        kind: 'gate-redeem',
        contract: opts.contract,
        scanId,
        slot: String(opts.slot),
        version: String(opts.version),
      },
    });

    if (receipt.status !== '0x1') {
      updateGateClaim(scanId, { status: 'REJECTED', acted: true, txHash });
      console.log(JSON.stringify({ decision: 'REJECT', txHash, status: receipt.status, scanId }, null, 2));
      return;
    }

    const admittedEvent = parseAdmittedEvent(iface, opts.contract, receipt, scanId, opts.slot, opts.version);
    if (!admittedEvent) {
      updateGateClaim(scanId, { status: 'HOLD_FOR_STAFF', acted: true, txHash });
      console.log(JSON.stringify({ decision: 'HOLD_FOR_STAFF', reason: 'Missing or mismatched Admitted log', txHash, scanId }, null, 2));
      return;
    }

    updateGateClaim(scanId, { status: 'ADMITTED', acted: true, txHash });
    console.log(JSON.stringify({ decision: 'ADMIT', txHash, scanId, slot: opts.slot, version: opts.version }, null, 2));
    return;
  }

  if (cmd === 'resume') {
    const address = opts.address || (opts.key ? new ethers.Wallet(opts.key).address : null);
    if (!address) {
      throw new Error('resume requires --address or --key');
    }
    const entries = readJournal(address);
    const pending = entries.filter(
      (e) => e.status === 'PENDING' && (!opts['op-id'] || e.opId === opts['op-id'])
    );
    const resumed = [];

    for (const entry of pending) {
      let receipt = await rpc('eth_getTransactionReceipt', [entry.txHash]);
      if (!receipt) {
        try {
          await rpc('eth_sendRawTransaction', [entry.signedBytes]);
        } catch (err) {
          const msg = (err.message || '').toLowerCase();
          if (!msg.includes('already known') && !msg.includes('nonce too low')) {
            throw err;
          }
        }
        receipt = await waitForReceipt(rpc, entry.txHash);
      }

      const finalStatus = receipt.status === '0x1' ? 'CONFIRMED' : 'REVERTED';
      updateJournalEntry(address, entry.txHash, {
        status: finalStatus,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        gasUsed: Number(BigInt(receipt.gasUsed)),
        resumedAt: new Date().toISOString(),
      });

      let gateDecision = null;
      if (entry.meta?.kind === 'gate-redeem') {
        const { scanId, contract: contractAddr, slot, version } = entry.meta;
        const claimPath = getGateClaimPath(scanId);
        const existingClaim = existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) : null;
        if (existingClaim?.acted) {
          gateDecision = existingClaim.status;
        } else if (receipt.status !== '0x1') {
          gateDecision = 'REJECT';
          updateGateClaim(scanId, { status: 'REJECTED', acted: true, txHash: entry.txHash, resumed: true });
        } else {
          const admittedEvent = parseAdmittedEvent(iface, contractAddr, receipt, scanId, slot, version);
          if (admittedEvent) {
            gateDecision = 'ADMIT';
            updateGateClaim(scanId, { status: 'ADMITTED', acted: true, txHash: entry.txHash, resumed: true });
          } else {
            gateDecision = 'HOLD_FOR_STAFF';
            updateGateClaim(scanId, { status: 'HOLD_FOR_STAFF', acted: true, txHash: entry.txHash, resumed: true });
          }
        }
      }

      resumed.push({
        opId: entry.opId,
        txHash: entry.txHash,
        status: finalStatus,
        gateDecision,
      });
    }

    console.log(JSON.stringify({ address, resumedCount: resumed.length, resumed }, null, 2));
    return;
  }

  if (cmd === 'withdraw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('withdraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 200_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status }, null, 2));
    return;
  }

  if (cmd === 'ticket') {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const c = new ethers.Contract(opts.contract, artifact.abi, provider);
    const [owner, version, paidPrice, admitted] = await c.getTicket(BigInt(opts.slot));
    console.log(JSON.stringify({ slot: opts.slot, owner, version: Number(version), paidPrice: paidPrice.toString(), admitted }, null, 2));
    return;
  }

  if (cmd === 'advance-time') {
    await rpc('evm_increaseTime', [Number(opts.seconds || 61)]);
    await rpc('evm_mine');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    console.log(JSON.stringify({ blockNumber: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) }, null, 2));
    return;
  }

  if (cmd === 'mine') {
    const count = Number(opts.blocks || 1);
    for (let i = 0; i < count; i++) {
      await rpc('evm_mine');
    }
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    console.log(JSON.stringify({ blockNumber: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
