const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { ethers } = require('./toolchain.cjs');
const { startAnvil } = require('./anvil.cjs');

const execFileAsync = promisify(execFile);

const root = resolve(__dirname, '..');
const cliPath = join(__dirname, 'cli.cjs');
const demoStatePath = join(root, 'artifacts', 'demo-state.json');
const demoFixturePath = join(root, 'artifacts', 'demo-fixture.json');
const activityLogPath = join(root, 'artifacts', 'activity-log.ndjson');
const gateClaimsDir = join(root, 'artifacts', 'gate-claims');

let checksPassed = 0;

function check(cond, msg) {
  assert(cond, msg);
  checksPassed++;
}

function runCli(args) {
  const out = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function runCliAllowFail(args) {
  try {
    const out = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, data: JSON.parse(out) };
  } catch (err) {
    const stdout = String(err?.stdout || '').trim();
    const stderr = String(err?.stderr || '').trim();
    let data = null;
    try {
      data = stdout ? JSON.parse(stdout) : null;
    } catch {
      throw new Error(`CLI failed with non-JSON output (exit ${err.status}): stdout=${stdout} stderr=${stderr}`);
    }
    return { exitCode: err.status ?? 1, data };
  }
}

async function runCliAsyncAllowFail(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    return { exitCode: 0, data: JSON.parse(stdout) };
  } catch (err) {
    const stdout = String(err?.stdout || '').trim();
    const stderr = String(err?.stderr || '').trim();
    try {
      return { exitCode: err.code ?? 1, data: JSON.parse(stdout) };
    } catch {
      throw new Error(`Async CLI failed with non-JSON output: stdout=${stdout} stderr=${stderr}`);
    }
  }
}

async function main() {
  if (existsSync(demoStatePath)) unlinkSync(demoStatePath);
  if (existsSync(demoFixturePath)) unlinkSync(demoFixturePath);
  if (existsSync(activityLogPath)) unlinkSync(activityLogPath);

  const port = 8556;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil({
    port,
    chainId: 31337,
    accounts: 10,
    mnemonic: 'test test test test test test test test test test test junk',
  });

  try {
    // -----------------------------------------------------------------------
    // 1. L2-D1-1: Pre-init failure, loopback guard, duplicate init guard, read-only status
    // -----------------------------------------------------------------------
    const preInitStatus = runCliAllowFail(['status', '--rpc', rpcUrl, '--json']);
    check(preInitStatus.data?.ok === false && preInitStatus.data?.txStatus === 'rejected', 'status before init-demo must reject');
    check(String(preInitStatus.data?.error || '').includes('init-demo'), 'pre-init error must mention init-demo');

    const badHostInit = runCliAllowFail(['init-demo', '--rpc', 'http://example.com:8545', '--json']);
    check(badHostInit.data?.ok === false && badHostInit.data?.txStatus === 'rejected', 'non-loopback init-demo must reject');
    check(String(badHostInit.data?.error || '').toLowerCase().includes('loopback'), 'non-loopback error must mention loopback');

    const init1 = runCli(['init-demo', '--capacity', '1', '--rpc', rpcUrl]);
    check(init1.ok === true && init1.capacity === 1, 'init-demo must deploy with capacity 1');
    check(existsSync(demoStatePath) && existsSync(demoFixturePath), 'demo state and fixture files must exist');
    const firstContract = init1.contract;

    const stateBefore = readFileSync(demoStatePath, 'utf8');
    const fixtureBefore = readFileSync(demoFixturePath, 'utf8');
    const parsedFixture = JSON.parse(fixtureBefore);
    const roleAddrs = ['organiser', 'gate', 'attester', 'fanA', 'fanB'].map((r) => parsedFixture.roles[r]?.address?.toLowerCase());
    check(roleAddrs.every(Boolean) && new Set(roleAddrs).size === 5, 'all 5 demo roles must have distinct addresses');

    // Duplicate init-demo must be refused without mutating existing state
    const dupInit = runCliAllowFail(['init-demo', '--rpc', rpcUrl, '--json']);
    check(dupInit.data?.ok === false && dupInit.data?.txStatus === 'rejected', 'second init-demo must reject');
    check(String(dupInit.data?.error || '').includes('reset-demo'), 'duplicate init-demo error must direct to reset-demo');
    check(readFileSync(demoStatePath, 'utf8') === stateBefore, 'duplicate init-demo must not mutate demo-state.json');
    check(readFileSync(demoFixturePath, 'utf8') === fixtureBefore, 'duplicate init-demo must not mutate demo-fixture.json');

    // status --json works across fresh process with no flags and is strictly read-only
    const blockBeforeStatus = await anvil.rpc('eth_blockNumber');
    const actBeforeStatus = existsSync(activityLogPath) ? readFileSync(activityLogPath, 'utf8') : null;
    const status1 = runCli(['status', '--json']);
    check(status1.ok === true && status1.chainId === 31337, 'status must load demo-state without explicit --rpc/--contract');
    check(status1.phase === 'ENTRY' && status1.capacity === 1, 'initial phase must be ENTRY with capacity 1');
    check(Object.keys(status1.roles || {}).length === 5, 'status must expose all 5 role views');
    if (existsSync(join(root, 'artifacts', 'volume-summary.json'))) {
      check(status1.volumeEvidence?.totalWrites === 100000, 'status must report 100k volumeEvidence');
    }
    check(readFileSync(demoStatePath, 'utf8') === stateBefore, 'status must not modify demo-state.json');
    check(readFileSync(demoFixturePath, 'utf8') === fixtureBefore, 'status must not modify demo-fixture.json');
    check((await anvil.rpc('eth_blockNumber')) === blockBeforeStatus, 'status must not advance blocks or write chain state');
    check((existsSync(activityLogPath) ? readFileSync(activityLogPath, 'utf8') : null) === actBeforeStatus, 'status must not log activity writes');

    // -----------------------------------------------------------------------
    // 2. Entry, Lock-Draw, and Draw phase/role checks
    // -----------------------------------------------------------------------
    const enterA = runCli(['enter', '--role', 'fanA', '--subject', 'fan-a-loop2', '--json']);
    check(enterA.ok === true && enterA.txStatus === 'confirmed' && enterA.txHash && Number.isInteger(enterA.blockNumber), 'fanA entry must confirm');

    const dupSubj = runCliAllowFail(['enter', '--role', 'fanB', '--subject', 'fan-a-loop2', '--json']);
    check(dupSubj.data?.ok === false && dupSubj.data?.txStatus === 'rejected', 'duplicate subject must reject');
    check(String(dupSubj.data?.error || '').includes('Subject already entered'), 'duplicate subject error must report contract reason');

    const dupWallet = runCliAllowFail(['enter', '--role', 'fanA', '--subject', 'fan-a-dup', '--json']);
    check(dupWallet.data?.ok === false && dupWallet.data?.txStatus === 'rejected', 'duplicate wallet must reject');
    check(String(dupWallet.data?.error || '').includes('Wallet already entered'), 'duplicate wallet error must report contract reason');

    const enterB = runCli(['enter', '--role', 'fanB', '--subject', 'fan-b-loop2', '--json']);
    check(enterB.ok === true && enterB.txStatus === 'confirmed', 'fanB entry must confirm');

    const earlyLock = runCliAllowFail(['lock-draw', '--role', 'organiser', '--json']);
    check(earlyLock.data?.txStatus === 'rejected' && earlyLock.data?.errorCode === 'WRONG_PHASE', 'early lockDraw must reject as WRONG_PHASE');
    check(String(earlyLock.data?.error || '').includes('Entry still open'), 'early lockDraw must surface contract reason');

    const unlockedDraw = runCliAllowFail(['draw', '--role', 'organiser', '--json']);
    check(unlockedDraw.data?.txStatus === 'rejected' && unlockedDraw.data?.errorCode === 'WRONG_PHASE', 'draw before lock must reject as WRONG_PHASE');
    check(String(unlockedDraw.data?.error || '').includes('Draw not locked'), 'draw before lock must surface contract reason');

    const adv1 = runCli(['advance-time', '--seconds', '125', '--json']);
    check(adv1.ok === true && adv1.txStatus === 'confirmed', 'advance-time past entryDeadline must confirm');

    const lateEnter = runCliAllowFail(['enter', '--role', 'gate', '--subject', 'late-fan', '--json']);
    check(lateEnter.data?.txStatus === 'rejected' && lateEnter.data?.errorCode === 'WRONG_PHASE', 'late entry must reject as WRONG_PHASE');
    check(String(lateEnter.data?.error || '').includes('Entry closed'), 'late entry must surface Entry closed');

    const lockRes = runCli(['lock-draw', '--role', 'organiser', '--json']);
    check(lockRes.ok === true && lockRes.txStatus === 'confirmed', 'lock-draw after entry deadline must confirm');

    const earlyDraw = runCliAllowFail(['draw', '--role', 'organiser', '--json']);
    check(earlyDraw.data?.txStatus === 'rejected' && earlyDraw.data?.errorCode === 'WRONG_PHASE', 'draw before target block must reject as WRONG_PHASE');
    check(String(earlyDraw.data?.error || '').includes('Target block not reached'), 'early draw must surface Target block not reached');

    const mined = runCli(['mine', '--blocks', '2', '--json']);
    check(mined.ok === true && mined.txStatus === 'confirmed', 'mine --blocks 2 must confirm');

    const drawRes = runCli(['draw', '--role', 'organiser', '--json']);
    check(drawRes.ok === true && drawRes.txStatus === 'confirmed', 'draw after target block must confirm');

    const afterDraw = runCli(['status', '--json']);
    check(afterDraw.drawn === true && afterDraw.phase === 'CLAIM' && afterDraw.winnersCount === 1, 'status must reflect CLAIM phase and 1 winner');

    const winnerAddr = afterDraw.winners[0].toLowerCase();
    const fanAAddr = afterDraw.roles.fanA.address.toLowerCase();
    const winnerRole = winnerAddr === fanAAddr ? 'fanA' : 'fanB';
    const loserRole = winnerRole === 'fanA' ? 'fanB' : 'fanA';

    // -----------------------------------------------------------------------
    // 3. Claim phase checks & pre-resale credential signing
    // -----------------------------------------------------------------------
    const nonWinnerClaim = runCliAllowFail(['claim', '--role', loserRole, '--json']);
    check(nonWinnerClaim.data?.txStatus === 'rejected' && nonWinnerClaim.data?.errorCode === 'NOT_WINNER', 'non-winner claim must return NOT_WINNER');

    const badPayClaim = runCliAllowFail(['claim', '--role', winnerRole, '--value', '1', '--json']);
    check(badPayClaim.data?.txStatus === 'rejected' && badPayClaim.data?.errorCode === 'INSUFFICIENT_PAYMENT', 'underpaid claim must return INSUFFICIENT_PAYMENT');

    const claimRes = runCli(['claim', '--role', winnerRole, '--json']);
    check(claimRes.ok === true && claimRes.txStatus === 'confirmed', 'winner claim must confirm');
    check(claimRes.ticket?.slot === 1 && claimRes.ticket?.version === 1, 'claimed ticket must be slot 1 version 1');

    const dupClaim = runCliAllowFail(['claim', '--role', winnerRole, '--json']);
    check(dupClaim.data?.txStatus === 'rejected' && dupClaim.data?.errorCode === 'ALREADY_CLAIMED', 'duplicate claim must return ALREADY_CLAIMED');

    const earlyList = runCliAllowFail(['list', '--role', winnerRole, '--slot', '1', '--version', '1', '--price', afterDraw.facePriceWei, '--json']);
    check(earlyList.data?.txStatus === 'rejected' && earlyList.data?.errorCode === 'WRONG_PHASE', 'list during CLAIM must return WRONG_PHASE');

    // Verify omitted --version '' + default expiry works AND sign a long-lived stale v1 credential for GATE test
    const defaultCredV1 = runCli(['sign-gate', '--role', winnerRole, '--slot', '1', '--version', '', '--json', '--json']);
    check(defaultCredV1.ok === true && defaultCredV1.ownerSig && defaultCredV1.credential?.version === 1, 'sign-gate with empty --version must default to on-chain v1');

    const gateValidExpiry = String(afterDraw.resaleCutoff + 80);
    const staleCredV1 = runCli(['sign-gate', '--role', winnerRole, '--slot', '1', '--version', '', '--expiry', gateValidExpiry, '--json', '--json']);
    check(staleCredV1.ok === true && staleCredV1.credential?.version === 1, 'seller pre-resale v1 credential signed cleanly');

    // -----------------------------------------------------------------------
    // 4. L2-D1-3 (#1): Resale cap & ownership enforcement
    // -----------------------------------------------------------------------
    runCli(['advance-time', '--seconds', '305', '--json']);
    const resaleStatus = runCli(['status', '--json']);
    check(resaleStatus.phase === 'RESALE', 'phase must advance to RESALE');

    const aboveCapPrice = (BigInt(afterDraw.facePriceWei) + 1n).toString();
    const aboveCapList = runCliAllowFail(['list', '--role', winnerRole, '--slot', '1', '--version', '1', '--price', aboveCapPrice, '--json']);
    check(aboveCapList.data?.ok === false && aboveCapList.data?.txStatus === 'rejected', 'above-cap list must reject');
    check(aboveCapList.data?.errorCode === 'RESALE_CAP_EXCEEDED', 'above-cap list must classify as RESALE_CAP_EXCEEDED');
    check(String(aboveCapList.data?.error || '').includes('Price exceeds cap'), 'above-cap list must report Price exceeds cap');
    check(typeof aboveCapList.data?.txHash === 'string' && aboveCapList.data.txHash.startsWith('0x'), 'reverted list must include txHash');

    const nonOwnerList = runCliAllowFail(['list', '--role', loserRole, '--slot', '1', '--version', '1', '--price', afterDraw.facePriceWei, '--json']);
    check(nonOwnerList.data?.txStatus === 'rejected' && String(nonOwnerList.data?.error || '').includes('Not ticket owner'), 'non-owner list must reject');

    const noListingBuy = runCliAllowFail(['buy', '--role', loserRole, '--slot', '1', '--version', '1', '--price', afterDraw.facePriceWei, '--json']);
    check(noListingBuy.data?.txStatus === 'rejected' && noListingBuy.data?.errorCode === 'LISTING_NOT_ACTIVE', 'buy without listing must return LISTING_NOT_ACTIVE');

    const resalePrice = (BigInt(afterDraw.facePriceWei) - 1_000_000n).toString();
    const validList = runCli(['list', '--role', winnerRole, '--slot', '1', '--version', '1', '--price', resalePrice, '--json']);
    check(validList.ok === true && validList.txStatus === 'confirmed', 'capped list must confirm');
    check(validList.ticket?.listed === true && validList.ticket?.resalePriceWei === resalePrice, 'ticket must reflect active listing and price');

    const badPriceBuy = runCliAllowFail(['buy', '--role', loserRole, '--slot', '1', '--version', '1', '--price', (BigInt(resalePrice) - 1n).toString(), '--json']);
    check(badPriceBuy.data?.txStatus === 'rejected' && badPriceBuy.data?.errorCode === 'INSUFFICIENT_PAYMENT', 'mismatched price buy must return INSUFFICIENT_PAYMENT');

    const selfBuy = runCliAllowFail(['buy', '--role', winnerRole, '--slot', '1', '--version', '1', '--price', resalePrice, '--json']);
    check(selfBuy.data?.txStatus === 'rejected', 'seller buying own listing must reject');

    const buyRes = runCli(['buy', '--role', loserRole, '--slot', '1', '--version', '1', '--price', resalePrice, '--json']);
    check(buyRes.ok === true && buyRes.txStatus === 'confirmed', 'valid buy must confirm');
    check(buyRes.ticket?.version === 2, 'buy must increment version to 2');
    check(buyRes.ticket?.owner?.toLowerCase() === afterDraw.roles[loserRole].address.toLowerCase(), 'buy must transfer ownership to buyer');
    check(buyRes.ticket?.paidPriceWei === resalePrice && buyRes.ticket?.listed === false, 'buy must update paidPriceWei and clear listing');

    // Paid price becomes the new tighter resale cap for secondary listings
    const secondaryOverCap = runCliAllowFail(['list', '--role', loserRole, '--slot', '1', '--version', '2', '--price', afterDraw.facePriceWei, '--json']);
    check(secondaryOverCap.data?.txStatus === 'rejected' && secondaryOverCap.data?.errorCode === 'RESALE_CAP_EXCEEDED', 'secondary resale above paidPrice must fail with RESALE_CAP_EXCEEDED');

    // Wrong phase redeem during RESALE must report WRONG_PHASE (not FORGED_CREDENTIAL)
    const earlyRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '1',
      '--expiry', gateValidExpiry,
      '--owner-sig', staleCredV1.ownerSig,
      '--json',
    ]);
    check(earlyRedeem.data?.txStatus === 'rejected' && earlyRedeem.data?.errorCode === 'WRONG_PHASE', 'redeem during RESALE must return WRONG_PHASE');

    // -----------------------------------------------------------------------
    // 5. L2-D1-3 (#2 & #3): Gate verification, stale v1 reject, forged/expired reject,
    //    role check, valid v2 admission, and duplicate scan / duplicate redeem rejection
    // -----------------------------------------------------------------------
    runCli(['advance-time', '--seconds', '305', '--json']);
    const gateStatus = runCli(['status', '--json']);
    check(gateStatus.phase === 'GATE', 'phase must advance to GATE');

    // Stale seller v1 credential must reject with STALE_CREDENTIAL
    const staleUuid = randomUUID();
    const staleRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', staleUuid,
      '--slot', '1', '--version', '1',
      '--expiry', String(staleCredV1.credential.expiry),
      '--owner-sig', staleCredV1.ownerSig,
      '--json', '--json',
    ]);
    check(staleRedeem.data?.ok === false && staleRedeem.data?.txStatus === 'rejected', 'stale v1 credential must reject');
    check(staleRedeem.data?.gateDecision === 'REJECT' && staleRedeem.data?.errorCode === 'STALE_CREDENTIAL', 'stale v1 credential must report REJECT + STALE_CREDENTIAL');
    check(String(staleRedeem.data?.error || '').includes('Version mismatch'), 'stale v1 credential must report Version mismatch');
    check(typeof staleRedeem.data?.txHash === 'string' && staleRedeem.data.txHash.startsWith('0x'), 'stale v1 on-chain reject must include txHash');
    check(staleRedeem.data?.ticket?.admitted === false && staleRedeem.data?.ticket?.version === 2, 'stale v1 reject must leave ticket unadmitted at v2');

    // Forged v2 credential signed by seller (wrong signer)
    const wrongSignerV2 = runCli(['sign-gate', '--role', winnerRole, '--slot', '1', '--version', '2', '--json', '--json']);
    const forgedRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', String(wrongSignerV2.credential.expiry),
      '--owner-sig', wrongSignerV2.ownerSig,
      '--json',
    ]);
    check(forgedRedeem.data?.txStatus === 'rejected' && forgedRedeem.data?.gateDecision === 'REJECT', 'wrong-signer credential must reject');
    check(forgedRedeem.data?.errorCode === 'FORGED_CREDENTIAL', 'wrong-signer credential must return FORGED_CREDENTIAL');
    check(String(forgedRedeem.data?.error || '').includes('Invalid owner signature'), 'wrong-signer error must report Invalid owner signature');

    // Forged ECDSA custom-error signature (65 zero bytes)
    const zeroSigRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', String(wrongSignerV2.credential.expiry),
      '--owner-sig', '0x' + '00'.repeat(65),
      '--json',
    ]);
    check(zeroSigRedeem.data?.txStatus === 'rejected' && zeroSigRedeem.data?.errorCode === 'FORGED_CREDENTIAL', '65-zero-byte signature must return FORGED_CREDENTIAL');

    // Malformed non-hex signature must fail before creating gate-claim file
    const malformedUuid = randomUUID();
    const malformedRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', malformedUuid,
      '--slot', '1', '--version', '2',
      '--expiry', String(wrongSignerV2.credential.expiry),
      '--owner-sig', 'not-hex',
      '--json',
    ]);
    check(malformedRedeem.data?.txStatus === 'rejected' && malformedRedeem.data?.errorCode === 'FORGED_CREDENTIAL', 'malformed signature must return FORGED_CREDENTIAL');
    check(!existsSync(join(gateClaimsDir, `${ethers.id(malformedUuid)}.json`)), 'malformed signature must not leave dangling claim file');

    // Expired v2 credential must report STALE_CREDENTIAL
    const latestBlock = await anvil.rpc('eth_getBlockByNumber', ['latest', false]);
    const expiredTs = String(Number(BigInt(latestBlock.timestamp)) - 10);
    const expiredV2 = runCli(['sign-gate', '--role', loserRole, '--slot', '1', '--version', '2', '--expiry', expiredTs, '--json']);
    const expiredRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', expiredTs,
      '--owner-sig', expiredV2.ownerSig,
      '--json',
    ]);
    check(expiredRedeem.data?.txStatus === 'rejected' && expiredRedeem.data?.errorCode === 'STALE_CREDENTIAL', 'expired credential must return STALE_CREDENTIAL');
    check(String(expiredRedeem.data?.error || '').includes('Invalid expiry'), 'expired credential error must include Invalid expiry');

    // Buyer signs current v2 credential with omitted --version '' (regression test for Number(true) -> 1 bug)
    const validV2 = runCli(['sign-gate', '--role', loserRole, '--slot', '1', '--version', '', '--json', '--json']);
    check(validV2.ok === true && validV2.credential?.version === 2, 'sign-gate with empty --version must auto-resolve v2 after resale');
    check(validV2.ownerSig === validV2.credential?.ownerSig, 'sign-gate must match top-level ownerSig and credential.ownerSig');

    // Role separation: non-gate role cannot redeem
    const nonGateRedeem = runCliAllowFail([
      'redeem', '--role', loserRole,
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', String(validV2.credential.expiry),
      '--owner-sig', validV2.ownerSig,
      '--json',
    ]);
    check(nonGateRedeem.data?.txStatus === 'rejected' && nonGateRedeem.data?.errorCode === 'FORGED_CREDENTIAL', 'non-gate caller must be rejected');
    check(String(nonGateRedeem.data?.error || '').includes('Only gate'), 'non-gate error must include Only gate');

    // Valid buyer v2 admission with UUID scanId
    const admitUuid = randomUUID();
    const admitRes = runCli([
      'redeem', '--role', 'gate',
      '--scan-id', admitUuid,
      '--slot', '1', '--version', '2',
      '--expiry', String(validV2.credential.expiry),
      '--owner-sig', validV2.ownerSig,
      '--json', '--json',
    ]);
    check(admitRes.ok === true && admitRes.txStatus === 'confirmed', 'valid buyer v2 credential must confirm');
    check(admitRes.gateDecision === 'ADMIT' && admitRes.errorCode === null, 'valid buyer v2 credential must ADMIT');
    check(admitRes.ticket?.admitted === true && admitRes.scanId === ethers.id(admitUuid), 'admitted ticket state and normalized scanId must match');

    // Duplicate redeem with SAME UUID scanId
    const dupSameScan = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', admitUuid,
      '--slot', '1', '--version', '2',
      '--expiry', String(validV2.credential.expiry),
      '--owner-sig', validV2.ownerSig,
      '--json',
    ]);
    check(dupSameScan.data?.ok === false && dupSameScan.data?.txStatus === 'rejected', 'duplicate scanId redeem must reject');
    check(dupSameScan.data?.gateDecision === 'REJECT' && dupSameScan.data?.errorCode === 'ALREADY_ADMITTED', 'duplicate scanId must return ALREADY_ADMITTED');
    check(dupSameScan.data?.txHash === null, 'local duplicate scanId claim rejection must not broadcast a second tx');

    // Duplicate redeem with NEW UUID scanId on already-admitted ticket
    const dupNewScan = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', String(validV2.credential.expiry),
      '--owner-sig', validV2.ownerSig,
      '--json',
    ]);
    check(dupNewScan.data?.ok === false && dupNewScan.data?.txStatus === 'rejected', 'second redeem with fresh scanId must reject on-chain');
    check(dupNewScan.data?.gateDecision === 'REJECT' && dupNewScan.data?.errorCode === 'ALREADY_ADMITTED', 'second on-chain redeem must return ALREADY_ADMITTED');
    check(String(dupNewScan.data?.error || '').includes('Already admitted'), 'second on-chain redeem must surface Already admitted');
    check(typeof dupNewScan.data?.txHash === 'string' && dupNewScan.data.txHash.startsWith('0x'), 'second on-chain redeem must include txHash');

    // Honest resume of finalized UUID scanIds (preserves resumedCount === 0 while surfacing prior outcome)
    const resumeAdmit = runCli(['resume', '--role', 'gate', '--scan-id', admitUuid, '--json']);
    check(resumeAdmit.resumedCount === 0 && resumeAdmit.alreadyFinalized === true, 'finalized admit resume must report resumedCount 0 + alreadyFinalized');
    check(resumeAdmit.ok === true && resumeAdmit.txStatus === 'confirmed' && resumeAdmit.gateDecision === 'ADMIT', 'finalized admit resume must report ADMIT/confirmed');
    check(resumeAdmit.txHash === admitRes.txHash, 'finalized admit resume must return original admission txHash');

    const resumeStale = runCli(['resume', '--role', 'gate', '--scan-id', staleUuid, '--json']);
    check(resumeStale.resumedCount === 0 && resumeStale.alreadyFinalized === true, 'finalized stale reject resume must report resumedCount 0');
    check(resumeStale.ok === false && resumeStale.txStatus === 'rejected' && resumeStale.gateDecision === 'REJECT', 'finalized stale reject resume must honestly report rejected');
    check(resumeStale.errorCode === 'STALE_CREDENTIAL' && resumeStale.txHash === staleRedeem.data.txHash, 'finalized stale reject resume must preserve STALE_CREDENTIAL and txHash');

    // -----------------------------------------------------------------------
    // 6. L2-D1-2: Honest unknown_recovering + real mempool receipt timeout recovery
    // -----------------------------------------------------------------------
    const unreachableStatus = runCliAllowFail(['status', '--rpc', 'http://127.0.0.1:1', '--json']);
    check(unreachableStatus.data?.ok === false && unreachableStatus.data?.txStatus === 'unknown_recovering', 'unreachable RPC status must return unknown_recovering');
    check(unreachableStatus.data?.errorCode === 'RPC_TIMEOUT', 'unreachable RPC status must return RPC_TIMEOUT');

    const unreachableRedeem = runCliAllowFail([
      'redeem', '--role', 'gate',
      '--rpc', 'http://127.0.0.1:1',
      '--scan-id', randomUUID(),
      '--slot', '1', '--version', '2',
      '--expiry', String(validV2.credential.expiry),
      '--owner-sig', validV2.ownerSig,
      '--json',
    ]);
    check(unreachableRedeem.data?.ok === false && unreachableRedeem.data?.txStatus === 'unknown_recovering', 'unreachable RPC redeem must return unknown_recovering');
    check(unreachableRedeem.data?.errorCode === 'RPC_TIMEOUT', 'unreachable RPC redeem must return RPC_TIMEOUT');

    // Simulate real receipt timeout (mempool pending) then mine & resume
    await anvil.rpc('evm_setAutomine', [false]);
    const timeoutWithdraw = runCliAllowFail(['withdraw', '--role', 'organiser', '--json']);
    check(timeoutWithdraw.data?.ok === false && timeoutWithdraw.data?.txStatus === 'unknown_recovering', 'pending receipt timeout must report unknown_recovering');
    check(timeoutWithdraw.data?.errorCode === 'RPC_TIMEOUT', 'pending receipt timeout must report RPC_TIMEOUT');
    check(typeof timeoutWithdraw.data?.txHash === 'string' && timeoutWithdraw.data.txHash.startsWith('0x'), 'receipt timeout must expose journaled txHash for resume');

    await anvil.rpc('evm_mine');
    await anvil.rpc('evm_setAutomine', [true]);

    const resumeOrg = runCli(['resume', '--role', 'organiser', '--tx-hash', timeoutWithdraw.data.txHash, '--json']);
    check(resumeOrg.ok === true && resumeOrg.txStatus === 'confirmed', 'resume after mined tx must confirm');
    check(resumeOrg.resumedCount === 1 && resumeOrg.txHash === timeoutWithdraw.data.txHash, 'resume must settle the timed-out txHash');

    // Withdraw when zero balance must NOT misclassify "withdraw" as WRONG_PHASE
    const emptyWithdraw = runCliAllowFail(['withdraw', '--role', 'organiser', '--json']);
    check(emptyWithdraw.data?.txStatus === 'rejected' && emptyWithdraw.data?.errorCode === 'INTERNAL_ERROR', 'empty withdraw must be INTERNAL_ERROR, not WRONG_PHASE');
    check(String(emptyWithdraw.data?.error || '').includes('Nothing to withdraw'), 'empty withdraw error must say Nothing to withdraw');

    const withdrawSeller = runCli(['withdraw', '--role', winnerRole, '--json']);
    check(withdrawSeller.ok === true && withdrawSeller.txStatus === 'confirmed', 'seller withdraw must confirm');

    const finalStatus = runCli(['status', '--json']);
    check(finalStatus.contractBalanceWei === '0', 'contract balance must reconcile to 0 after withdrawals');
    check(finalStatus.issuedCount === 1 && finalStatus.admittedCount === 1, 'final counts must reconcile to issued=1 admitted=1');
    check(finalStatus.roles.organiser.withdrawableWei === '0' && finalStatus.roles[winnerRole].withdrawableWei === '0', 'role credits must reconcile to 0');

    // -----------------------------------------------------------------------
    // 7. Missing code detection, explicit reset-demo & fresh redeploy
    // -----------------------------------------------------------------------
    const missingCodeStatus = runCliAllowFail(['status', '--contract', '0x0000000000000000000000000000000000000001', '--rpc', rpcUrl, '--json']);
    check(missingCodeStatus.data?.ok === false && missingCodeStatus.data?.txStatus === 'rejected', 'missing bytecode contract status must reject');
    check(String(missingCodeStatus.data?.error || '').includes('No FairTickets contract deployed'), 'missing bytecode status error must be explicit');

    const resetRes = runCli(['reset-demo', '--json']);
    check(resetRes.ok === true && resetRes.reset === true, 'reset-demo must succeed');
    check(!existsSync(demoStatePath) && !existsSync(demoFixturePath), 'reset-demo must remove demo state and fixture');

    const init2 = runCli(['init-demo', '--capacity', '2', '--rpc', rpcUrl]);
    check(init2.ok === true && init2.capacity === 2, 'fresh init-demo after reset-demo must succeed');
    check(init2.contract.toLowerCase() !== firstContract.toLowerCase(), 'fresh init-demo must deploy a new contract instance');

    // -----------------------------------------------------------------------
    // 8. Concurrent --json gate races, pending worker resume, and alerts contract
    // -----------------------------------------------------------------------
    runCli(['enter', '--role', 'fanA', '--subject', 'race-subject', '--json']);
    runCliAllowFail(['enter', '--role', 'fanB', '--subject', 'race-subject', '--json']);
    runCliAllowFail(['enter', '--role', 'gate', '--subject', 'race-subject', '--json']);
    runCli(['enter', '--role', 'fanB', '--subject', 'race-subject-b', '--json']);

    const alertsRes = runCli(['alerts', '--json']);
    check(alertsRes.ok === true && Array.isArray(alertsRes.alerts), 'alerts --json must return ok and alerts array');
    check(alertsRes.alerts.some((a) => a.rule === 'REPEATED_ENTRY_SUBJECT'), 'alerts must detect repeated entry subject');
    check(
      alertsRes.alerts.every((a) => a.severity === 'review' && a.note === 'Review signal only; does not auto-block'),
      'all alerts must be review-only and non-blocking'
    );

    runCli(['advance-time', '--seconds', '125', '--json']);
    runCli(['lock-draw', '--role', 'organiser', '--json']);
    runCli(['mine', '--blocks', '2', '--json']);
    runCli(['draw', '--role', 'organiser', '--json']);
    runCli(['claim', '--role', 'fanA', '--json']);
    runCli(['claim', '--role', 'fanB', '--json']);

    const cap2ClaimStatus = runCli(['status', '--json']);
    const roleForAddr = (addr) =>
      addr.toLowerCase() === cap2ClaimStatus.roles.fanA.address.toLowerCase() ? 'fanA' : 'fanB';
    const slot1Role = roleForAddr(cap2ClaimStatus.tickets[0].owner);
    const slot2Role = roleForAddr(cap2ClaimStatus.tickets[1].owner);

    runCli(['advance-time', '--seconds', '610', '--json']);
    const cred1 = runCli(['sign-gate', '--role', slot1Role, '--slot', '1', '--version', '', '--json', '--json']);
    const cred2 = runCli(['sign-gate', '--role', slot2Role, '--slot', '2', '--version', '', '--json', '--json']);

    // Race A: 2 concurrent redeem calls with the SAME UUID scanId on slot 1
    const sameUuid = randomUUID();
    const sameRace = await Promise.all([
      runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', sameUuid,
        '--slot', '1', '--version', String(cred1.credential.version),
        '--expiry', String(cred1.credential.expiry), '--owner-sig', cred1.ownerSig, '--json',
      ]),
      runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', sameUuid,
        '--slot', '1', '--version', String(cred1.credential.version),
        '--expiry', String(cred1.credential.expiry), '--owner-sig', cred1.ownerSig, '--json',
      ]),
    ]);
    const sameAdmits = sameRace.filter((r) => r.data?.txStatus === 'confirmed' && r.data?.gateDecision === 'ADMIT');
    const sameRejects = sameRace.filter((r) => r.data?.txStatus === 'rejected' && r.data?.errorCode === 'ALREADY_ADMITTED');
    check(sameAdmits.length === 1 && sameRejects.length === 1, 'same-scanId race must admit exactly 1 and reject 1 as ALREADY_ADMITTED');

    const afterRaceA = runCli(['status', '--json']);
    check(afterRaceA.admittedCount === 1, 'admittedCount after slot 1 race must be 1');

    // Race B: 2 concurrent redeem calls with DIFFERENT UUID scanIds for slot 2
    const diffRace = await Promise.all([
      runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', randomUUID(),
        '--slot', '2', '--version', String(cred2.credential.version),
        '--expiry', String(cred2.credential.expiry), '--owner-sig', cred2.ownerSig, '--json',
      ]),
      runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', randomUUID(),
        '--slot', '2', '--version', String(cred2.credential.version),
        '--expiry', String(cred2.credential.expiry), '--owner-sig', cred2.ownerSig, '--json',
      ]),
    ]);
    const diffAdmits = diffRace.filter((r) => r.data?.txStatus === 'confirmed' && r.data?.gateDecision === 'ADMIT');
    const diffRejects = diffRace.filter((r) => r.data?.txStatus === 'rejected' && r.data?.errorCode === 'ALREADY_ADMITTED');
    check(diffAdmits.length === 1 && diffRejects.length === 1, 'distinct-scanId concurrent race on same ticket must admit 1 and reject 1 as ALREADY_ADMITTED');

    const afterRaceB = runCli(['status', '--json']);
    check(afterRaceB.admittedCount === 2, 'admittedCount after slot 2 race must be 2');

    // Pending txStatus check when gate claim file belongs to a live worker PID
    const activeUuid = randomUUID();
    const activeScanHex = ethers.id(activeUuid);
    const activeClaimPath = join(gateClaimsDir, `${activeScanHex}.json`);
    const activeFinalPath = join(gateClaimsDir, `${activeScanHex}.final.json`);
    mkdirSync(gateClaimsDir, { recursive: true });
    writeFileSync(activeClaimPath, JSON.stringify({
      status: 'CLAIMED',
      acted: false,
      contract: init2.contract,
      slot: '2',
      version: '1',
      pid: process.pid,
    }, null, 2));
    try {
      const pendingResume = runCliAllowFail(['resume', '--role', 'gate', '--scan-id', activeUuid, '--json']);
      check(pendingResume.data?.txStatus === 'pending' && pendingResume.data?.ok === false, 'live worker claim resume must report pending');
      check(pendingResume.data?.resumedCount === 1 && pendingResume.data?.resumed?.[0]?.status === 'ACTIVE_WORKER', 'live worker claim must report ACTIVE_WORKER');
    } finally {
      if (existsSync(activeClaimPath)) unlinkSync(activeClaimPath);
      if (existsSync(activeFinalPath)) unlinkSync(activeFinalPath);
    }

    console.log(JSON.stringify({
      loop2CoreVerified: true,
      checksPassed,
      firstContract,
      secondContract: init2.contract,
      winnerRole,
      buyerRole: loserRole,
      resalePriceWei: resalePrice,
      finalVersion: 2,
      admittedCountAfterRaces: afterRaceB.admittedCount,
      alertsDetected: alertsRes.alerts.map((a) => a.rule),
    }, null, 2));
  } finally {
    await anvil.stop();
    if (existsSync(demoStatePath)) unlinkSync(demoStatePath);
    if (existsSync(demoFixturePath)) unlinkSync(demoFixturePath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
