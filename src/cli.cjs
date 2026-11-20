const net = require('node:net');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, linkSync, appendFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { ethers, makeRpc, signAttestation, signGateCredential } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const stateDir = resolve(process.env.FAIRTICKETS_STATE_DIR || join(root, 'artifacts'));
const artifactPath = join(root, 'artifacts', 'FairTickets.json');
const demoFixturePath = join(stateDir, 'demo-fixture.json');
const demoStatePath = join(stateDir, 'demo-state.json');
const volumeSummaryPath = join(root, 'artifacts', 'volume-summary.json');
const journalDir = join(stateDir, 'journal');
const gateClaimsDir = join(stateDir, 'gate-claims');
const activityLogPath = join(stateDir, 'activity-log.ndjson');

function logActivity(event) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(activityLogPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}

function classifyErrorCode(message, command) {
  const reason = String(message || '').toLowerCase();
  if (reason.includes('price exceeds cap') || reason.includes('exceeds cap')) return 'RESALE_CAP_EXCEEDED';
  if (reason.includes('already admitted') || (reason.includes('scan id') && (reason.includes('claimed') || reason.includes('finalized')))) {
    return 'ALREADY_ADMITTED';
  }
  if (
    reason.includes('version mismatch') ||
    reason.includes('invalid expiry') ||
    reason.includes('attestation expired') ||
    reason.includes('stale credential')
  ) {
    return 'STALE_CREDENTIAL';
  }
  if (
    reason.includes('not in gate window') ||
    reason.includes('not in resale window') ||
    reason.includes('claim window closed') ||
    reason.includes('entry closed') ||
    reason.includes('entry still open') ||
    reason.includes('draw already started') ||
    reason.includes('draw already locked') ||
    reason.includes('already drawn') ||
    reason.includes('draw not locked') ||
    reason.includes('draw not completed') ||
    reason.includes('target block not reached') ||
    reason.includes('draw window missed') ||
    reason.includes('zero target hash') ||
    reason.includes('wrong phase')
  ) {
    return 'WRONG_PHASE';
  }
  if (
    reason.includes('invalid owner signature') ||
    reason.includes('invalid signature') ||
    reason.includes('invalid attestation') ||
    reason.includes('only gate') ||
    reason.includes('ticket not issued') ||
    reason.includes('ecdsa') ||
    (command === 'redeem' && (reason.includes('invalid byteslike') || reason.includes('missing --owner-sig') || reason.includes('signature')))
  ) {
    return 'FORGED_CREDENTIAL';
  }
  if (reason.includes('not a winner')) return 'NOT_WINNER';
  if (reason.includes('already claimed')) return 'ALREADY_CLAIMED';
  if (reason.includes('listing not active') || reason.includes('already listed') || reason.includes('seller no longer owner')) {
    return 'LISTING_NOT_ACTIVE';
  }
  if (reason.includes('incorrect payment') || reason.includes('price mismatch')) return 'INSUFFICIENT_PAYMENT';
  if (isRpcRecoverableError({ message })) return 'RPC_TIMEOUT';
  return 'INTERNAL_ERROR';
}

function normalizeScanId(rawScanId) {
  if (typeof rawScanId !== 'string' || !rawScanId.trim()) {
    return ethers.hexlify(ethers.randomBytes(32));
  }
  const trimmed = rawScanId.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed;
  }
  return ethers.id(trimmed);
}

function extractRevertReason(err) {
  const data = typeof err?.rpcError?.data === 'string' ? err.rpcError.data : null;
  if (data && data.startsWith('0x')) {
    if (data.startsWith('0x08c379a0') && data.length >= 138) {
      try {
        const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10));
        if (decoded) return String(decoded);
      } catch {}
    }
    if (data.startsWith('0xf645eedf') || data.startsWith('0xfce698f7') || data.startsWith('0xd78bce0c')) {
      return 'Invalid owner signature (ECDSA)';
    }
    if (data.startsWith('0x4e487b71') && data.length >= 74) {
      try {
        const [code] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10));
        return `Contract panic (0x${BigInt(code).toString(16)})`;
      } catch {}
    }
  }
  const rawMsg = String(err?.message || 'Contract execution reverted');
  const lower = rawMsg.toLowerCase();
  if (lower.includes('0xf645eedf') || lower.includes('0xfce698f7') || lower.includes('0xd78bce0c') || lower.includes('ecdsainvalidsignature')) {
    return 'Invalid owner signature (ECDSA)';
  }
  const stripped = rawMsg.replace(/^(?:eth_call:\s*)?(?:execution reverted:\s*)?(?:revert:\s*)?/i, '').trim();
  return stripped || 'Contract execution reverted';
}

function isRpcRecoverableError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  const message = [
    err?.message,
    err?.cause?.message,
    err?.cause?.code,
    err?.code,
    typeof err === 'string' ? err : '',
  ].filter(Boolean).join(' ');
  return /receipt timeout|timed out|timeout|fetch failed|failed to detect network|econnrefused|econnreset|etimedout|enotfound|socket|network|connection reset|missing rpc response|rpc http 5\d\d|timed out acquiring wallet lock/i.test(message);
}

function makeProvider(rpcUrl, chainId = null) {
  if (chainId != null) {
    return new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: ethers.Network.from(chainId) });
  }
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

function activitySubject(opts) {
  if (!opts.subject && !opts.role) return null;
  const subject = String(opts.subject || `demo-${opts.role}`);
  return subject.startsWith('0x') && subject.length === 66 ? subject : ethers.id(subject);
}

function activitySubjectLabel(opts) {
  if (!opts.subject && !opts.role) return null;
  return String(opts.subject || `demo-${opts.role}`);
}

function loadArtifact() {
  if (!existsSync(artifactPath)) {
    throw new Error('Missing artifacts/FairTickets.json. Run `node src/compile.cjs` first.');
  }
  return JSON.parse(readFileSync(artifactPath, 'utf8'));
}

function loadDemoFixture() {
  if (!existsSync(demoFixturePath)) return null;
  return JSON.parse(readFileSync(demoFixturePath, 'utf8'));
}

function loadDemoState() {
  if (!existsSync(demoStatePath)) return null;
  return JSON.parse(readFileSync(demoStatePath, 'utf8'));
}

function saveDemoState(state) {
  writeJsonAtomic(demoStatePath, state);
}

function resolveRoleKey(opts, fallbackRole = null) {
  if (opts.key) return opts.key;
  const role = opts.role || fallbackRole;
  if (!role) throw new Error('Missing --key or --role');
  const fixture = loadDemoFixture();
  const entry = fixture?.roles?.[role];
  if (!entry?.privateKey) {
    throw new Error(`Unknown role: ${role}`);
  }
  return entry.privateKey;
}

function resolveContract(opts) {
  const c = opts.contract || loadDemoState()?.contract;
  if (!c) throw new Error('Missing --contract (and no artifacts/demo-state.json found; run init-demo first)');
  return c;
}

function resolveEditionId(opts) {
  return opts['edition-id'] || loadDemoState()?.editionId || null;
}

function resolveRpcUrl(opts) {
  return opts.rpc || loadDemoState()?.rpcUrl || loadDemoFixture()?.rpcUrl || 'http://127.0.0.1:8545';
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

    try {
      await rpc('eth_sendRawTransaction', [signed]);
    } catch (err) {
      if (err && typeof err === 'object') err.txHash = hash;
      throw err;
    }
    return { txHash: hash };
  });

  let receipt;
  try {
    receipt = await waitForReceipt(rpc, txHash);
  } catch (err) {
    if (err && typeof err === 'object') err.txHash = txHash;
    throw err;
  }
  if (receipt.status !== '0x1') {
    try {
      await rpc('eth_call', [{ from: wallet.address, to: to || receipt.contractAddress, data, value: ethers.toQuantity(value) }, receipt.blockNumber || 'latest']);
    } catch (err) {
      receipt.revertReason = extractRevertReason(err);
    }
  }
  await updateJournalEntry(wallet.address, txHash, {
    status: receipt.status === '0x1' ? 'CONFIRMED' : 'REVERTED',
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: Number(BigInt(receipt.gasUsed)),
    revertReason: receipt.revertReason || null,
    confirmedAt: new Date().toISOString(),
  });
  return { txHash, receipt };
}

async function readTicketState(contract, slot) {
  if (!slot || Number(slot) <= 0) return null;
  const [owner, version, paidPrice, admitted] = await contract.getTicket(BigInt(slot));
  const vNum = Number(version);
  let listed = false;
  let resalePriceWei = '0';
  let seller = ethers.ZeroAddress;
  if (vNum > 0) {
    const [listingSeller, price, active] = await contract.getListing(BigInt(slot), version);
    seller = listingSeller;
    listed = Boolean(active);
    if (active) resalePriceWei = price.toString();
  }
  return {
    slot: Number(slot),
    owner,
    version: vNum,
    paidPriceWei: paidPrice.toString(),
    admitted: Boolean(admitted),
    listed,
    resalePriceWei,
    seller,
  };
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
    if (existsSync(demoStatePath) || existsSync(demoFixturePath)) {
      throw new Error('Demo state already exists. Use reset-demo before creating a new fixture.');
    }
    const rpcHost = new URL(rpcUrl).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(rpcHost) || Number(BigInt(await rpc('eth_chainId'))) !== 31337) {
      throw new Error('init-demo is restricted to a loopback Anvil node with chain ID 31337.');
    }
    mkdirSync(stateDir, { recursive: true });
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
    console.log(JSON.stringify({ ok: true, ...(opts.json ? { txStatus: 'confirmed' } : {}), ...state, txHash, capacity, facePriceWei }, null, 2));
    return;
  }

  if (cmd === 'reset-demo') {
    // Explicit reset clears only locally persisted demo identity/state. It does not
    // rewind the chain; init-demo deploys a fresh contract after this command.
    for (const p of [demoStatePath, demoFixturePath, activityLogPath]) if (existsSync(p)) unlinkSync(p);
    console.log(JSON.stringify({ ok: true, ...(opts.json ? { txStatus: 'confirmed' } : {}), reset: true }, null, 2));
    return;
  }

  let fixture = null;
  let demoState = null;
  if (existsSync(demoFixturePath)) fixture = JSON.parse(readFileSync(demoFixturePath, 'utf8'));
  if (existsSync(demoStatePath)) demoState = JSON.parse(readFileSync(demoStatePath, 'utf8'));
  if (demoState && !opts.rpc) opts.rpc = demoState.rpcUrl;
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
            if (jsonMode && gateDecision && !value.gateDecision) value.gateDecision = gateDecision;
            if (jsonMode && !value.txStatus) {
              if (gateDecision === 'ADMIT') value.txStatus = 'confirmed';
              else if (gateDecision === 'HOLD_FOR_STAFF') value.txStatus = 'unknown_recovering';
              else if (gateDecision === 'ALREADY_FINALIZED') value.txStatus = value.prior?.decision === 'ADMIT' ? 'confirmed' : value.prior?.decision === 'REJECT' ? 'rejected' : 'unknown_recovering';
              else if (status === '0x1') value.txStatus = 'confirmed';
              else if (status === '0x0' || gateDecision === 'REJECT') value.txStatus = 'rejected';
            }
            if (jsonMode && value.txHash) value.txHash = String(value.txHash);
            if (jsonMode && value.txStatus) {
              if (value.txStatus === 'confirmed') {
                value.ok = true;
                value.errorCode = value.errorCode ?? null;
                value.error = value.error ?? null;
              } else if (value.txStatus === 'rejected') {
                const msg = value.reason || value.error || null;
                value.ok = false;
                value.errorCode = value.errorCode || classifyErrorCode(msg, cmd);
                value.error = msg || 'The contract rejected this transaction.';
                value.reason = value.error;
              } else if (value.txStatus === 'unknown_recovering') {
                value.ok = false;
                value.errorCode = value.errorCode || 'RPC_TIMEOUT';
              } else {
                value.ok = false;
              }
            }
            if (['enter', 'lock-draw', 'draw', 'claim', 'list', 'buy', 'redeem', 'withdraw', 'resume', 'advance-time'].includes(cmd)) {
              const rawScanIdOpt = typeof opts['scan-id'] === 'string' && opts['scan-id'].trim() ? normalizeScanId(opts['scan-id']) : null;
              const failed =
                value.txStatus === 'rejected' ||
                value.txStatus === 'unknown_recovering' ||
                value.status === '0x0' ||
                value.decision === 'REJECT' ||
                value.gateDecision === 'REJECT';
              logActivity({
                action: cmd,
                role: opts.role || null,
                subject: cmd === 'enter' ? activitySubject(opts) : null,
                subjectLabel: cmd === 'enter' ? activitySubjectLabel(opts) : null,
                scanId: value.scanId || rawScanIdOpt || null,
                success: !failed,
                txHash: value.txHash || null,
              });
            }
            return log(jsonMode ? JSON.stringify(value, null, 2) : args[0]);
          }
        } catch {}
      }
      if (jsonMode && cmd && cmd !== 'help') {
        return console.error(...args);
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
    const contractAddress = resolveContract(opts);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const provider = makeProvider(rpcUrl, chainId);
    const code = await provider.getCode(contractAddress);
    if (!code || code === '0x') {
      throw new Error(`No FairTickets contract deployed at ${contractAddress} on ${rpcUrl}. Run reset-demo and init-demo if Anvil was restarted.`);
    }
    const c = new ethers.Contract(contractAddress, artifact.abi, provider);
    const [
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
    ] = await Promise.all([
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
      provider.getBalance(contractAddress),
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
    if (existsSync(volumeSummaryPath)) {
      try {
        const s = JSON.parse(readFileSync(volumeSummaryPath, 'utf8'));
        volumeEvidence = { totalWrites: s.totalWrites ?? s.countedWrites?.total, writesPerSecond: s.writesPerSecond, manifestSha256: s.manifestSha256 };
      } catch {}
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          chainId,
          contract: contractAddress,
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
          contractBalanceWei: balance.toString(),
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
    const attester = new ethers.Wallet(resolveRoleKey(opts, 'attester'));
    const contractAddress = resolveContract(opts);
    const editionId = resolveEditionId(opts);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const subject = opts.subject.startsWith('0x') && opts.subject.length === 66
      ? opts.subject
      : ethers.id(opts.subject);
    const sig = await signAttestation(
      attester,
      chainId,
      contractAddress,
      editionId,
      subject,
      opts.wallet,
      BigInt(opts.expiry)
    );
    console.log(JSON.stringify({ subject, wallet: opts.wallet, expiry: opts.expiry, attestation: sig }, null, 2));
    return;
  }

  if (cmd === 'enter') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    const subjectText = opts.subject || `demo-${opts.role || wallet.address}`;
    const subject = subjectText.startsWith('0x') && subjectText.length === 66
      ? subjectText
      : ethers.id(subjectText);
    let expiry = opts.expiry;
    let attestation = opts.attestation;
    if (!attestation && fixture?.roles?.attester) {
      const attester = new ethers.Wallet(fixture.roles.attester.privateKey);
      const chainId = Number(BigInt(await rpc('eth_chainId')));
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      expiry = expiry || String(Number(BigInt(block.timestamp)) + 300);
      const editionId = resolveEditionId(opts);
      attestation = await signAttestation(attester, chainId, contractAddress, editionId, subject, wallet.address, BigInt(expiry));
    }
    if (!attestation) throw new Error('enter requires --attestation unless a demo --role is selected.');
    const data = iface.encodeFunctionData('enter', [subject, BigInt(expiry), attestation]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: contractAddress, data, gasLimit: 300_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
    return;
  }

  if (cmd === 'lock-draw') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts, 'organiser'));
    const contractAddress = resolveContract(opts);
    const data = iface.encodeFunctionData('lockDraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: contractAddress, data, gasLimit: 200_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null }, null, 2));
    return;
  }

  if (cmd === 'draw') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts, 'organiser'));
    const contractAddress = resolveContract(opts);
    const data = iface.encodeFunctionData('draw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: contractAddress, data, gasLimit: 12_000_000n });
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null, gasUsed: Number(BigInt(receipt.gasUsed)) }, null, 2));
    return;
  }

  if (cmd === 'claim') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    let valueWei = opts.value ? BigInt(opts.value) : null;
    if (valueWei === null) {
      const provider = makeProvider(rpcUrl);
      const c = new ethers.Contract(contractAddress, artifact.abi, provider);
      valueWei = await c.facePrice();
    }
    const data = iface.encodeFunctionData('claim', []);
    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet,
      to: contractAddress,
      data,
      value: valueWei,
      gasLimit: 300_000n,
    });
    let ticket = null;
    if (opts.json && receipt.status === '0x1') {
      const provider = makeProvider(rpcUrl);
      const c = new ethers.Contract(contractAddress, artifact.abi, provider);
      const slot = Number(await c.heldSlot(wallet.address));
      if (slot > 0) ticket = await readTicketState(c, slot);
    }
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null, ...(ticket ? { ticket } : {}) }, null, 2));
    return;
  }

  if (cmd === 'list') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    const data = iface.encodeFunctionData('list', [BigInt(opts.slot), BigInt(opts.version), BigInt(opts.price)]);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: contractAddress, data, gasLimit: 250_000n });
    let ticket = null;
    if (opts.json && receipt.status === '0x1') {
      const provider = makeProvider(rpcUrl);
      const c = new ethers.Contract(contractAddress, artifact.abi, provider);
      ticket = await readTicketState(c, Number(opts.slot));
    }
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null, ...(ticket ? { ticket } : {}) }, null, 2));
    return;
  }

  if (cmd === 'buy') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    const data = iface.encodeFunctionData('buy', [BigInt(opts.slot), BigInt(opts.version), BigInt(opts.price)]);
    const { txHash, receipt } = await sendSignedTx({
      rpc,
      wallet,
      to: contractAddress,
      data,
      value: BigInt(opts.price),
      gasLimit: 300_000n,
    });
    let ticket = null;
    if (opts.json && receipt.status === '0x1') {
      const provider = makeProvider(rpcUrl);
      const c = new ethers.Contract(contractAddress, artifact.abi, provider);
      ticket = await readTicketState(c, Number(opts.slot));
    }
    console.log(JSON.stringify({ txHash, status: receipt.status, blockNumber: Number(BigInt(receipt.blockNumber)), reason: receipt.revertReason || null, ...(ticket ? { ticket } : {}) }, null, 2));
    return;
  }

  if (cmd === 'sign-gate') {
    const owner = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    const editionId = resolveEditionId(opts);
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const slotNum = Number(opts.slot);
    if (!Number.isInteger(slotNum) || slotNum <= 0) {
      throw new Error(`Invalid slot: ${opts.slot}`);
    }
    let versionNum = (typeof opts.version === 'string' && opts.version.trim() !== '') ? Number(opts.version) : null;
    if (!Number.isInteger(versionNum) || versionNum <= 0) {
      const provider = makeProvider(rpcUrl, chainId);
      const c = new ethers.Contract(contractAddress, artifact.abi, provider);
      const [, v] = await c.getTicket(BigInt(slotNum));
      versionNum = Number(v);
      if (versionNum <= 0) {
        throw new Error(`Ticket slot ${slotNum} has not been claimed yet.`);
      }
    }
    let expiryNum = (typeof opts.expiry === 'string' && opts.expiry.trim() !== '') ? Number(opts.expiry) : null;
    if (!Number.isInteger(expiryNum) || expiryNum <= 0) {
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      expiryNum = Number(BigInt(block.timestamp)) + 90;
    }
    const sig = await signGateCredential(
      owner,
      chainId,
      contractAddress,
      editionId,
      BigInt(slotNum),
      BigInt(versionNum),
      BigInt(expiryNum)
    );
    if (opts.json) {
      const credential = {
        contract: contractAddress,
        editionId,
        slot: slotNum,
        version: versionNum,
        expiry: expiryNum,
        ownerSig: sig,
      };
      console.log(JSON.stringify({
        ok: true,
        txStatus: 'confirmed',
        txHash: null,
        error: null,
        ...credential,
        credential,
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({ slot: String(slotNum), version: String(versionNum), expiry: String(expiryNum), ownerSig: sig }, null, 2));
    return;
  }

  if (cmd === 'redeem') {
    const gate = new ethers.Wallet(resolveRoleKey(opts, 'gate'));
    const contractAddress = resolveContract(opts);
    const ownerSigRaw = (typeof opts.sig === 'string' && opts.sig.trim())
      ? opts.sig.trim()
      : (typeof opts['owner-sig'] === 'string' && opts['owner-sig'].trim())
        ? opts['owner-sig'].trim()
        : '';
    if (!ownerSigRaw || !/^0x(?:[0-9a-fA-F]{2})+$/.test(ownerSigRaw)) {
      throw new Error('Invalid owner signature format');
    }
    const scanId = normalizeScanId(typeof opts['scan-id'] === 'string' ? opts['scan-id'] : null);
    const data = iface.encodeFunctionData('redeem', [
      BigInt(opts.slot),
      BigInt(opts.version),
      BigInt(opts.expiry),
      ownerSigRaw,
      scanId,
    ]);
    const claim = claimGateScanAtomic(scanId, {
      status: 'CLAIMED',
      acted: false,
      contract: contractAddress,
      slot: String(opts.slot),
      version: String(opts.version),
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    });
    if (!claim.claimed) {
      const dupMsg = `Scan ID ${scanId} already claimed or acted on.`;
      if (opts.json) {
        console.log(JSON.stringify({
          ok: false,
          txStatus: 'rejected',
          txHash: null,
          scanId,
          decision: 'REJECT',
          gateDecision: 'REJECT',
          errorCode: 'ALREADY_ADMITTED',
          error: dupMsg,
          reason: dupMsg,
        }, null, 2));
        return;
      }
      throw new Error(dupMsg);
    }

    let txHash, receipt;
    try {
      ({ txHash, receipt } = await sendSignedTx({
        rpc,
        wallet: gate,
        to: contractAddress,
        data,
        gasLimit: 250_000n,
        opId: scanId,
        meta: {
          kind: 'gate-redeem',
          contract: contractAddress,
          scanId,
          slot: String(opts.slot),
          version: String(opts.version),
        },
        beforeBroadcast: () => {
          if (existsSync(getGateFinalPath(scanId))) {
            throw new Error(`Scan ID ${scanId} was already finalized before broadcast.`);
          }
        },
      }));
    } catch (err) {
      if (opts.json) {
        const msg = err?.message || String(err);
        const recoverable = isRpcRecoverableError(err);
        const code = recoverable ? 'RPC_TIMEOUT' : classifyErrorCode(msg, 'redeem');
        console.log(JSON.stringify({
          ok: false,
          txStatus: recoverable ? 'unknown_recovering' : 'rejected',
          txHash: err?.txHash || null,
          scanId,
          decision: null,
          gateDecision: null,
          errorCode: code,
          error: msg,
          reason: msg,
          ticket: null,
        }, null, 2));
        return;
      }
      throw err;
    }

    const provider = makeProvider(rpcUrl);
    const c = new ethers.Contract(contractAddress, artifact.abi, provider);

    if (receipt.status !== '0x1') {
      const reason = receipt.revertReason || 'Gate redeem rejected on-chain.';
      const errorCode = classifyErrorCode(reason, 'redeem');
      const fin = tryFinalizeGateDecision(scanId, {
        decision: 'REJECT',
        status: 'REJECTED',
        txHash,
        slot: String(opts.slot),
        version: String(opts.version),
        reason,
        errorCode,
      });
      if (!fin.wonFinalization) {
        const finMsg = `Scan ID ${scanId} was already finalized.`;
        console.log(JSON.stringify({
          ok: false,
          txStatus: 'rejected',
          txHash,
          scanId,
          decision: 'ALREADY_FINALIZED',
          gateDecision: 'ALREADY_FINALIZED',
          prior: fin.existing,
          errorCode: 'ALREADY_ADMITTED',
          error: finMsg,
          reason: finMsg,
        }, null, 2));
        return;
      }
      if (opts.json) {
        let ticket = null;
        try { ticket = await readTicketState(c, Number(opts.slot)); } catch {}
        console.log(JSON.stringify({
          ok: false,
          txStatus: 'rejected',
          txHash,
          scanId,
          blockNumber: Number(BigInt(receipt.blockNumber)),
          decision: 'REJECT',
          gateDecision: 'REJECT',
          errorCode,
          error: reason,
          reason,
          ticket,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify({ decision: 'REJECT', txHash, status: receipt.status, reason: receipt.revertReason || null, scanId }, null, 2));
      return;
    }

    const admittedEvent = parseAdmittedEvent(iface, contractAddress, receipt, scanId, opts.slot, opts.version);
    if (!admittedEvent) {
      const holdMsg = 'Missing or mismatched Admitted log';
      const fin = tryFinalizeGateDecision(scanId, {
        decision: 'HOLD_FOR_STAFF',
        status: 'HOLD_FOR_STAFF',
        txHash,
        slot: String(opts.slot),
        version: String(opts.version),
        reason: holdMsg,
      });
      if (!fin.wonFinalization) {
        const finMsg = `Scan ID ${scanId} was already finalized.`;
        console.log(JSON.stringify({
          ok: false,
          txStatus: 'rejected',
          txHash,
          scanId,
          decision: 'ALREADY_FINALIZED',
          gateDecision: 'ALREADY_FINALIZED',
          prior: fin.existing,
          errorCode: 'ALREADY_ADMITTED',
          error: finMsg,
          reason: finMsg,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        ok: false,
        txStatus: 'unknown_recovering',
        decision: 'HOLD_FOR_STAFF',
        gateDecision: 'HOLD_FOR_STAFF',
        errorCode: 'INTERNAL_ERROR',
        error: 'Receipt confirmation did not include the expected admission event. Hold for staff review.',
        reason: holdMsg,
        txHash,
        scanId,
      }, null, 2));
      return;
    }

    const fin = tryFinalizeGateDecision(scanId, {
      decision: 'ADMIT',
      status: 'ADMITTED',
      txHash,
      slot: String(opts.slot),
      version: String(opts.version),
    });
    if (!fin.wonFinalization) {
      const finMsg = `Scan ID ${scanId} was already finalized.`;
      console.log(JSON.stringify({
        ok: false,
        txStatus: 'rejected',
        txHash,
        scanId,
        decision: 'ALREADY_FINALIZED',
        gateDecision: 'ALREADY_FINALIZED',
        prior: fin.existing,
        errorCode: 'ALREADY_ADMITTED',
        error: finMsg,
        reason: finMsg,
      }, null, 2));
      return;
    }
    if (opts.json) {
      let ticket = null;
      try { ticket = await readTicketState(c, Number(opts.slot)); } catch {}
      console.log(JSON.stringify({
        ok: true,
        txStatus: 'confirmed',
        txHash,
        scanId,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        decision: 'ADMIT',
        gateDecision: 'ADMIT',
        errorCode: null,
        error: null,
        ticket,
      }, null, 2));
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
    const targetScanId = (typeof opts['scan-id'] === 'string' && opts['scan-id'].trim())
      ? normalizeScanId(opts['scan-id'])
      : null;
    const targetOpId = (typeof opts['op-id'] === 'string' && opts['op-id'].trim())
      ? opts['op-id'].trim()
      : targetScanId;
    const targetTxHash = (typeof opts['tx-hash'] === 'string' && opts['tx-hash'].trim())
      ? opts['tx-hash'].trim().toLowerCase()
      : null;
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
            if (err && typeof err === 'object') err.txHash = entry.txHash;
            throw err;
          }
        }
        try {
          receipt = await waitForReceipt(rpc, entry.txHash);
        } catch (err) {
          if (err && typeof err === 'object') err.txHash = entry.txHash;
          throw err;
        }
      }

      let revertReason = entry.revertReason || null;
      if (receipt.status !== '0x1' && !revertReason) {
        try {
          const parsedTx = ethers.Transaction.from(entry.signedBytes);
          await rpc('eth_call', [{
            from: address,
            to: entry.to || receipt.contractAddress || undefined,
            data: parsedTx.data,
            value: ethers.toQuantity(parsedTx.value || 0n),
          }, receipt.blockNumber || 'latest']);
        } catch (err) {
          revertReason = extractRevertReason(err);
        }
      }

      const finalStatus = receipt.status === '0x1' ? 'CONFIRMED' : 'REVERTED';
      if (entry.status === 'PENDING') {
        await updateJournalEntry(address, entry.txHash, {
          status: finalStatus,
          blockNumber: Number(BigInt(receipt.blockNumber)),
          gasUsed: Number(BigInt(receipt.gasUsed)),
          revertReason,
          resumedAt: new Date().toISOString(),
        });
      }

      let gateDecision = null;
      let wonFinalization = null;
      let errorCode = null;
      if (entry.meta?.kind === 'gate-redeem') {
        const { scanId, contract: contractAddr, slot, version } = entry.meta;
        if (receipt.status !== '0x1') {
          const reasonText = revertReason || 'Gate redeem rejected on-chain.';
          errorCode = classifyErrorCode(reasonText, 'redeem');
          const fin = tryFinalizeGateDecision(scanId, {
            decision: 'REJECT',
            status: 'REJECTED',
            txHash: entry.txHash,
            slot,
            version,
            reason: reasonText,
            errorCode,
            resumed: true,
          });
          wonFinalization = fin.wonFinalization;
          gateDecision = fin.wonFinalization ? 'REJECT' : 'ALREADY_FINALIZED';
        } else {
          const admittedEvent = parseAdmittedEvent(iface, contractAddr, receipt, scanId, slot, version);
          if (admittedEvent) {
            const fin = tryFinalizeGateDecision(scanId, {
              decision: 'ADMIT',
              status: 'ADMITTED',
              txHash: entry.txHash,
              slot,
              version,
              resumed: true,
            });
            wonFinalization = fin.wonFinalization;
            gateDecision = fin.wonFinalization ? 'ADMIT' : 'ALREADY_FINALIZED';
          } else {
            const fin = tryFinalizeGateDecision(scanId, {
              decision: 'HOLD_FOR_STAFF',
              status: 'HOLD_FOR_STAFF',
              txHash: entry.txHash,
              slot,
              version,
              reason: 'Missing or mismatched Admitted log',
              resumed: true,
            });
            wonFinalization = fin.wonFinalization;
            gateDecision = fin.wonFinalization ? 'HOLD_FOR_STAFF' : 'ALREADY_FINALIZED';
            errorCode = 'INTERNAL_ERROR';
          }
        }
      } else if (finalStatus === 'REVERTED') {
        errorCode = classifyErrorCode(revertReason, 'resume');
      }

      resumed.push({
        opId: entry.opId,
        txHash: entry.txHash,
        status: finalStatus,
        gateDecision,
        wonFinalization,
        ...(revertReason ? { reason: revertReason } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }

    // Handle interrupted pre-journal gate claim (claimed <scanId>.json, crashed before journal write).
    // Re-read the journal inside withWalletLock so a worker that wrote & exited after our initial
    // snapshot cannot be misclassified as ABORTED_BEFORE_SEND.
    if (targetScanId) {
      const scanId = targetScanId;
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
            const abortReason = 'Gate worker aborted before broadcasting transaction.';
            const fin = tryFinalizeGateDecision(scanId, {
              decision: 'ABORTED_BEFORE_SEND',
              status: 'ABORTED_BEFORE_SEND',
              reason: abortReason,
              resumed: true,
            });
            resumed.push({
              opId: scanId,
              txHash: null,
              status: 'NO_TX',
              gateDecision: fin.wonFinalization ? 'ABORTED_BEFORE_SEND' : 'ALREADY_FINALIZED',
              wonFinalization: fin.wonFinalization,
              reason: abortReason,
            });
          }
        }
      });
    }

    let txStatus = 'confirmed';
    let topTxHash = resumed.find((x) => x.txHash)?.txHash || null;
    let topGateDecision = resumed.find((x) => x.gateDecision)?.gateDecision || null;
    let topErrorCode = null;
    let topError = null;
    let extra = {};

    if (resumed.length > 0) {
      if (resumed.some((x) => x.status === 'ACTIVE_WORKER')) {
        txStatus = 'pending';
        topError = 'Transaction submission is still in progress.';
      } else if (resumed.some((x) => x.gateDecision === 'HOLD_FOR_STAFF')) {
        txStatus = 'unknown_recovering';
        topErrorCode = 'INTERNAL_ERROR';
        topError = 'Receipt confirmation did not include the expected admission event. Hold for staff review.';
      } else if (resumed.some((x) => x.status === 'REVERTED' || x.gateDecision === 'REJECT' || x.gateDecision === 'ABORTED_BEFORE_SEND')) {
        txStatus = 'rejected';
        const bad = resumed.find((x) => x.status === 'REVERTED' || x.gateDecision === 'REJECT' || x.gateDecision === 'ABORTED_BEFORE_SEND');
        topError = bad?.reason || 'Recovered transaction reverted on-chain.';
        topErrorCode = bad?.errorCode || classifyErrorCode(topError, topGateDecision ? 'redeem' : 'resume');
      }
    } else if (targetScanId && existsSync(getGateFinalPath(targetScanId))) {
      const prior = JSON.parse(readFileSync(getGateFinalPath(targetScanId), 'utf8'));
      topTxHash = prior.txHash || null;
      topGateDecision = prior.decision || null;
      extra = { alreadyFinalized: true, prior };
      if (prior.decision === 'ADMIT') {
        txStatus = 'confirmed';
      } else if (prior.decision === 'HOLD_FOR_STAFF') {
        txStatus = 'unknown_recovering';
        topErrorCode = 'INTERNAL_ERROR';
        topError = prior.reason || 'Receipt confirmation did not include the expected admission event. Hold for staff review.';
      } else {
        txStatus = 'rejected';
        topError = prior.reason || `Scan was previously finalized as ${prior.decision}.`;
        topErrorCode = prior.errorCode || classifyErrorCode(topError, 'redeem');
      }
    } else if (targetOpId || targetTxHash) {
      const matched = entries.find((e) =>
        (targetTxHash && String(e.txHash).toLowerCase() === targetTxHash) ||
        (targetOpId && e.opId === targetOpId)
      );
      if (matched) {
        topTxHash = matched.txHash || null;
        if (matched.status === 'PENDING') {
          txStatus = 'pending';
        } else if (matched.status === 'REVERTED') {
          txStatus = 'rejected';
          topError = matched.revertReason || 'Previously journaled transaction reverted on-chain.';
          topErrorCode = classifyErrorCode(topError, matched.meta?.kind === 'gate-redeem' ? 'redeem' : 'resume');
        } else {
          txStatus = 'confirmed';
        }
      }
    }

    const ok = txStatus === 'confirmed';
    console.log(JSON.stringify({
      ok,
      txStatus,
      txHash: topTxHash,
      ...(targetScanId ? { scanId: targetScanId } : {}),
      ...(topGateDecision ? { gateDecision: topGateDecision } : {}),
      errorCode: ok ? null : topErrorCode,
      error: ok ? null : topError,
      ...(topError && !ok ? { reason: topError } : {}),
      address,
      resumedCount: resumed.length,
      resumed,
      ...extra,
    }, null, 2));
    return;
  }

  if (cmd === 'withdraw') {
    const wallet = new ethers.Wallet(resolveRoleKey(opts));
    const contractAddress = resolveContract(opts);
    const data = iface.encodeFunctionData('withdraw', []);
    const { txHash, receipt } = await sendSignedTx({ rpc, wallet, to: contractAddress, data, gasLimit: 200_000n });
    console.log(JSON.stringify({
      txHash,
      status: receipt.status,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      reason: receipt.revertReason || null,
    }, null, 2));
    return;
  }

  if (cmd === 'ticket') {
    const contractAddress = resolveContract(opts);
    const provider = makeProvider(rpcUrl);
    const c = new ethers.Contract(contractAddress, artifact.abi, provider);
    const [owner, version, paidPrice, admitted] = await c.getTicket(BigInt(opts.slot));
    console.log(JSON.stringify({ slot: opts.slot, owner, version: Number(version), paidPrice: paidPrice.toString(), admitted }, null, 2));
    return;
  }

  if (cmd === 'advance-time') {
    await rpc('evm_increaseTime', [Number(opts.seconds || 61)]);
    await rpc('evm_mine');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    console.log(JSON.stringify({
      ...(opts.json ? { ok: true, txStatus: 'confirmed' } : {}),
      blockNumber: Number(BigInt(block.number)),
      timestamp: Number(BigInt(block.timestamp)),
    }, null, 2));
    return;
  }

  if (cmd === 'mine') {
    const count = Number(opts.blocks || 1);
    for (let i = 0; i < count; i++) {
      await rpc('evm_mine');
    }
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    console.log(JSON.stringify({
      ...(opts.json ? { ok: true, txStatus: 'confirmed' } : {}),
      blockNumber: Number(BigInt(block.number)),
      timestamp: Number(BigInt(block.timestamp)),
    }, null, 2));
    return;
  }

  if (cmd === 'alerts') {
    const records = [];
    if (existsSync(activityLogPath)) {
      for (const line of readFileSync(activityLogPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {}
      }
    }
    const alerts = [];
    const entriesBySubject = new Map();
    const subjectLabels = new Map();
    const failedByScan = new Map();
    for (const row of records) {
      if (row.action === 'enter' && row.subject) {
        entriesBySubject.set(row.subject, (entriesBySubject.get(row.subject) || 0) + 1);
        if (row.subjectLabel) subjectLabels.set(row.subject, row.subjectLabel);
      }
      if (row.action === 'redeem' && row.scanId && !row.success) {
        failedByScan.set(row.scanId, (failedByScan.get(row.scanId) || 0) + 1);
      }
    }
    const timestamp = new Date().toISOString();
    for (const [subjectOrSlot, count] of entriesBySubject) {
      if (count >= 3) {
        const subjectLabel = subjectLabels.get(subjectOrSlot) || null;
        alerts.push({
          id: `entry-${subjectOrSlot}`,
          severity: 'review',
          rule: 'REPEATED_ENTRY_SUBJECT',
          grouping: 'subject',
          count,
          reason: 'The same demo subject has made repeated entry requests.',
          subjectOrSlot,
          ...(subjectLabel ? { subjectLabel } : {}),
          timestamp,
          note: 'Review signal only; does not auto-block',
        });
      }
    }
    for (const [subjectOrSlot, count] of failedByScan) {
      if (count >= 2) {
        alerts.push({
          id: `scan-${subjectOrSlot}`,
          severity: 'review',
          rule: 'REPEATED_FAILED_SCAN',
          grouping: 'scanId',
          count,
          reason: 'A scan ID has repeated failed admission attempts.',
          subjectOrSlot,
          timestamp,
          note: 'Review signal only; does not auto-block',
        });
      }
    }
    const now = Date.now();
    const recent = records.filter((row) => now - Date.parse(row.timestamp) <= 10_000);
    if (recent.length >= 5) {
      alerts.push({
        id: `burst-${Math.floor(now / 10000)}`,
        severity: 'review',
        rule: 'REQUEST_BURST',
        grouping: 'event',
        windowSeconds: 10,
        count: recent.length,
        reason: 'Five or more requests were recorded within ten seconds.',
        subjectOrSlot: 'event',
        timestamp,
        note: 'Review signal only; does not auto-block',
      });
    }
    console.log(JSON.stringify({ ok: true, alerts, activityCount: records.length }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

module.exports = { withWalletLock, getWalletLockEndpoint };

if (require.main === module) {
  main().catch((err) => {
    const parsed = parseArgs(process.argv.slice(2));
    try {
      if (['enter', 'lock-draw', 'draw', 'claim', 'list', 'buy', 'redeem', 'withdraw', 'resume', 'advance-time'].includes(parsed.cmd)) {
        const rawScanIdOpt = typeof parsed.opts['scan-id'] === 'string' && parsed.opts['scan-id'].trim() ? normalizeScanId(parsed.opts['scan-id']) : null;
        logActivity({
          action: parsed.cmd,
          role: parsed.opts.role || null,
          subject: parsed.cmd === 'enter' ? activitySubject(parsed.opts) : null,
          subjectLabel: parsed.cmd === 'enter' ? activitySubjectLabel(parsed.opts) : null,
          scanId: rawScanIdOpt,
          success: false,
          txHash: err?.txHash || null,
          error: err.message || String(err),
        });
      }
    } catch {}
    if (parsed.opts.json) {
      const message = err?.message || String(err);
      const recoverable = isRpcRecoverableError(err);
      console.log(JSON.stringify({
        ok: false,
        txStatus: recoverable ? 'unknown_recovering' : 'rejected',
        txHash: err?.txHash || null,
        errorCode: recoverable ? 'RPC_TIMEOUT' : classifyErrorCode(message, parsed.cmd),
        error: message,
        reason: message,
      }, null, 2));
    } else console.error(err.message || err);
    process.exit(1);
  });
}
