const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { startAnvil } = require('./anvil.cjs');
const { ethers } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const cliPath = join(__dirname, 'cli.cjs');
const volumeSummaryPath = join(root, 'artifacts', 'volume-summary.json');

let checksPassed = 0;

function check(cond, msg) {
  assert(cond, msg);
  checksPassed++;
}

function makeCliRunner(stateDir) {
  const env = { ...process.env, FAIRTICKETS_STATE_DIR: stateDir };

  function runCli(args) {
    const out = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    return JSON.parse(out);
  }

  function runCliAllowFail(args) {
    try {
      const out = execFileSync(process.execPath, [cliPath, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { exitCode: 0, data: JSON.parse(out) };
    } catch (err) {
      const stdout = String(err?.stdout || '').trim();
      let data = null;
      try {
        data = stdout ? JSON.parse(stdout) : null;
      } catch {}
      return { exitCode: err?.status ?? 1, data, stderr: String(err?.stderr || '').trim() };
    }
  }

  return { runCli, runCliAllowFail };
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'fairtickets-loop3-'));
  const { runCli, runCliAllowFail } = makeCliRunner(stateDir);
  const port = 8556;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil({ port, chainId: 31337, silent: true });

  try {
    // 1. Initialize isolated demo and verify L3-D1-3 volumeEvidence + codeHash
    const init = runCli([
      'init-demo',
      '--rpc', rpcUrl,
      '--capacity', '2',
      '--face-price', '50000000000000000',
      '--json',
    ]);
    check(init.ok === true && init.txStatus === 'confirmed', 'init-demo should succeed');
    check(init.contract && /^0x[0-9a-fA-F]{40}$/.test(init.contract), 'init-demo should return contract address');

    const statusInit = runCli(['status', '--json']);
    check(statusInit.ok === true, 'status --json should return ok: true');
    check(/^0x[0-9a-fA-F]{64}$/.test(statusInit.codeHash), 'status should expose keccak256 codeHash');
    if (existsSync(volumeSummaryPath)) {
      const summary = JSON.parse(readFileSync(volumeSummaryPath, 'utf8'));
      check(Boolean(statusInit.volumeEvidence), 'status should include volumeEvidence when volume-summary.json exists');
      check(
        statusInit.volumeEvidence.totalWrites === (summary.totalWrites ?? summary.countedWrites?.total),
        'volumeEvidence.totalWrites should match volume-summary.json'
      );
      check(
        statusInit.volumeEvidence.manifestSha256 === summary.manifestSha256,
        'volumeEvidence.manifestSha256 should match volume-summary.json'
      );
    }

    // 2. L3-D1-2: Trigger REPEATED_ENTRY_SUBJECT (>= 3 enter attempts for same subject) + verify legitimate control not blocked
    const repeat1 = runCli(['enter', '--role', 'fanA', '--subject', 'bot-subject-1', '--json']);
    check(repeat1.ok === true && repeat1.txStatus === 'confirmed', 'first entry for bot-subject-1 should succeed');

    const repeat2 = runCliAllowFail(['enter', '--role', 'fanA', '--subject', 'bot-subject-1', '--json']);
    check(repeat2.data?.ok === false && repeat2.data?.txStatus === 'rejected', 'second entry for bot-subject-1 should be rejected');

    const repeat3 = runCliAllowFail(['enter', '--role', 'fanA', '--subject', 'bot-subject-1', '--json']);
    check(repeat3.data?.ok === false && repeat3.data?.txStatus === 'rejected', 'third entry for bot-subject-1 should be rejected');

    // Legitimate control enters cleanly despite repeated-entry review alert on bot-subject-1
    const controlEnter = runCli(['enter', '--role', 'fanB', '--subject', 'legitimate-control-fan', '--json']);
    check(controlEnter.ok === true && controlEnter.txStatus === 'confirmed', 'legitimate control should still enter cleanly');

    const afterEntries = runCli(['status', '--json']);
    check(afterEntries.entrantsCount === 2, `entrantsCount should be 2 (got ${afterEntries.entrantsCount})`);

    const entryAlertsRes = runCli(['alerts', '--json']);
    check(entryAlertsRes.ok === true && Array.isArray(entryAlertsRes.alerts), 'alerts --json should return alerts array');
    const repeatedEntryAlert = entryAlertsRes.alerts.find(
      (a) => a.rule === 'REPEATED_ENTRY_SUBJECT' && a.subjectOrSlot === ethers.id('bot-subject-1')
    );
    check(Boolean(repeatedEntryAlert), 'alerts should emit REPEATED_ENTRY_SUBJECT for bot-subject-1');
    check(repeatedEntryAlert.severity === 'review', 'REPEATED_ENTRY_SUBJECT severity must be review');
    check(repeatedEntryAlert.count === 3, `REPEATED_ENTRY_SUBJECT count should be 3 (got ${repeatedEntryAlert?.count})`);
    check(repeatedEntryAlert.grouping === 'subject', 'REPEATED_ENTRY_SUBJECT grouping should be subject');
    check(repeatedEntryAlert.subjectLabel === 'bot-subject-1', 'REPEATED_ENTRY_SUBJECT should expose subjectLabel');
    check(/review signal only/i.test(repeatedEntryAlert.note), 'alert note must state review-only');

    // REQUEST_BURST should also be emitted (>= 5 requests in 10s, we had 4 enters + let's do lock-draw + draw soon)
    // Advance past entryDeadline, lock-draw, mine, draw
    runCli(['advance-time', '--seconds', '125', '--json']);
    const lockRes = runCli(['lock-draw', '--role', 'organiser', '--json']);
    check(lockRes.ok === true && lockRes.txStatus === 'confirmed', 'lock-draw should succeed');
    runCli(['mine', '--blocks', '2', '--json']);
    const drawRes = runCli(['draw', '--role', 'organiser', '--json']);
    check(drawRes.ok === true && drawRes.txStatus === 'confirmed', 'draw should succeed');

    const burstAlertsRes = runCli(['alerts', '--json']);
    const burstAlert = burstAlertsRes.alerts.find((a) => a.rule === 'REQUEST_BURST');
    check(Boolean(burstAlert), 'alerts should emit REQUEST_BURST after >=5 rapid requests');
    check(burstAlert.severity === 'review' && burstAlert.grouping === 'event', 'REQUEST_BURST should have review severity and event grouping');

    // 3. Claim slot 1 as winner (fanA or fanB depending on draw, both won because capacity === 2 & entrants === 2)
    const statusDrawn = runCli(['status', '--json']);
    check(statusDrawn.winnersCount === 2, 'winnersCount should be 2');
    const claimA = runCli(['claim', '--role', 'fanA', '--json']);
    check(claimA.ok === true && claimA.txStatus === 'confirmed', 'fanA claim should succeed');
    const statusClaimed = runCli(['status', '--json']);
    const fanAAddr = statusClaimed.roles.fanA.address.toLowerCase();
    const slotA = statusClaimed.tickets.find((t) => t.owner.toLowerCase() === fanAAddr)?.slot;
    check(Number.isInteger(slotA) && slotA >= 1, 'fanA should own a claimed ticket slot');

    // Move to RESALE phase, list slotA at 40000000000000000 wei, buy as fanB
    runCli(['advance-time', '--seconds', '301', '--json']);
    const resalePrice = '40000000000000000';
    const listRes = runCli(['list', '--role', 'fanA', '--slot', String(slotA), '--version', '1', '--price', resalePrice, '--json']);
    check(listRes.ok === true && listRes.txStatus === 'confirmed', 'fanA list within cap should succeed');
    const buyRes = runCli(['buy', '--role', 'fanB', '--slot', String(slotA), '--version', '1', '--price', resalePrice, '--json']);
    check(buyRes.ok === true && buyRes.txStatus === 'confirmed', 'fanB buy should succeed');

    // 4. L3-D1-1 Money reconciliation: contractBalanceWei === organiser.withdrawableWei + fanA.withdrawableWei
    const preWithdrawStatus = runCli(['status', '--json']);
    const orgCredits = BigInt(preWithdrawStatus.roles.organiser.withdrawableWei);
    const fanACredits = BigInt(preWithdrawStatus.roles.fanA.withdrawableWei);
    const fanBCredits = BigInt(preWithdrawStatus.roles.fanB.withdrawableWei);
    const contractBal = BigInt(preWithdrawStatus.balanceWei);
    check(orgCredits === 50000000000000000n, `organiser withdrawableWei should equal facePrice (got ${orgCredits})`);
    check(fanACredits === BigInt(resalePrice), `fanA withdrawableWei should equal resalePrice (got ${fanACredits})`);
    check(fanBCredits === 0n, `fanB withdrawableWei should be 0 (got ${fanBCredits})`);
    check(contractBal === orgCredits + fanACredits, 'contract balance must reconcile exactly with role credits');

    const withdrawFanA = runCli(['withdraw', '--role', 'fanA', '--json']);
    check(withdrawFanA.ok === true && withdrawFanA.txStatus === 'confirmed', 'fanA withdraw should succeed');
    const withdrawOrg = runCli(['withdraw', '--role', 'organiser', '--json']);
    check(withdrawOrg.ok === true && withdrawOrg.txStatus === 'confirmed', 'organiser withdraw should succeed');

    const postWithdrawStatus = runCli(['status', '--json']);
    check(BigInt(postWithdrawStatus.balanceWei) === 0n, 'contract balance should be 0 after all withdrawals');
    check(BigInt(postWithdrawStatus.roles.organiser.withdrawableWei) === 0n, 'organiser withdrawableWei should be 0');
    check(BigInt(postWithdrawStatus.roles.fanA.withdrawableWei) === 0n, 'fanA withdrawableWei should be 0');

    const emptyWithdraw = runCliAllowFail(['withdraw', '--role', 'fanB', '--json']);
    check(emptyWithdraw.data?.ok === false && emptyWithdraw.data?.txStatus === 'rejected', 'zero-proceeds withdraw should be rejected');
    check(/nothing to withdraw/i.test(emptyWithdraw.data?.reason || ''), 'zero-proceeds withdraw should include Nothing to withdraw reason');

    // 5. L3-D1-1 & L3-D1-2: Move to GATE phase, trigger REPEATED_FAILED_SCAN + timeout/resume recovery
    runCli(['advance-time', '--seconds', '301', '--json']);
    const credV2 = runCli(['sign-gate', '--role', 'fanB', '--slot', String(slotA), '--version', '2', '--json']);
    check(credV2.ok === true && Boolean(credV2.ownerSig), 'fanB sign-gate v2 should succeed');

    const failedScanId = `failed-scan-${randomUUID()}`;
    const failScan1 = runCliAllowFail([
      'redeem', '--role', 'gate', '--scan-id', failedScanId,
      '--slot', String(slotA), '--version', '1', '--expiry', String(credV2.expiry),
      '--owner-sig', credV2.ownerSig, '--json',
    ]);
    check(failScan1.data?.ok === false && failScan1.data?.txStatus === 'rejected', 'first stale/invalid scan should reject');

    const failScan2 = runCliAllowFail([
      'redeem', '--role', 'gate', '--scan-id', failedScanId,
      '--slot', String(slotA), '--version', '1', '--expiry', String(credV2.expiry),
      '--owner-sig', credV2.ownerSig, '--json',
    ]);
    check(failScan2.data?.ok === false && failScan2.data?.txStatus === 'rejected', 'second failed scan on same scanId should reject');

    const scanAlertsRes = runCli(['alerts', '--json']);
    const failedScanAlert = scanAlertsRes.alerts.find(
      (a) => a.rule === 'REPEATED_FAILED_SCAN' && a.subjectOrSlot === ethers.id(failedScanId)
    );
    check(Boolean(failedScanAlert), 'alerts should emit REPEATED_FAILED_SCAN after >=2 failed scans for same scanId');
    check(failedScanAlert.severity === 'review' && failedScanAlert.grouping === 'scanId', 'REPEATED_FAILED_SCAN should have review severity and scanId grouping');

    // Simulated timeout (disable automine so receipt times out) + resume recovery without duplicate admission
    const timeoutScanId = `recover-scan-${randomUUID()}`;
    await anvil.rpc('evm_setAutomine', [false]);
    const timeoutRes = runCliAllowFail([
      'redeem', '--role', 'gate', '--scan-id', timeoutScanId,
      '--slot', String(slotA), '--version', '2', '--expiry', String(credV2.expiry),
      '--owner-sig', credV2.ownerSig, '--json',
    ]);
    await anvil.rpc('evm_mine');
    await anvil.rpc('evm_setAutomine', [true]);
    check(timeoutRes.data?.ok === false && timeoutRes.data?.txStatus === 'unknown_recovering', 'receipt timeout should return unknown_recovering');
    check(timeoutRes.data?.errorCode === 'RPC_TIMEOUT', 'receipt timeout should classify as RPC_TIMEOUT');
    check(Boolean(timeoutRes.data?.txHash), 'receipt timeout should include txHash');

    const resumed = runCli(['resume', '--role', 'gate', '--scan-id', timeoutScanId, '--json']);
    check(resumed.ok === true && resumed.txStatus === 'confirmed', `resume should resolve confirmed: ${JSON.stringify(resumed)}`);
    check(resumed.gateDecision === 'ADMIT', `resume should report gateDecision ADMIT: ${JSON.stringify(resumed)}`);

    const statusAdmitted = runCli(['status', '--json']);
    check(statusAdmitted.admittedCount === 1, 'admittedCount should be exactly 1 after resume');

    const resumedAgain = runCli(['resume', '--role', 'gate', '--scan-id', timeoutScanId, '--json']);
    check(resumedAgain.ok === true && resumedAgain.alreadyFinalized === true && resumedAgain.gateDecision === 'ADMIT', 'idempotent second resume should return alreadyFinalized ADMIT');

    const unknownResume = runCli(['resume', '--role', 'gate', '--scan-id', `missing-${randomUUID()}`, '--json']);
    check(unknownResume.ok === true && unknownResume.resumedCount === 0, 'resume for unknown scanId should return resumedCount 0 cleanly');

    // 6. Verify append-only activity log & reset-demo cleanup
    const activityLogPath = join(stateDir, 'activity-log.ndjson');
    check(existsSync(activityLogPath), 'activity-log.ndjson should exist');
    const lines = readFileSync(activityLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
    check(lines.length >= 10, `activity-log.ndjson should contain >=10 events (got ${lines.length})`);

    const resetRes = runCli(['reset-demo', '--json']);
    check(resetRes.ok === true && resetRes.reset === true, 'reset-demo should succeed');
    check(!existsSync(activityLogPath), 'reset-demo should clear activity-log.ndjson');
    check(!existsSync(join(stateDir, 'demo-state.json')), 'reset-demo should clear demo-state.json');

    console.log(JSON.stringify({
      loop3CoreVerified: true,
      checksPassed,
      alertRulesVerified: ['REPEATED_ENTRY_SUBJECT', 'REPEATED_FAILED_SCAN', 'REQUEST_BURST'],
      moneyReconciled: true,
      recoveryVerified: true,
    }, null, 2));
  } finally {
    await anvil.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
