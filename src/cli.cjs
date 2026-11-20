const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, linkSync, statSync } = require('node:fs');
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

function getWalletLockPath(address) {
  mkdirSync(journalDir, { recursive: true });
  return join(journalDir, `${address.toLowerCase()}.lock`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

// Atomically creates destPath with complete content via temp-write + linkSync (EEXIST if destPath exists).
// Prevents empty/partial files if a process is killed mid-write.
function createExclusiveFileAtomic(destPath, content) {
  const tmpPath = `${destPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmpPath, content);
  try {
    linkSync(tmpPath, destPath);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

async function withWalletLock(address, fn, timeoutMs = 10_000) {
  const lockPath = getWalletLockPath(address);
  const reclaimPath = `${lockPath}.reclaim`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    if (createExclusiveFileAtomic(lockPath, payload)) {
      break;
    }
    // Serialize stale-lock inspection & removal via reclaimPath so two reclaimers
    // cannot race and delete a newly-acquired live lock. Never reclaim a live PID.
    if (createExclusiveFileAtomic(reclaimPath, payload)) {
      try {
        if (existsSync(lockPath)) {
          const st = statSync(lockPath);
          const raw = readFileSync(lockPath, 'utf8');
          const lockInfo = raw ? JSON.parse(raw) : {};
          const ageMs = Date.now() - (lockInfo.createdAt || st.mtimeMs);
          if (lockInfo.pid && !isPidAlive(lockInfo.pid) && ageMs >= 100) {
            unlinkSync(lockPath);
            continue;
          }
        }
      } catch {
        // Ignore transient read/unlink races; loop will retry.
      } finally {
        try { unlinkSync(reclaimPath); } catch {}
      }
    } else {
      // If a prior reclaimer itself crashed holding reclaimPath, clean it if its PID is dead.
      try {
        const rawR = readFileSync(reclaimPath, 'utf8');
        const infoR = rawR ? JSON.parse(rawR) : {};
        if (infoR.pid && !isPidAlive(infoR.pid)) {
          unlinkSync(reclaimPath);
        }
      } catch {}
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring wallet lock for ${address}`);
    }
    await delay(15);
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function readJournal(address) {
  const p = getJournalPath(address);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJournalEntryUnlocked(address, entry) {
  const p = getJournalPath(address);
  const existing = readJournal(address);
  existing.push(entry);
  writeJsonAtomic(p, existing);
}

async function updateJournalEntry(address, txHash, patch) {
  return withWalletLock(address, () => {
    const p = getJournalPath(address);
    const existing = readJournal(address);
    const idx = existing.findIndex((e) => e.txHash === txHash);
    if (idx >= 0) {
      existing[idx] = { ...existing[idx], ...patch };
      writeJsonAtomic(p, existing);
    }
  });
}

function getGateClaimPath(scanId) {
  mkdirSync(gateClaimsDir, { recursive: true });
  const safe = scanId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(gateClaimsDir, `${safe}.json`);
}

function getGateFinalPath(scanId) {
  mkdirSync(gateClaimsDir, { recursive: true });
  const safe = scanId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(gateClaimsDir, `${safe}.final.json`);
}

function claimGateScanAtomic(scanId, initialData) {
  const claimPath = getGateClaimPath(scanId);
  const claimed = createExclusiveFileAtomic(claimPath, JSON.stringify(initialData, null, 2));
  return { claimed, claimPath };
}

function tryFinalizeGateDecision(scanId, finalData) {
  const finalPath = getGateFinalPath(scanId);
  const record = { ...finalData, pid: process.pid, finalizedAt: new Date().toISOString() };
  const wonFinalization = createExclusiveFileAtomic(finalPath, JSON.stringify(record, null, 2));
  if (!wonFinalization) {
    const existing = existsSync(finalPath) ? JSON.parse(readFileSync(finalPath, 'utf8')) : null;
    return { wonFinalization: false, existing };
  }
  const claimPath = getGateClaimPath(scanId);
  if (existsSync(claimPath)) {
    const current = JSON.parse(readFileSync(claimPath, 'utf8'));
    writeJsonAtomic(claimPath, { ...current, status: record.status || current.status, acted: true, txHash: record.txHash || current.txHash });
  }
  return { wonFinalization: true, record };
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

async function sendSignedTx({ rpc, wallet, to, data, value = 0n, gasLimit = 500_000n, opId = null, meta = null, beforeBroadcast = null }) {
  const { txHash } = await withWalletLock(wallet.address, async () => {
    if (beforeBroadcast) {
      beforeBroadcast();
    }
    const nonceHex = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
    const rpcPendingNonce = Number(BigInt(nonceHex));
    const localPendingMax = readJournal(wallet.address)
      .filter((e) => e.status === 'PENDING')
      .reduce((max, e) => Math.max(max, e.nonce), -1);
    const nonce = Math.max(rpcPendingNonce, localPendingMax + 1);

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
    const hash = ethers.keccak256(signed);

    writeJournalEntryUnlocked(wallet.address, {
      opId: opId || `${Date.now()}-${nonce}`,
      nonce,
      to: to || null,
      txHash: hash,
      signedBytes: signed,
      status: 'PENDING',
      meta: meta || undefined,
      timestamp: new Date().toISOString(),
    });

    await rpc('eth_sendRawTransaction', [signed]);
    return { txHash: hash };
  });

  const receipt = await waitForReceipt(rpc, txHash);
  await updateJournalEntry(wallet.address, txHash, {
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
      beforeBroadcast: () => {
        if (existsSync(getGateFinalPath(scanId))) {
          throw new Error(`Scan ID ${scanId} was already finalized before broadcast.`);
        }
      },
    });

    if (receipt.status !== '0x1') {
      const fin = tryFinalizeGateDecision(scanId, { decision: 'REJECT', status: 'REJECTED', txHash, slot: String(opts.slot), version: String(opts.version) });
      if (!fin.wonFinalization) {
        console.log(JSON.stringify({ decision: 'ALREADY_FINALIZED', prior: fin.existing, scanId }, null, 2));
        return;
      }
      console.log(JSON.stringify({ decision: 'REJECT', txHash, status: receipt.status, scanId }, null, 2));
      return;
    }

    const admittedEvent = parseAdmittedEvent(iface, opts.contract, receipt, scanId, opts.slot, opts.version);
    if (!admittedEvent) {
      const fin = tryFinalizeGateDecision(scanId, { decision: 'HOLD_FOR_STAFF', status: 'HOLD_FOR_STAFF', txHash, slot: String(opts.slot), version: String(opts.version) });
      if (!fin.wonFinalization) {
        console.log(JSON.stringify({ decision: 'ALREADY_FINALIZED', prior: fin.existing, scanId }, null, 2));
        return;
      }
      console.log(JSON.stringify({ decision: 'HOLD_FOR_STAFF', reason: 'Missing or mismatched Admitted log', txHash, scanId }, null, 2));
      return;
    }

    const fin = tryFinalizeGateDecision(scanId, { decision: 'ADMIT', status: 'ADMITTED', txHash, slot: String(opts.slot), version: String(opts.version) });
    if (!fin.wonFinalization) {
      console.log(JSON.stringify({ decision: 'ALREADY_FINALIZED', prior: fin.existing, scanId }, null, 2));
      return;
    }
    console.log(JSON.stringify({ decision: 'ADMIT', txHash, scanId, slot: opts.slot, version: opts.version }, null, 2));
    return;
  }

  if (cmd === 'resume') {
    const address = opts.address || (opts.key ? new ethers.Wallet(opts.key).address : null);
    if (!address) {
      throw new Error('resume requires --address or --key');
    }
    const targetOpId = opts['op-id'] || opts['scan-id'] || null;
    const entries = await withWalletLock(address, () => readJournal(address));
    const needsWork = entries.filter((e) => {
      if (targetOpId && e.opId !== targetOpId) return false;
      if (e.status === 'PENDING') return true;
      if (e.meta?.kind === 'gate-redeem' && !existsSync(getGateFinalPath(e.meta.scanId))) {
        return true;
      }
      return false;
    });
    const resumed = [];

    for (const entry of needsWork) {
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
      if (entry.status === 'PENDING') {
        await updateJournalEntry(address, entry.txHash, {
          status: finalStatus,
          blockNumber: Number(BigInt(receipt.blockNumber)),
          gasUsed: Number(BigInt(receipt.gasUsed)),
          resumedAt: new Date().toISOString(),
        });
      }

      let gateDecision = null;
      let wonFinalization = null;
      if (entry.meta?.kind === 'gate-redeem') {
        const { scanId, contract: contractAddr, slot, version } = entry.meta;
        if (receipt.status !== '0x1') {
          const fin = tryFinalizeGateDecision(scanId, { decision: 'REJECT', status: 'REJECTED', txHash: entry.txHash, slot, version, resumed: true });
          wonFinalization = fin.wonFinalization;
          gateDecision = fin.wonFinalization ? 'REJECT' : 'ALREADY_FINALIZED';
        } else {
          const admittedEvent = parseAdmittedEvent(iface, contractAddr, receipt, scanId, slot, version);
          if (admittedEvent) {
            const fin = tryFinalizeGateDecision(scanId, { decision: 'ADMIT', status: 'ADMITTED', txHash: entry.txHash, slot, version, resumed: true });
            wonFinalization = fin.wonFinalization;
            gateDecision = fin.wonFinalization ? 'ADMIT' : 'ALREADY_FINALIZED';
          } else {
            const fin = tryFinalizeGateDecision(scanId, { decision: 'HOLD_FOR_STAFF', status: 'HOLD_FOR_STAFF', txHash: entry.txHash, slot, version, resumed: true });
            wonFinalization = fin.wonFinalization;
            gateDecision = fin.wonFinalization ? 'HOLD_FOR_STAFF' : 'ALREADY_FINALIZED';
          }
        }
      }

      resumed.push({
        opId: entry.opId,
        txHash: entry.txHash,
        status: finalStatus,
        gateDecision,
        wonFinalization,
      });
    }

    // Handle interrupted pre-journal gate claim (claimed <scanId>.json, crashed before journal write).
    // Re-read the journal inside withWalletLock so a worker that wrote & exited after our initial
    // snapshot cannot be misclassified as ABORTED_BEFORE_SEND.
    if (opts['scan-id']) {
      const scanId = opts['scan-id'];
      const claimPath = getGateClaimPath(scanId);
      await withWalletLock(address, () => {
        const freshEntries = readJournal(address);
        const hasJournalEntry = freshEntries.some((e) => e.opId === scanId || e.meta?.scanId === scanId);
        if (existsSync(claimPath) && !hasJournalEntry && !existsSync(getGateFinalPath(scanId))) {
          const claimData = JSON.parse(readFileSync(claimPath, 'utf8'));
          if (claimData.pid && isPidAlive(claimData.pid)) {
            resumed.push({
              opId: scanId,
              txHash: null,
              status: 'ACTIVE_WORKER',
              gateDecision: null,
              wonFinalization: false,
            });
          } else {
            const fin = tryFinalizeGateDecision(scanId, {
              decision: 'ABORTED_BEFORE_SEND',
              status: 'ABORTED_BEFORE_SEND',
              resumed: true,
            });
            resumed.push({
              opId: scanId,
              txHash: null,
              status: 'NO_TX',
              gateDecision: fin.wonFinalization ? 'ABORTED_BEFORE_SEND' : 'ALREADY_FINALIZED',
              wonFinalization: fin.wonFinalization,
            });
          }
        }
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
