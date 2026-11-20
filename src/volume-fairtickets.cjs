const { join, resolve } = require('node:path');
const http = require('node:http');
const { readFileSync, writeFileSync, mkdirSync, createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { ethers, signAttestation, signGateCredential } = require('./toolchain.cjs');
const { startAnvil } = require('./anvil.cjs');

const root = resolve(__dirname, '..');
const artifact = JSON.parse(readFileSync(join(root, 'artifacts', 'FairTickets.json'), 'utf8'));
const iface = new ethers.Interface(artifact.abi);

const CHAIN_ID = 31337;
const BLOCK_GAS_LIMIT = 30_000_000n;
const MAX_WAVE_GAS_SUM = (BLOCK_GAS_LIMIT * 80n) / 100n; // 24,000,000 (20% block margin)
const FACE_PRICE = 200_000n;
const RESALE_PRICE = 180_000n;
const FUND_AMOUNT_HEX = '0x' + (10n * 10n ** 18n).toString(16);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeEntrantWallet(index) {
  const pk = ethers.keccak256(ethers.solidityPacked(['string', 'uint256'], ['b2-volume-entrant', index]));
  return new ethers.Wallet(pk);
}

function makeDirectRpc(endpoint) {
  const url = new URL(endpoint);
  let nextId = 0;

  function postOnce(payload) {
    return new Promise((resolveReq, rejectReq) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname || '/',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            connection: 'close',
          },
          timeout: 60_000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              rejectReq(new Error(`RPC HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolveReq(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
              rejectReq(err);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('RPC timeout')));
      req.on('error', rejectReq);
      req.end(payload);
    });
  }

  async function rpcBatch(calls) {
    const body = calls.map(([method, params = []]) => ({
      jsonrpc: '2.0',
      id: ++nextId,
      method,
      params,
    }));
    const payload = JSON.stringify(body);
    let items;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        items = await postOnce(payload);
        break;
      } catch (err) {
        if (attempt === 2 || (err.code !== 'ECONNRESET' && !String(err.message).includes('ECONNRESET'))) {
          throw err;
        }
      }
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    return body.map(({ id, method }) => {
      const item = byId.get(id);
      if (!item) throw new Error(`${method}: missing RPC response`);
      if (item.error) {
        const err = new Error(`${method}: ${item.error.message || JSON.stringify(item.error)}`);
        err.rpcError = item.error;
        throw err;
      }
      return item.result;
    });
  }

  async function rpc(method, params = []) {
    return (await rpcBatch([[method, params]]))[0];
  }

  return { rpc, rpcBatch };
}

async function signTx(wallet, nonce, to, data, value = 0n, gasLimit = 200_000n) {
  return wallet.signTransaction({
    chainId: CHAIN_ID,
    type: 2,
    nonce,
    to: to || undefined,
    data,
    value,
    gasLimit,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
}

async function sendWaveAndVerify({
  rpc,
  rpcBatch,
  op,
  txSpecs,
  expectedEventName,
  manifestStream,
  seenHashes,
  blockRange,
  contractAddress,
}) {
  // Enforce wave bounds: <= 100 txs and sum of signed gasLimits <= 80% of 30M block gas limit
  assert(txSpecs.length > 0 && txSpecs.length <= 100, `Wave size ${txSpecs.length} out of bounds (1..100)`);
  const gasSum = txSpecs.reduce((acc, s) => acc + s.gasLimit, 0n);
  assert(gasSum <= MAX_WAVE_GAS_SUM, `Wave signed gas sum ${gasSum} exceeds 20% margin cap ${MAX_WAVE_GAS_SUM}`);

  const sendCalls = txSpecs.map((s) => ['eth_sendRawTransaction', [s.raw]]);
  const sentHashes = await rpcBatch(sendCalls);
  for (let i = 0; i < sentHashes.length; i++) {
    assert(sentHashes[i].toLowerCase() === txSpecs[i].txHash.toLowerCase(), `Hash mismatch on ${op}`);
  }

  await rpc('evm_mine');

  const receiptCalls = txSpecs.map((s) => ['eth_getTransactionReceipt', [s.txHash]]);
  const receipts = await rpcBatch(receiptCalls);

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const spec = txSpecs[i];
    assert(r && r.status === '0x1', `${op} tx ${spec.txHash} failed or missing receipt (status=${r?.status})`);
    assert(!seenHashes.has(spec.txHash), `Duplicate txHash ${spec.txHash}`);
    seenHashes.add(spec.txHash);

    const blockNum = Number(BigInt(r.blockNumber));
    if (blockRange.first === null || blockNum < blockRange.first) blockRange.first = blockNum;
    if (blockRange.last === null || blockNum > blockRange.last) blockRange.last = blockNum;

    const matchedLog = r.logs
      .filter((l) => l.address.toLowerCase() === contractAddress.toLowerCase())
      .map((l) => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .find((e) => e && e.name === expectedEventName);
    assert(matchedLog, `${op} tx ${spec.txHash} missing ${expectedEventName} event`);

    const record = {
      op,
      txHash: spec.txHash,
      status: r.status,
      blockNumber: blockNum,
      gasUsed: Number(BigInt(r.gasUsed)),
      event: expectedEventName,
    };
    const line = JSON.stringify(record) + '\n';
    if (!manifestStream.write(line)) {
      await new Promise((res) => manifestStream.once('drain', res));
    }
  }

  return receipts;
}

async function main() {
  // Default: 100,000 counted writes = 99,650 entries + 100 claims + 100 listings + 50 resales + 100 admissions
  const totalTarget = Number(process.argv[2] || 100_000);
  assert(Number.isSafeInteger(totalTarget) && totalTarget >= 400, 'Target writes must be >= 400');
  const claimCount = 100;
  const listCount = 100;
  const buyCount = 50;
  const redeemCount = 100;
  const enterCount = totalTarget - (claimCount + listCount + buyCount + redeemCount);

  const port = Number(process.env.B2_VOLUME_PORT || 19510);
  const anvil = await startAnvil({ port, noMining: true, pruneHistory: 10 });
  const { endpoint } = anvil;
  const { rpc, rpcBatch } = makeDirectRpc(endpoint);

  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const manifestPath = join(root, 'artifacts', 'volume-manifest.ndjson.gz');
  const manifestStream = createGzip();
  const manifestDone = pipeline(manifestStream, createWriteStream(manifestPath));
  manifestDone.catch(() => {});

  try {
    const setupStart = performance.now();
    const organiser = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('b2-volume-organiser')));
    const attester = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('b2-volume-attester')));
    const gate = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('b2-volume-gate')));

    // Generate & pre-fund all synthetic wallets
    const entrants = new Array(enterCount);
    const addressToIdx = new Map();
    for (let i = 0; i < enterCount; i++) {
      const w = makeEntrantWallet(i);
      entrants[i] = { wallet: w, nonce: 0, subject: ethers.id(`b2-vol-subj-${i}`) };
      addressToIdx.set(w.address.toLowerCase(), i);
    }

    const allAddresses = [organiser.address, attester.address, gate.address, ...entrants.map((e) => e.wallet.address)];
    for (let i = 0; i < allAddresses.length; i += 500) {
      const chunk = allAddresses.slice(i, i + 500);
      await rpcBatch(chunk.map((addr) => ['anvil_setBalance', [addr, FUND_AMOUNT_HEX]]));
    }

    // Verify funding before load
    for (let i = 0; i < allAddresses.length; i += 1000) {
      const chunk = allAddresses.slice(i, i + 1000);
      const balances = await rpcBatch(chunk.map((addr) => ['eth_getBalance', [addr, 'latest']]));
      for (let j = 0; j < balances.length; j++) {
        assert(BigInt(balances[j]) === 10n * 10n ** 18n, `Wallet ${chunk[j]} funding check failed`);
      }
    }

    // Deploy FairTickets with long deadlines (outside counted writes)
    const block0 = await rpc('eth_getBlockByNumber', ['latest', false]);
    const now = Number(BigInt(block0.timestamp));
    const editionId = ethers.hexlify(ethers.randomBytes(32));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
    const deployTx = await factory.getDeployTransaction(
      organiser.address,
      attester.address,
      gate.address,
      BigInt(claimCount),
      FACE_PRICE,
      editionId,
      BigInt(now + 86_400),
      86_400n,
      86_400n,
      86_400n
    );
    const deployRaw = await signTx(organiser, 0, null, deployTx.data, 0n, 4_000_000n);
    const deployHash = await rpc('eth_sendRawTransaction', [deployRaw]);
    await rpc('evm_mine');
    const deployReceipt = await rpc('eth_getTransactionReceipt', [deployHash]);
    assert(deployReceipt?.status === '0x1', 'Deploy failed');
    const contractAddr = deployReceipt.contractAddress;
    const runtimeCode = await rpc('eth_getCode', [contractAddr, 'latest']);
    const runtimeCodeHash = ethers.keccak256(runtimeCode);
    const provider = new ethers.JsonRpcProvider(endpoint);
    const contract = new ethers.Contract(contractAddr, artifact.abi, provider);

    const setupMs = Math.round(performance.now() - setupStart);
    console.log(`Setup & pre-funding verified (${allAddresses.length} wallets) in ${setupMs} ms. Contract: ${contractAddr}`);

    const loadStart = performance.now();
    const seenHashes = new Set();
    const blockRange = { first: null, last: null };
    const journeySample = {};

    // Phase 1: enterCount entries in waves of up to 100
    const entryExpiry = 9999999999n;
    const enterTxHashes = new Array(enterCount);
    for (let start = 0; start < enterCount; start += 100) {
      const end = Math.min(start + 100, enterCount);
      const txSpecs = [];
      for (let i = start; i < end; i++) {
        const e = entrants[i];
        const attSig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, e.subject, e.wallet.address, entryExpiry);
        const data = iface.encodeFunctionData('enter', [e.subject, entryExpiry, attSig]);
        const gasLimit = 200_000n;
        const raw = await signTx(e.wallet, e.nonce++, contractAddr, data, 0n, gasLimit);
        const txHash = ethers.keccak256(raw);
        enterTxHashes[i] = txHash;
        txSpecs.push({ raw, txHash, gasLimit });
      }
      await sendWaveAndVerify({
        rpc, rpcBatch, op: 'enter', txSpecs, expectedEventName: 'Entered',
        manifestStream, seenHashes, blockRange, contractAddress: contractAddr,
      });
      if ((end % 10_000 === 0) || end === enterCount) {
        const elapsed = ((performance.now() - loadStart) / 1000).toFixed(1);
        console.log(`  enter progress: ${end}/${enterCount} (${elapsed}s)`);
      }
    }

    // Advance past entryDeadline and run lockDraw + draw (outside counted writes)
    await rpc('evm_increaseTime', [86_500]);
    await rpc('evm_mine');
    const lockRaw = await signTx(organiser, 1, contractAddr, iface.encodeFunctionData('lockDraw', []), 0n, 200_000n);
    const lockHash = await rpc('eth_sendRawTransaction', [lockRaw]);
    await rpc('evm_mine');
    assert((await rpc('eth_getTransactionReceipt', [lockHash]))?.status === '0x1', 'lockDraw failed');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    const drawRaw = await signTx(organiser, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 12_000_000n);
    const drawHash = await rpc('eth_sendRawTransaction', [drawRaw]);
    await rpc('evm_mine');
    const drawReceipt = await rpc('eth_getTransactionReceipt', [drawHash]);
    assert(drawReceipt?.status === '0x1', 'draw failed');

    const winners = await contract.getWinners();
    assert(winners.length === claimCount, `Expected ${claimCount} winners, got ${winners.length}`);
    const winnerSet = new Set(winners.map((w) => w.toLowerCase()));
    assert(winnerSet.size === claimCount, 'Duplicate winners');

    const winnerEntrants = winners.map((w) => entrants[addressToIdx.get(w.toLowerCase())]);
    const nonWinnerEntrants = [];
    for (let i = 0; i < enterCount && nonWinnerEntrants.length < buyCount; i++) {
      if (!winnerSet.has(entrants[i].wallet.address.toLowerCase())) {
        nonWinnerEntrants.push(entrants[i]);
      }
    }
    assert(nonWinnerEntrants.length === buyCount, 'Not enough non-winner entrants for resale buyers');

    // Phase 2: 100 claims in 1 wave (100 * 220,000 = 22,000,000 <= 24,000,000)
    const claimSpecs = [];
    for (let i = 0; i < claimCount; i++) {
      const w = winnerEntrants[i];
      const data = iface.encodeFunctionData('claim', []);
      const gasLimit = 220_000n;
      const raw = await signTx(w.wallet, w.nonce++, contractAddr, data, FACE_PRICE, gasLimit);
      claimSpecs.push({ raw, txHash: ethers.keccak256(raw), gasLimit });
    }
    await sendWaveAndVerify({
      rpc, rpcBatch, op: 'claim', txSpecs: claimSpecs, expectedEventName: 'Claimed',
      manifestStream, seenHashes, blockRange, contractAddress: contractAddr,
    });
    journeySample.slot1 = {
      winner: winnerEntrants[0].wallet.address,
      enterTx: enterTxHashes[addressToIdx.get(winnerEntrants[0].wallet.address.toLowerCase())],
      claimTx: claimSpecs[0].txHash,
    };

    // Advance into RESALE window
    await rpc('evm_increaseTime', [86_500]);
    await rpc('evm_mine');

    // Phase 3: 100 listings in 1 wave (100 * 200,000 = 20,000,000 <= 24,000,000)
    const listSpecs = [];
    for (let i = 0; i < listCount; i++) {
      const w = winnerEntrants[i];
      const slot = BigInt(i + 1);
      const data = iface.encodeFunctionData('list', [slot, 1n, RESALE_PRICE]);
      const gasLimit = 200_000n;
      const raw = await signTx(w.wallet, w.nonce++, contractAddr, data, 0n, gasLimit);
      listSpecs.push({ raw, txHash: ethers.keccak256(raw), gasLimit });
    }
    await sendWaveAndVerify({
      rpc, rpcBatch, op: 'list', txSpecs: listSpecs, expectedEventName: 'Listed',
      manifestStream, seenHashes, blockRange, contractAddress: contractAddr,
    });
    journeySample.slot1.listTx = listSpecs[0].txHash;

    // Phase 4: 50 resales (slots 1..50) in 1 wave (50 * 240,000 = 12,000,000 <= 24,000,000)
    const buySpecs = [];
    for (let i = 0; i < buyCount; i++) {
      const buyer = nonWinnerEntrants[i];
      const slot = BigInt(i + 1);
      const data = iface.encodeFunctionData('buy', [slot, 1n, RESALE_PRICE]);
      const gasLimit = 240_000n;
      const raw = await signTx(buyer.wallet, buyer.nonce++, contractAddr, data, RESALE_PRICE, gasLimit);
      buySpecs.push({ raw, txHash: ethers.keccak256(raw), gasLimit });
    }
    await sendWaveAndVerify({
      rpc, rpcBatch, op: 'buy', txSpecs: buySpecs, expectedEventName: 'Resold',
      manifestStream, seenHashes, blockRange, contractAddress: contractAddr,
    });
    journeySample.slot1.buyer = nonWinnerEntrants[0].wallet.address;
    journeySample.slot1.buyTx = buySpecs[0].txHash;

    // Advance into GATE window
    await rpc('evm_increaseTime', [86_500]);
    await rpc('evm_mine');

    const gateBlock = await rpc('eth_getBlockByNumber', ['latest', false]);
    const gateExpiry = BigInt(Number(BigInt(gateBlock.timestamp)) + 120);

    // Phase 5: 100 admissions in 1 wave with contiguous gate nonces 0..99 (100 * 200,000 = 20,000,000)
    const redeemSpecs = [];
    for (let i = 0; i < redeemCount; i++) {
      const slot = BigInt(i + 1);
      const isResold = i < buyCount;
      const currentOwner = isResold ? nonWinnerEntrants[i].wallet : winnerEntrants[i].wallet;
      const version = isResold ? 2n : 1n;
      const ownerSig = await signGateCredential(currentOwner, CHAIN_ID, contractAddr, editionId, slot, version, gateExpiry);
      const scanId = ethers.id(`vol-scan-${i + 1}`);
      const data = iface.encodeFunctionData('redeem', [slot, version, gateExpiry, ownerSig, scanId]);
      const gasLimit = 200_000n;
      const raw = await signTx(gate, i, contractAddr, data, 0n, gasLimit);
      redeemSpecs.push({ raw, txHash: ethers.keccak256(raw), gasLimit });
    }
    await sendWaveAndVerify({
      rpc, rpcBatch, op: 'redeem', txSpecs: redeemSpecs, expectedEventName: 'Admitted',
      manifestStream, seenHashes, blockRange, contractAddress: contractAddr,
    });
    journeySample.slot1.redeemTx = redeemSpecs[0].txHash;

    const loadDurationMs = Math.round(performance.now() - loadStart);
    manifestStream.end();
    await manifestDone;

    // Reconcile final on-chain state
    assert(Number(await contract.entrantsCount()) === enterCount, 'entrantsCount mismatch');
    assert(Number(await contract.winnersCount()) === claimCount, 'winnersCount mismatch');
    assert(Number(await contract.issuedCount()) === claimCount, 'issuedCount mismatch');
    assert(Number(await contract.admittedCount()) === redeemCount, 'admittedCount mismatch');

    for (let i = 0; i < claimCount; i++) {
      const slot = BigInt(i + 1);
      const isResold = i < buyCount;
      const expectedOwner = isResold ? nonWinnerEntrants[i].wallet.address : winnerEntrants[i].wallet.address;
      const expectedVersion = isResold ? 2 : 1;
      const expectedPaid = isResold ? RESALE_PRICE : FACE_PRICE;
      const [owner, version, paidPrice, admitted] = await contract.getTicket(slot);
      assert(owner.toLowerCase() === expectedOwner.toLowerCase(), `Slot ${slot} owner mismatch`);
      assert(Number(version) === expectedVersion, `Slot ${slot} version mismatch`);
      assert(paidPrice === expectedPaid, `Slot ${slot} paidPrice mismatch`);
      assert(admitted === true, `Slot ${slot} not admitted`);
    }

    const orgProceeds = await contract.proceeds(organiser.address);
    assert(orgProceeds === FACE_PRICE * BigInt(claimCount), 'Organiser proceeds mismatch');
    for (let i = 0; i < buyCount; i++) {
      const sellerProceeds = await contract.proceeds(winnerEntrants[i].wallet.address);
      assert(sellerProceeds === RESALE_PRICE, `Reseller ${i} proceeds mismatch`);
    }
    const contractBalance = await provider.getBalance(contractAddr);
    assert(contractBalance === FACE_PRICE * BigInt(claimCount) + RESALE_PRICE * BigInt(buyCount), 'Contract balance mismatch');

    assert(seenHashes.size === totalTarget, `Expected ${totalTarget} unique txHashes, got ${seenHashes.size}`);

    const manifestBytes = readFileSync(manifestPath);
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

    const writesPerSecond = Number(((totalTarget * 1000) / loadDurationMs).toFixed(2));
    const summary = {
      chainId: CHAIN_ID,
      editionId,
      contractAddress: contractAddr,
      runtimeCodeHash,
      blockRange,
      countedWrites: {
        enter: enterCount,
        claim: claimCount,
        list: listCount,
        buy: buyCount,
        redeem: redeemCount,
        total: seenHashes.size,
      },
      loadDurationMs,
      writesPerSecond,
      manifestFile: 'artifacts/volume-manifest.ndjson.gz',
      manifestBytes: manifestBytes.length,
      manifestSha256,
      reconciled: {
        entrantsCount: enterCount,
        winnersCount: claimCount,
        issuedCount: claimCount,
        admittedCount: redeemCount,
        organiserProceedsWei: orgProceeds.toString(),
        resellerProceedsEachWei: RESALE_PRICE.toString(),
        contractBalanceWei: contractBalance.toString(),
      },
      journeySample,
    };

    writeFileSync(join(root, 'artifacts', 'volume-summary.json'), JSON.stringify(summary, null, 2));
    const reportMd = [
      '# FairTickets — 100,000-Write Acceptance Workload',
      '',
      `Run timestamp: ${new Date().toISOString()}`,
      `Chain: Anvil 1.7.1 (chainId ${CHAIN_ID}, shanghai, 30M gas limit)`,
      `Contract: \`${contractAddr}\``,
      `Runtime codeHash: \`${runtimeCodeHash}\``,
      `Edition ID: \`${editionId}\``,
      `Block range: \`${blockRange.first}..${blockRange.last}\``,
      `Duration: **${(loadDurationMs / 1000).toFixed(2)} s** (**${writesPerSecond} writes/s**)`,
      `Manifest: \`${summary.manifestFile}\` (${manifestBytes.length} bytes, SHA-256 \`${manifestSha256}\`)`,
      '',
      '| Operation | Count |',
      '|---|---|',
      `| enter | ${enterCount} |`,
      `| claim | ${claimCount} |`,
      `| list | ${listCount} |`,
      `| buy | ${buyCount} |`,
      `| redeem | ${redeemCount} |`,
      `| **Total counted writes** | **${seenHashes.size}** |`,
    ].join('\n') + '\n';
    writeFileSync(join(root, 'artifacts', 'volume-report.md'), reportMd);

    console.log('\n=== VOLUME WORKLOAD COMPLETE ===');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    anvil.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
