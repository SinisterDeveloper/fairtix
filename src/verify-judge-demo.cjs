const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { startAnvil } = require('./anvil.cjs');

const execFileAsync = promisify(execFile);
const root = resolve(__dirname, '..');
const cliPath = join(__dirname, 'cli.cjs');

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
      return { exitCode: err?.status ?? 1, data };
    }
  }

  async function runCliAsyncAllowFail(args) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      return { exitCode: 0, data: JSON.parse(stdout) };
    } catch (err) {
      const stdout = String(err?.stdout || '').trim();
      let data = null;
      try {
        data = stdout ? JSON.parse(stdout) : null;
      } catch {}
      return { exitCode: err?.code ?? 1, data };
    }
  }

  return { runCli, runCliAllowFail, runCliAsyncAllowFail };
}

async function main() {
  const primaryDir = mkdtempSync(join(tmpdir(), 'fairtickets-judge-primary-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'fairtickets-judge-backup-'));
  const primary = makeCliRunner(primaryDir);
  const backup = makeCliRunner(backupDir);
  const port = 8557;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil({ port, chainId: 31337, silent: true });

  try {
    // -----------------------------------------------------------------------
    // 1. D1-DEMO-1 & D1-DEMO-2: Fixed fixture + bounded demo-attack evidence
    // -----------------------------------------------------------------------
    const init = primary.runCli([
      'init-demo',
      '--rpc', rpcUrl,
      '--capacity', '2',
      '--face-price', '50000000000000000',
      '--json',
    ]);
    check(init.ok === true && init.txStatus === 'confirmed', 'primary init-demo should succeed');

    const statusBefore = primary.runCli(['status', '--json']);
    check(
      Object.keys(statusBefore.roles).sort().join(',') === 'attester,fanA,fanB,gate,organiser',
      'status.roles must preserve exact 5 RoleId keys'
    );
    check(statusBefore.entrantsCount === 0, 'entrantsCount should start at 0');

    const attack = primary.runCli([
      'demo-attack',
      '--scenario', 'repeated-entry',
      '--attempts', '3',
      '--control-role', 'fanA',
      '--json',
    ]);
    check(attack.ok === true && attack.txStatus === 'confirmed', 'demo-attack should succeed');
    check(typeof attack.runId === 'string' && attack.runId.startsWith('attack-'), 'demo-attack should expose runId');
    check(attack.scenario === 'repeated-entry', 'demo-attack should expose scenario');
    check(attack.before.entrantsCount === 0 && attack.before.phase === 'ENTRY', 'before counts should match');
    check(attack.after.entrantsCount === 2, `after entrantsCount should be 2 (got ${attack.after.entrantsCount})`);
    check(attack.after.extraEntriesAdded === 0, 'extraEntriesAdded must be 0');
    check(attack.after.controlEligible === true && attack.after.botEligible === true, 'both distinct participants should be eligible once');
    check(attack.attempts.length === 4, 'attempts should include 3 repeated + 1 control');
    check(attack.attempts[0].decision === 'ALLOWED', 'first repeated attempt allowed');
    check(attack.attempts[1].decision === 'REJECTED' && attack.attempts[2].decision === 'REJECTED', 'duplicate attempts rejected');
    check(attack.attempts[3].kind === 'legitimate-control' && attack.attempts[3].decision === 'ALLOWED', 'legitimate control allowed');
    check(attack.summary.repeatedAttempts === 3 && attack.summary.repeatedAllowed === 1 && attack.summary.repeatedRejected === 2, 'summary repeated counts must match');
    check(attack.summary.controlAllowed === true && attack.summary.reviewAlertTriggered === true, 'summary should confirm control and alert');
    check(
      attack.relatedAlerts.some((a) => a.rule === 'REPEATED_ENTRY_SUBJECT' && a.severity === 'review' && a.subjectLabel === 'bot-repeated-entrant'),
      'relatedAlerts must include REPEATED_ENTRY_SUBJECT with review severity and subjectLabel'
    );

    // -----------------------------------------------------------------------
    // 2. D1-DEMO-3: Draw, claim, above-cap rejection, permitted sale, stale v1 vs v2, live race on unused slot
    // -----------------------------------------------------------------------
    const enterB = primary.runCli(['enter', '--role', 'fanB', '--subject', 'demo-fanB', '--json']);
    check(enterB.ok === true && enterB.txStatus === 'confirmed', 'fanB should enter as eligible participant');

    primary.runCli(['advance-time', '--seconds', '125', '--json']);
    primary.runCli(['lock-draw', '--role', 'organiser', '--json']);
    primary.runCli(['mine', '--blocks', '2', '--json']);
    primary.runCli(['draw', '--role', 'organiser', '--json']);

    const statusDrawn = primary.runCli(['status', '--json']);
    const fanAAddr = statusDrawn.roles.fanA.address.toLowerCase();
    const fanBAddr = statusDrawn.roles.fanB.address.toLowerCase();
    const fanAWon = statusDrawn.winners.includes(fanAAddr);
    const fanBWon = statusDrawn.winners.includes(fanBAddr);
    check(fanAWon || fanBWon, 'at least one of fanA or fanB must win in 2-of-3 draw');
    const sellerRole = fanAWon ? 'fanA' : 'fanB';
    const buyerRole = sellerRole === 'fanA' ? 'fanB' : 'fanA';
    const sellerAddr = sellerRole === 'fanA' ? fanAAddr : fanBAddr;
    const buyerAddr = buyerRole === 'fanA' ? fanAAddr : fanBAddr;

    const claimSeller = primary.runCli(['claim', '--role', sellerRole, '--json']);
    check(claimSeller.ok === true && claimSeller.txStatus === 'confirmed', `${sellerRole} should claim winning slot`);

    const statusClaimed = primary.runCli(['status', '--json']);
    const featuredSlot = statusClaimed.tickets.find((t) => t.owner.toLowerCase() === sellerAddr)?.slot;
    check(Number.isInteger(featuredSlot) && featuredSlot >= 1, `featuredSlot owned by ${sellerRole} must exist`);
    check(
      statusClaimed.tickets.every((t) => t.owner.toLowerCase() !== buyerAddr),
      `${buyerRole} should hold 0 tickets prior to resale`
    );

    // Pre-stage seller v1 credential with long expiry (block.timestamp + 1200) so it stays within acceptance window at GATE
    const latestBlock = await anvil.rpc('eth_getBlockByNumber', ['latest', false]);
    const longExpiry = Number(BigInt(latestBlock.timestamp)) + 1200;
    const sellerCredV1 = primary.runCli([
      'sign-gate', '--role', sellerRole, '--slot', String(featuredSlot), '--version', '1', '--expiry', String(longExpiry), '--json',
    ]);
    check(sellerCredV1.ok === true && sellerCredV1.version === 1, 'seller v1 credential should sign');

    // Move to RESALE phase
    primary.runCli(['advance-time', '--seconds', '301', '--json']);

    // Above-cap rejection (10x face price)
    const aboveCap = primary.runCliAllowFail([
      'list', '--role', sellerRole, '--slot', String(featuredSlot), '--version', '1', '--price', '500000000000000000', '--json',
    ]);
    check(aboveCap.data?.ok === false && aboveCap.data?.errorCode === 'RESALE_CAP_EXCEEDED', '10x markup must fail with RESALE_CAP_EXCEEDED');

    // Permitted listing & purchase by buyerRole
    const listOk = primary.runCli([
      'list', '--role', sellerRole, '--slot', String(featuredSlot), '--version', '1', '--price', '45000000000000000', '--json',
    ]);
    check(listOk.ok === true && listOk.txStatus === 'confirmed', 'within-cap listing should confirm');
    const buyOk = primary.runCli([
      'buy', '--role', buyerRole, '--slot', String(featuredSlot), '--version', '1', '--price', '45000000000000000', '--json',
    ]);
    check(buyOk.ok === true && buyOk.txStatus === 'confirmed', `${buyerRole} resale purchase should confirm: ${JSON.stringify(buyOk)}`);

    const statusSold = primary.runCli(['status', '--json']);
    const soldTicket = statusSold.tickets.find((t) => t.slot === featuredSlot);
    check(soldTicket.owner.toLowerCase() === buyerAddr && soldTicket.version === 2, `featured slot owner should be ${buyerRole} at version 2`);

    // Move to GATE phase
    primary.runCli(['advance-time', '--seconds', '301', '--json']);

    // Seller v1 credential is NOT expired, so it fails specifically for stale version (STALE_CREDENTIAL / Version mismatch)
    const staleAttempt = primary.runCliAllowFail([
      'redeem', '--role', 'gate', '--scan-id', `stale-${randomUUID()}`,
      '--slot', String(featuredSlot), '--version', '1', '--expiry', String(sellerCredV1.expiry),
      '--owner-sig', sellerCredV1.ownerSig, '--json',
    ]);
    check(staleAttempt.data?.ok === false && staleAttempt.data?.errorCode === 'STALE_CREDENTIAL', 'seller v1 credential should fail with STALE_CREDENTIAL');
    check(/version mismatch/i.test(staleAttempt.data?.reason || ''), `stale v1 reason should mention version mismatch (got ${staleAttempt.data?.reason})`);

    // Buyer v2 credential admits once, then repeat scan fails
    const buyerCredV2 = primary.runCli([
      'sign-gate', '--role', buyerRole, '--slot', String(featuredSlot), '--version', '2', '--json',
    ]);
    const admitRes = primary.runCli([
      'redeem', '--role', 'gate', '--scan-id', `admit-${randomUUID()}`,
      '--slot', String(featuredSlot), '--version', '2', '--expiry', String(buyerCredV2.expiry),
      '--owner-sig', buyerCredV2.ownerSig, '--json',
    ]);
    check(admitRes.ok === true && admitRes.gateDecision === 'ADMIT', 'buyer v2 credential should admit');

    const repeatScan = primary.runCliAllowFail([
      'redeem', '--role', 'gate', '--scan-id', `repeat-${randomUUID()}`,
      '--slot', String(featuredSlot), '--version', '2', '--expiry', String(buyerCredV2.expiry),
      '--owner-sig', buyerCredV2.ownerSig, '--json',
    ]);
    check(repeatScan.data?.ok === false && repeatScan.data?.errorCode === 'ALREADY_ADMITTED', 'repeat scan must fail with ALREADY_ADMITTED');

    // Live concurrency Q&A on unused slot: two concurrent scans with distinct scanIds produce exactly 1 confirmed admission
    // Note: slot != featuredSlot is owned by bot-repeated-entrant (we can claim & sign using fixture's bot privateKey via --key)
    //Wait: bot-repeated-entrant hasn't claimed its slot yet because claim window closed! Let's verify D1-DEMO-4 backup edition + spare slot concurrency there!

    // -----------------------------------------------------------------------
    // 3. D1-DEMO-4: Isolated backup edition staged at GATE with spare slot concurrency proof
    // -----------------------------------------------------------------------
    const backupInit = backup.runCli([
      'init-demo',
      '--rpc', rpcUrl,
      '--capacity', '2',
      '--face-price', '50000000000000000',
      '--json',
    ]);
    check(backupInit.ok === true && backupInit.contract !== init.contract, 'backup edition must deploy to a distinct contract');

    backup.runCli(['enter', '--role', 'fanA', '--subject', 'backup-fanA', '--json']);
    backup.runCli(['enter', '--role', 'fanB', '--subject', 'backup-fanB', '--json']);
    backup.runCli(['advance-time', '--seconds', '125', '--json']);
    backup.runCli(['lock-draw', '--role', 'organiser', '--json']);
    backup.runCli(['mine', '--blocks', '2', '--json']);
    backup.runCli(['draw', '--role', 'organiser', '--json']);
    backup.runCli(['claim', '--role', 'fanA', '--json']);
    backup.runCli(['claim', '--role', 'fanB', '--json']);
    backup.runCli(['advance-time', '--seconds', '602', '--json']); // directly to GATE phase

    const backupStatus = backup.runCli(['status', '--json']);
    check(backupStatus.phase === 'GATE' && backupStatus.issuedCount === 2, 'backup edition should be staged at GATE with 2 issued slots');
    const spareSlot = backupStatus.tickets.find((t) => t.owner.toLowerCase() === backupStatus.roles.fanB.address.toLowerCase())?.slot;
    check(Number.isInteger(spareSlot), 'spareSlot owned by fanB should exist in backup edition');

    const spareCred = backup.runCli(['sign-gate', '--role', 'fanB', '--slot', String(spareSlot), '--version', '1', '--json']);
    const [race1, race2] = await Promise.all([
      backup.runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', `race1-${randomUUID()}`,
        '--slot', String(spareSlot), '--version', '1', '--expiry', String(spareCred.expiry),
        '--owner-sig', spareCred.ownerSig, '--json',
      ]),
      backup.runCliAsyncAllowFail([
        'redeem', '--role', 'gate', '--scan-id', `race2-${randomUUID()}`,
        '--slot', String(spareSlot), '--version', '1', '--expiry', String(spareCred.expiry),
        '--owner-sig', spareCred.ownerSig, '--json',
      ]),
    ]);
    const raceAdmits = [race1.data, race2.data].filter((r) => r?.gateDecision === 'ADMIT');
    const raceRejects = [race1.data, race2.data].filter((r) => r?.gateDecision === 'REJECT');
    check(raceAdmits.length === 1 && raceRejects.length === 1, `concurrent spare-slot scans must yield 1 ADMIT and 1 REJECT (got ${raceAdmits.length}/${raceRejects.length})`);

    // Primary edition remains intact and unaffected by backup edition
    const primaryFinal = primary.runCli(['status', '--json']);
    check(primaryFinal.contract === init.contract && primaryFinal.admittedCount === 1, 'primary edition must remain isolated and intact');

    console.log(JSON.stringify({
      judgeDemoCoreVerified: true,
      checksPassed,
      primaryContract: init.contract,
      backupContract: backupInit.contract,
    }, null, 2));
  } finally {
    await anvil.stop();
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
