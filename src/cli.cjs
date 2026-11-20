const net = require('node:net');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, linkSync, appendFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { ethers, makeRpc, signAttestation, signGateCredential } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const artifactPath = join(root, 'artifacts', 'FairTickets.json');
const journalDir = join(root, 'artifacts', 'journal');
const gateClaimsDir = join(root, 'artifacts', 'gate-claims');
const demoFixturePath = join(root, 'artifacts', 'demo-fixture.json');
const demoStatePath = join(root, 'artifacts', 'demo-state.json');
const activityLogPath = join(root, 'artifacts', 'activity-log.ndjson');

function logActivity(event) {
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  appendFileSync(activityLogPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}

function classifyErrorCode(message, command) {
  const reason = String(message || '').toLowerCase();
  if (reason.includes('cap')) return 'RESALE_CAP_EXCEEDED';
  if (reason.includes('version mismatch') || reason.includes('stale credential')) return 'STALE_CREDENTIAL';
  if (reason.includes('already admitted')) return 'ALREADY_ADMITTED';
  if (reason.includes('scan id') && (reason.includes('claimed') || reason.includes('finalized'))) return 'ALREADY_ADMITTED';
  if (reason.includes('already claimed')) return 'ALREADY_CLAIMED';
  if (reason.includes('not a winner')) return 'NOT_WINNER';
  if (reason.includes('listing not active') || reason.includes('already listed')) return 'LISTING_NOT_ACTIVE';
  if (reason.includes('incorrect payment') || reason.includes('price mismatch')) return 'INSUFFICIENT_PAYMENT';
  if (reason.includes('signature') || reason.includes('only gate') || reason.includes('ticket not issued') || command === 'redeem') return 'FORGED_CREDENTIAL';
  if (reason.includes('phase') || reason.includes('window') || reason.includes('entry closed') || reason.includes('draw')) return 'WRONG_PHASE';
  return 'INTERNAL_ERROR';
}

function activitySubject(opts) {
  if (!opts.subject && !opts.role) return null;
  const subject = String(opts.subject || `demo-${opts.role}`);
  return subject.startsWith('0x') && subject.length === 66 ? subject : ethers.id(subject);
}

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

function getWalletLockEndpoint(address) {
  const journalPath = getJournalPath(address);
  const keyInput = process.platform === 'win32' ? journalPath.toLowerCase() : journalPath;
  const digest = createHash('sha256').update(keyInput).digest('hex').slice(0, 40);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\fairtickets-wallet-${digest}`;
  }
  if (process.platform === 'linux') {
    return `\0fairtickets-wallet-${digest}`;
  }
  throw new Error(`Unsupported platform for kernel-scoped wallet lock: ${process.platform}`);
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

function tryAcquireKernelLock(endpoint) {
  return new Promise((resolveLock, rejectLock) => {
    const server = net.createServer((sock) => sock.destroy());
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && (err.code === 'EADDRINUSE' || (process.platform === 'win32' && err.code === 'EACCES'))) {
        resolveLock(null);
      } else {
        rejectLock(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.on('error', () => {});
      resolveLock(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path: endpoint, exclusive: true });
  });
}

function closeKernelLock(server) {
  return new Promise((resolveClose) => {
    try {
      server.close(() => resolveClose());
    } catch {
      resolveClose();
    }
  });
}

async function withWalletLock(address, fn, timeoutMs = 10_000) {
  const endpoint = getWalletLockEndpoint(address);
  const deadline = Date.now() + timeoutMs;
  let server = null;
  while (true) {
    server = await tryAcquireKernelLock(endpoint);
    if (server) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring wallet lock for ${address}`);
    }
    await delay(10 + Math.floor(Math.random() * 15));
  }
  try {
    return await fn();
  } finally {
    await closeKernelLock(server);
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
  if (receipt.status !== '0x1') {
    try {
      await rpc('eth_call', [{ from: wallet.address, to: to || receipt.contractAddress, data, value: ethers.toQuantity(value) }, 'latest']);
    } catch (err) {
      receipt.revertReason = err.message || 'Contract execution reverted';
    }
  }
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
  let rpcUrl = opts.rpc || 'http://127.0.0.1:8545';
  let { rpc } = makeRpc(rpcUrl);
  const artifact = loadArtifact();
  const iface = new ethers.Interface(artifact.abi);

  // Demo keys are generated locally on first init and never committed. They are only
  // funded on the isolated Anvil chain and are not production wallet credentials.
  if (cmd === 'init-demo') {
    if (existsSync(demoStatePath)) throw new Error('Demo state already exists. Use reset-demo before creating a new fixture.');
    const rpcHost = new URL(rpcUrl).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(rpcHost) || Number(BigInt(await rpc('eth_chainId'))) !== 31337) {
      throw new Error('init-demo is restricted to a loopback Anvil node with chain ID 31337.');
    }
    const roles = Object.fromEntries(['organiser', 'gate', 'attester', 'fanA', 'fanB'].map((role) => {
      const wallet = ethers.Wallet.createRandom();
      return [role, { address: wallet.address, privateKey: wallet.privateKey }];
    }));
    const facePriceWei = String(opts['face-price'] || '50000000000000000');
    const capacity = Number(opts.capacity || 2);
    const entryWindow = Number(opts['entry-window'] || 120);
    const claimWindow = Number(opts['claim-window'] || 300);
    const resaleWindow = Number(opts['resale-window'] || 300);
    const gateWindow = Number(opts['gate-window'] || 600);
    const funding = '0x' + (10n * 10n ** 18n).toString(16);
    await Promise.all(Object.values(roles).map((r) => rpc('anvil_setBalance', [r.address, funding])));
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    const entryDeadline = BigInt(Number(BigInt(latest.timestamp)) + entryWindow);
    const editionId = ethers.hexlify(ethers.randomBytes(32));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
    const tx = await factory.getDeployTransaction(roles.organiser.address, roles.attester.address, roles.gate.address,
      BigInt(capacity), BigInt(facePriceWei), editionId, entryDeadline, BigInt(claimWindow), BigInt(resaleWindow), BigInt(gateWindow));
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet: new ethers.Wallet(roles.organiser.privateKey), to: null, data: tx.data, gasLimit: 4_000_000n, opId: 'demo-deploy' });
    if (receipt.status !== '0x1') throw new Error(`Demo deployment reverted: ${txHash}`);
    const codeHash = ethers.keccak256(await rpc('eth_getCode', [receipt.contractAddress, 'latest']));
    const fixture = { roles, facePriceWei, capacity, entryWindow, claimWindow, resaleWindow, gateWindow };
    const state = { contract: receipt.contractAddress, editionId, codeHash, chainId: Number(BigInt(await rpc('eth_chainId'))), rpcUrl };
    writeFileSync(demoFixturePath, JSON.stringify(fixture, null, 2), { flag: 'wx', mode: 0o600 });
    writeFileSync(demoStatePath, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ok: true, ...state, txHash, capacity, facePriceWei }, null, 2));
    return;
  }

  if (cmd === 'reset-demo') {
    // Explicit reset clears only locally persisted demo identity/state. It does not
    // rewind the chain; init-demo deploys a fresh contract after this command.
    for (const p of [demoStatePath, demoFixturePath]) if (existsSync(p)) unlinkSync(p);
    console.log(JSON.stringify({ ok: true, reset: true }, null, 2));
    return;
  }

  let fixture = null;
  let demoState = null;
  if (existsSync(demoFixturePath)) fixture = JSON.parse(readFileSync(demoFixturePath, 'utf8'));
  if (existsSync(demoStatePath)) demoState = JSON.parse(readFileSync(demoStatePath, 'utf8'));
  if (opts.role) {
    if (!fixture || !fixture.roles[opts.role]) throw new Error(`Unknown or unavailable demo role: ${opts.role}`);
    opts.key = opts.key || fixture.roles[opts.role].privateKey;
    opts.contract = opts.contract || demoState?.contract;
    opts['edition-id'] = opts['edition-id'] || demoState?.editionId;
    opts.rpc = opts.rpc || demoState?.rpcUrl;
  }
  if (opts.rpc && opts.rpc !== rpcUrl) {
    rpcUrl = opts.rpc;
    ({ rpc } = makeRpc(rpcUrl));
  }
  if (demoState && !opts.contract && !['deploy'].includes(cmd)) opts.contract = demoState.contract;
  if (demoState && !opts['edition-id']) opts['edition-id'] = demoState.editionId;
  {
    const jsonMode = Boolean(opts.json);
    const log = console.log.bind(console);
    console.log = (...args) => {
      if (args.length === 1 && typeof args[0] === 'string') {
        try {
          const value = JSON.parse(args[0]);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const status = value.status;
            const gateDecision = value.decision;
            if (jsonMode && gateDecision === 'ADMIT') value.txStatus = 'confirmed';
            else if (jsonMode && gateDecision === 'HOLD_FOR_STAFF') value.txStatus = 'unknown_recovering';
            else if (jsonMode && gateDecision === 'ALREADY_FINALIZED') value.txStatus = value.prior?.decision === 'ADMIT' ? 'confirmed' : value.prior?.decision === 'REJECT' ? 'rejected' : 'unknown_recovering';
            else if (jsonMode && (status === '0x1')) value.txStatus = 'confirmed';
            else if (jsonMode && (status === '0x0' || gateDecision === 'REJECT')) value.txStatus = 'rejected';
            if (jsonMode && value.txHash) value.txHash = String(value.txHash);
            if (jsonMode && value.txStatus === 'rejected') {
              value.errorCode = classifyErrorCode(value.reason, cmd);
              value.error = value.reason || 'The contract rejected this transaction.';
              value.reason = value.error;
            }
            if (['enter', 'lock-draw', 'draw', 'claim', 'list', 'buy', 'redeem', 'withdraw', 'resume', 'advance-time'].includes(cmd)) logActivity({ action: cmd, role: opts.role || null, subject: cmd === 'enter' ? activitySubject(opts) : null,
              scanId: value.scanId || opts['scan-id'] || null, success: value.txStatus !== 'rejected' && value.status !== '0x0' && value.decision !== 'REJECT', txHash: value.txHash || null });
            return log(jsonMode ? JSON.stringify(value, null, 2) : args[0]);
          }
        } catch {}
      }
      return log(...args);
    };
  }

  if (!cmd || cmd === 'help') {
    console.log('Commands: init-demo, reset-demo, deploy, status, attest, enter, lock-draw, draw, claim, list, buy, sign-gate, redeem, resume, withdraw, ticket, advance-time, mine, alerts');
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
    const capacity = Number(await c.capacity());
    const winners = drawn ? await c.getWinners() : [];
    const tickets = await Promise.all(Array.from({ length: capacity }, async (_, i) => {
      const slot = i + 1;
      const [owner, version, paidPriceWei, admitted] = await c.getTicket(BigInt(slot));
      const [seller, resalePriceWei, active] = await c.getListing(BigInt(slot), BigInt(version));
      return { slot, owner, version: Number(version), paidPriceWei: paidPriceWei.toString(), admitted, listed: active, resalePriceWei: active ? resalePriceWei.toString() : '0', seller };
    }));
    const roles = {};
    if (fixture) {
      for (const [role, account] of Object.entries(fixture.roles)) {
        roles[role] = {
          role,
          label: role === 'fanA' ? 'Fan A' : role === 'fanB' ? 'Fan B' : role[0].toUpperCase() + role.slice(1),
          address: account.address,
          ethBalanceWei: (await provider.getBalance(account.address)).toString(),
          withdrawableWei: (await c.proceeds(account.address)).toString(),
        };
      }
    }
    let volumeEvidence;
    const volumeSummaryPath = join(root, 'artifacts', 'volume-summary.json');
    if (existsSync(volumeSummaryPath)) {
      const s = JSON.parse(readFileSync(volumeSummaryPath, 'utf8'));
      volumeEvidence = { totalWrites: s.countedWrites?.total, writesPerSecond: s.writesPerSecond, manifestSha256: s.manifestSha256 };
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          chainId,
          contract: opts.contract,
          rpcUrl,
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
          capacity,
          facePriceWei: (await c.facePrice()).toString(),
          maxResalePriceWei: (await c.facePrice()).toString(),
          winners: winners.map((w) => w.toLowerCase()),
          tickets,
          roles,
          ...(volumeEvidence ? { volumeEvidence } : {}),
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
    const subjectText = opts.subject || `demo-${opts.role || wallet.address}`;
    const subject = subjectText.startsWith('0x') && subjectText.length === 66
      ? subjectText
      : ethers.id(subjectText);
    const expiry = BigInt(opts.expiry || '9999999999');
    let attestation = opts.attestation;
    if (!attestation && opts.role && fixture?.roles?.attester && demoState) {
      const attester = new ethers.Wallet(fixture.roles.attester.privateKey);
      attestation = await signAttestation(attester, Number(BigInt(await rpc('eth_chainId'))), opts.contract, opts['edition-id'], subject, wallet.address, expiry);
    }
    if (!attestation) throw new Error('enter requires --attestation unless a demo --role is selected.');
    const data = iface.encodeFunctionData('enter', [subject, expiry, attestation]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 300_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
    return;
  }

  if (cmd === 'lock-draw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('lockDraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 200_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null }, null, 2));
    return;
  }

  if (cmd === 'draw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('draw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 12_000_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
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
      value: BigInt(opts.value || fixture?.facePriceWei || 200_000),
      gasLimit: 300_000n,
    });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null }, null, 2));
    return;
  }

  if (cmd === 'list') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('list', [BigInt(opts.slot), BigInt(opts.version), BigInt(opts.price)]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 250_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null }, null, 2));
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
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null }, null, 2));
    return;
  }

  if (cmd === 'sign-gate') {
    const owner = new ethers.Wallet(opts.key);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    const expiry = BigInt(opts.expiry || Number(BigInt(latest.timestamp)) + 120);
    const sig = await signGateCredential(
      owner,
      chainId,
      opts.contract,
      opts['edition-id'],
      BigInt(opts.slot),
      BigInt(opts.version),
      expiry
    );
    console.log(JSON.stringify({ contract: opts.contract, editionId: opts['edition-id'], slot: Number(opts.slot), version: Number(opts.version), expiry: Number(expiry), ownerSig: sig }, null, 2));
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
      opts.sig || opts['owner-sig'],
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
    console.log(JSON.stringify({ decision: 'REJECT', txHash, status: receipt.status, reason: receipt.revertReason || null, scanId }, null, 2));
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
    const targetTxHash = opts['tx-hash'] ? String(opts['tx-hash']).toLowerCase() : null;
    const entries = await withWalletLock(address, () => readJournal(address));
    const needsWork = entries.filter((e) => {
      if (targetOpId && e.opId !== targetOpId) return false;
      if (targetTxHash && String(e.txHash).toLowerCase() !== targetTxHash) return false;
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

    const txStatus = resumed.some((x) => x.status === 'ACTIVE_WORKER') ? 'pending'
      : resumed.some((x) => x.status === 'REVERTED' || x.gateDecision === 'ABORTED_BEFORE_SEND') ? 'rejected' : 'confirmed';
    console.log(JSON.stringify({ ok: true, txStatus, txHash: resumed.find((x) => x.txHash)?.txHash || null, address, resumedCount: resumed.length, resumed }, null, 2));
    return;
  }

  if (cmd === 'withdraw') {
    const wallet = new ethers.Wallet(opts.key);
    const data = iface.encodeFunctionData('withdraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: opts.contract, data, gasLimit: 200_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, reason: receipt.revertReason || null }, null, 2));
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

  if (cmd === 'alerts') {
    const records = existsSync(activityLogPath)
      ? readFileSync(activityLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const alerts = [];
    const entriesBySubject = new Map();
    const failedByScan = new Map();
    for (const row of records) {
      if (row.action === 'enter' && row.subject) entriesBySubject.set(row.subject, (entriesBySubject.get(row.subject) || 0) + 1);
      if (row.action === 'redeem' && row.scanId && !row.success) failedByScan.set(row.scanId, (failedByScan.get(row.scanId) || 0) + 1);
    }
    const timestamp = new Date().toISOString();
    for (const [subjectOrSlot, count] of entriesBySubject) if (count >= 3) alerts.push({ id: `entry-${subjectOrSlot}`, severity: 'review', rule: 'REPEATED_ENTRY_SUBJECT', count, reason: 'The same demo subject has made repeated entry requests.', subjectOrSlot, timestamp, note: 'Review signal only; does not auto-block' });
    for (const [subjectOrSlot, count] of failedByScan) if (count >= 2) alerts.push({ id: `scan-${subjectOrSlot}`, severity: 'review', rule: 'REPEATED_FAILED_SCAN', count, reason: 'A scan ID has repeated failed admission attempts.', subjectOrSlot, timestamp, note: 'Review signal only; does not auto-block' });
    const now = Date.now();
    const recent = records.filter((row) => now - Date.parse(row.timestamp) <= 10_000);
    if (recent.length >= 5) alerts.push({ id: `burst-${Math.floor(now / 10000)}`, severity: 'review', rule: 'REQUEST_BURST', count: recent.length, reason: 'Five or more requests were recorded within ten seconds.', subjectOrSlot: 'event', timestamp, note: 'Review signal only; does not auto-block' });
    console.log(JSON.stringify({ ok: true, alerts }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

module.exports = { withWalletLock, getWalletLockEndpoint };

if (require.main === module) {
  main().catch((err) => {
    const parsed = parseArgs(process.argv.slice(2));
    try { if (['enter', 'lock-draw', 'draw', 'claim', 'list', 'buy', 'redeem', 'withdraw', 'resume', 'advance-time'].includes(parsed.cmd)) logActivity({ action: parsed.cmd, role: parsed.opts.role || null, subject: parsed.cmd === 'enter' ? activitySubject(parsed.opts) : null,
      scanId: parsed.opts['scan-id'] || null, success: false, error: err.message || String(err) }); } catch {}
    if (parsed.opts.json) {
      const message = err.message || String(err);
      const unavailable = /timeout|timed out|network|rpc|socket|fetch failed|connection reset|econn|missing rpc response/i.test(message);
      console.log(JSON.stringify({ ok: false, txStatus: unavailable ? 'unknown_recovering' : 'rejected', txHash: null,
        errorCode: unavailable ? 'RPC_TIMEOUT' : classifyErrorCode(message, parsed.cmd), error: message, reason: message }, null, 2));
    } else console.error(err.message || err);
    process.exit(1);
  });
}
