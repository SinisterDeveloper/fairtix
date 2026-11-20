import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runAccountFarmScenario } from '../simulator/account-farm.ts';
import { runIbmBenchmarkSuite } from '../simulator/benchmark-ibm.ts';
import { runDistributedBotsScenario } from '../simulator/distributed-bots.ts';
import { runReservationAttackScenario } from '../simulator/reservation-attack.ts';
import { RiskEngine } from '../src/risk-engine.ts';
import { createSecurityServer } from '../src/server.ts';

test('Contract validation, idempotency, and untrusted client override stripping', () => {
  const engine = new RiskEngine();

  const rawEvent = {
    eventId: 'evt_101',
    timestamp: '2026-11-21T01:32:00+05:30',
    eventType: 'QUEUE_JOIN',
    eventIdempotencyKey: 'join_101',
    accountId: 'user_42',
    sessionId: 'session_78',
    // Untrusted override fields that must be ignored
    riskScore: 99,
    decision: 'BLOCK',
    isEligible: true,
    eventContext: {
      eventSaleId: 'concert_1',
      deviceId: 'device_12',
      networkId: 'network_5',
      paymentTokenHash: null,
    },
  };

  const first = engine.evaluate(rawEvent);
  assert.equal(first.decision, 'ALLOW');
  assert.equal(first.riskScore, 0);
  assert.deepEqual(first.reasons, []);
  assert.match(first.decisionId, /^risk_\d+$/);

  // Replay with identical eventIdempotencyKey must return cached decision without double counting
  const replay = engine.evaluate({ ...rawEvent, eventId: 'evt_101_dup' });
  assert.equal(replay.decisionId, first.decisionId);
  assert.equal(engine.getStats().idempotentCacheHits, 1);
  assert.equal(engine.graph.getProfile('user_42')?.queueJoinCountBySale.get('concert_1'), 1);

  assert.throws(() => engine.evaluate({ eventId: '' }), /Invalid SecurityEvent/);
  assert.throws(
    () =>
      engine.evaluate({
        ...rawEvent,
        eventIdempotencyKey: 'bad_ts',
        timestamp: 'not-a-date',
      }),
    /ISO-8601/
  );
});

test('Milestone 1: detects 50-account farm across distinct IPs while keeping shared-Wi-Fi and family fans unaffected', () => {
  const result = runAccountFarmScenario({ protectionsEnabled: true });

  assert.equal(result.farmAccountsTotal, 50);
  assert.equal(result.farmAccountsFlagged, 50);
  assert.equal(result.farmAccountsChallengedOrBlocked, 50);
  assert.equal(result.farmCheckoutsSucceeded, 0);
  assert.equal(result.discoveredFarmClusters.length, 5);
  for (const cluster of result.discoveredFarmClusters) {
    assert.equal(cluster.accountCount, 10);
    assert.equal(cluster.distinctNetworkCount, 10);
  }

  // Zero false positives on 15 shared-Wi-Fi users and 2 household family members
  assert.equal(result.sharedWifiTotal, 15);
  assert.equal(result.sharedWifiFlagged, 0);
  assert.equal(result.sharedWifiCheckoutsSucceeded, 15);
  assert.equal(result.familyTotal, 2);
  assert.equal(result.familyFlagged, 0);
  assert.equal(result.familyCheckoutsSucceeded, 2);
});

test('OAT-006 Expediting: valid grant works; missing, forged, expired, cross-account, and replayed grants hard-block', () => {
  const engine = new RiskEngine();
  const saleId = 'concert_oat006';
  const baseMs = Date.parse('2026-11-21T03:00:00+05:30');
  engine.configureSale(saleId, { capacity: 10, requireQueueGrants: true });

  // Valid fan flow
  const fanJoin = engine.evaluate({
    eventId: 'e_fan_join',
    timestamp: new Date(baseMs).toISOString(),
    eventType: 'QUEUE_JOIN',
    eventIdempotencyKey: 'k_fan_join',
    accountId: 'legit_fan_1',
    sessionId: 'sess_legit_1',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'net_1', paymentTokenHash: 'pay_1' },
  });
  assert.equal(fanJoin.decision, 'ALLOW');

  const validGrant = engine.issueQueueGrant({
    eventSaleId: saleId,
    accountId: 'legit_fan_1',
    sessionId: 'sess_legit_1',
    issuedAtMs: baseMs,
    ttlMs: 60_000,
  });

  // Missing grant bypass attempt on clean account -> hard failure bypasses 0 behavioral risk
  const bypassMissing = engine.evaluate({
    eventId: 'e_bypass_missing',
    timestamp: new Date(baseMs + 500).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'k_bypass_missing',
    accountId: 'clean_looking_bypass',
    sessionId: 'sess_clean',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_clean', networkId: 'net_clean', paymentTokenHash: 'pay_clean', queueGrant: null },
  });
  assert.equal(bypassMissing.decision, 'BLOCK');
  assert.equal(bypassMissing.hardFailure, true);
  assert.ok(bypassMissing.reasons.includes('QUEUE_BYPASS_ATTEMPT'));

  // Forged grant
  const bypassForged = engine.evaluate({
    eventId: 'e_bypass_forged',
    timestamp: new Date(baseMs + 600).toISOString(),
    eventType: 'RESERVATION_CREATE',
    eventIdempotencyKey: 'k_bypass_forged',
    accountId: 'forger_1',
    sessionId: 'sess_forger_1',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_f', networkId: 'net_f', paymentTokenHash: 'pay_f', queueGrant: 'abc.def' },
  });
  assert.equal(bypassForged.decision, 'BLOCK');
  assert.equal(bypassForged.hardFailure, true);
  assert.ok(bypassForged.reasons.includes('INVALID_QUEUE_GRANT'));

  // Cross-account stolen grant
  const bypassStolen = engine.evaluate({
    eventId: 'e_bypass_stolen',
    timestamp: new Date(baseMs + 700).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'k_bypass_stolen',
    accountId: 'thief_1',
    sessionId: 'sess_thief_1',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_t', networkId: 'net_t', paymentTokenHash: 'pay_t', queueGrant: validGrant },
  });
  assert.equal(bypassStolen.decision, 'BLOCK');
  assert.ok(bypassStolen.reasons.includes('INVALID_QUEUE_GRANT'));

  // Expired grant
  const expiredGrant = engine.issueQueueGrant({
    eventSaleId: saleId,
    accountId: 'late_user',
    sessionId: 'sess_late',
    issuedAtMs: baseMs - 100_000,
    ttlMs: 10_000,
  });
  const bypassExpired = engine.evaluate({
    eventId: 'e_bypass_expired',
    timestamp: new Date(baseMs + 800).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'k_bypass_expired',
    accountId: 'late_user',
    sessionId: 'sess_late',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_l', networkId: 'net_l', paymentTokenHash: 'pay_l', queueGrant: expiredGrant },
  });
  assert.equal(bypassExpired.decision, 'BLOCK');
  assert.ok(bypassExpired.reasons.includes('EXPIRED_QUEUE_GRANT'));

  // Valid checkout consumes grant; replaying same grant fails
  const validCheckout = engine.evaluate({
    eventId: 'e_fan_ck',
    timestamp: new Date(baseMs + 1_000).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'k_fan_ck',
    accountId: 'legit_fan_1',
    sessionId: 'sess_legit_1',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'net_1', paymentTokenHash: 'pay_1', queueGrant: validGrant },
  });
  assert.equal(validCheckout.decision, 'ALLOW');

  const replayCheckout = engine.evaluate({
    eventId: 'e_fan_replay',
    timestamp: new Date(baseMs + 1_500).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'k_fan_replay',
    accountId: 'legit_fan_1',
    sessionId: 'sess_legit_1',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'net_1', paymentTokenHash: 'pay_1', queueGrant: validGrant },
  });
  assert.equal(replayCheckout.decision, 'BLOCK');
  assert.equal(replayCheckout.hardFailure, true);
  assert.ok(replayCheckout.reasons.includes('REPLAYED_QUEUE_GRANT'));
});

test('OAT-021 Inventory Abuse: hold limits, abandonment scoring (+25), exact-once expiry restoration, and zero oversell', () => {
  const result = runReservationAttackScenario({ protectionsEnabled: true, capacity: 25, hoarderCount: 15, concurrentBuyers: 60 });

  assert.equal(result.hoarderBotsFlagged, 15);
  assert.equal(result.hoarderBotsBlockedOnHoldLimitOrAbandonment, 15);
  assert.equal(result.exactOnceRestorations, result.expiredHoldsTotal);
  assert.equal(result.duplicateReleaseAttemptsIgnored, 30);
  assert.equal(result.availableAfterExpirySweep, 25);
  assert.equal(result.ticketsSold, 25);
  assert.equal(result.oversoldTickets, 0);
});

test('OAT-019 & OAT-005: multi-hop BFS linkage, score weights, score capping at 100, and shared-IP isolation', () => {
  const engine = new RiskEngine();
  const saleId = 'concert_graph';
  const t0 = Date.parse('2026-11-21T04:00:00+05:30');
  engine.configureSale(saleId, { capacity: 50, maxTicketsPerCluster: 3, requireQueueGrants: false });

  // Multi-hop chain: A --dev1-- B --pay1-- C, all on distinct IPs and sessions
  engine.evaluate({
    eventId: 'g1',
    timestamp: new Date(t0).toISOString(),
    eventType: 'ACCOUNT_REGISTER',
    eventIdempotencyKey: 'gk1',
    accountId: 'acc_A',
    sessionId: 's_A',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'ip_1', paymentTokenHash: 'pay_0' },
  });
  engine.evaluate({
    eventId: 'g2',
    timestamp: new Date(t0 + 100).toISOString(),
    eventType: 'ACCOUNT_REGISTER',
    eventIdempotencyKey: 'gk2',
    accountId: 'acc_B',
    sessionId: 's_B',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'ip_2', paymentTokenHash: 'pay_1' },
  });
  const regC = engine.evaluate({
    eventId: 'g3',
    timestamp: new Date(t0 + 200).toISOString(),
    eventType: 'ACCOUNT_REGISTER',
    eventIdempotencyKey: 'gk3',
    accountId: 'acc_C',
    sessionId: 's_C',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_2', networkId: 'ip_3', paymentTokenHash: 'pay_1' },
  });
  assert.equal(regC.clusterSummary?.accountCount, 3);
  assert.equal(regC.clusterSummary?.distinctNetworkCount, 3);

  // Add queue join burst + duplicate entry + failed verification + abandonment -> score capped at 100
  engine.evaluate({
    eventId: 'g4',
    timestamp: new Date(t0 + 300).toISOString(),
    eventType: 'QUEUE_JOIN',
    eventIdempotencyKey: 'gk4',
    accountId: 'acc_A',
    sessionId: 's_A',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'ip_1', paymentTokenHash: 'pay_0' },
  });
  engine.evaluate({
    eventId: 'g5',
    timestamp: new Date(t0 + 400).toISOString(),
    eventType: 'VERIFICATION_FAILED',
    eventIdempotencyKey: 'gk5',
    accountId: 'acc_B',
    sessionId: 's_B',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_1', networkId: 'ip_2', paymentTokenHash: 'pay_1' },
  });
  engine.evaluate({
    eventId: 'g6',
    timestamp: new Date(t0 + 500).toISOString(),
    eventType: 'RESERVATION_ABANDON',
    eventIdempotencyKey: 'gk6',
    accountId: 'acc_C',
    sessionId: 's_C',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_2', networkId: 'ip_3', paymentTokenHash: 'pay_1', reservationId: 'none_1' },
  });
  engine.evaluate({
    eventId: 'g7',
    timestamp: new Date(t0 + 600).toISOString(),
    eventType: 'RESERVATION_ABANDON',
    eventIdempotencyKey: 'gk7',
    accountId: 'acc_C',
    sessionId: 's_C',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_2', networkId: 'ip_3', paymentTokenHash: 'pay_1', reservationId: 'none_2' },
  });
  engine.evaluate({
    eventId: 'g8',
    timestamp: new Date(t0 + 700).toISOString(),
    eventType: 'QUEUE_JOIN',
    eventIdempotencyKey: 'gk8',
    accountId: 'acc_C',
    sessionId: 's_C',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_2', networkId: 'ip_3', paymentTokenHash: 'pay_1' },
  });
  const dupJoinC = engine.evaluate({
    eventId: 'g9',
    timestamp: new Date(t0 + 800).toISOString(),
    eventType: 'QUEUE_JOIN',
    eventIdempotencyKey: 'gk9',
    accountId: 'acc_C',
    sessionId: 's_C',
    eventContext: { eventSaleId: saleId, deviceId: 'dev_2', networkId: 'ip_3', paymentTokenHash: 'pay_1' },
  });
  assert.equal(dupJoinC.decision, 'BLOCK');
  assert.equal(dupJoinC.riskScore, 100);
  assert.ok(dupJoinC.reasons.includes('LINKED_ACCOUNT_CLUSTER'));
  assert.ok(dupJoinC.reasons.includes('UNUSUAL_REGISTRATION_VELOCITY'));
  assert.ok(dupJoinC.reasons.includes('ABNORMAL_SESSION_VELOCITY'));
  assert.ok(dupJoinC.reasons.includes('PREVIOUSLY_FAILED_VERIFICATION'));
  assert.ok(dupJoinC.reasons.includes('REPEATED_DUPLICATE_ENTRY'));

  // Shared IP users remain isolated solo components
  for (let i = 1; i <= 5; i++) {
    const wifiRes = engine.evaluate({
      eventId: `w_${i}`,
      timestamp: new Date(t0 + 1_000 + i * 50).toISOString(),
      eventType: 'QUEUE_JOIN',
      eventIdempotencyKey: `wk_${i}`,
      accountId: `wifi_${i}`,
      sessionId: `ws_${i}`,
      eventContext: { eventSaleId: saleId, deviceId: `wdev_${i}`, networkId: 'campus_wifi', paymentTokenHash: `wpay_${i}` },
    });
    assert.equal(wifiRes.decision, 'ALLOW');
    assert.equal(wifiRes.riskScore, 0);
    assert.equal(wifiRes.clusterSummary?.accountCount, 1);
  }

  // Benign 2-account family sharing device & payment spaced apart -> ALLOW (riskScore 0)
  const fam1 = engine.evaluate({
    eventId: 'fam_1',
    timestamp: new Date(t0 + 10_000).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'fk_1',
    accountId: 'fam_member_1',
    sessionId: 'fs_1',
    eventContext: { eventSaleId: saleId, deviceId: 'fam_ipad', networkId: 'home_ip', paymentTokenHash: 'fam_card' },
  });
  const fam2 = engine.evaluate({
    eventId: 'fam_2',
    timestamp: new Date(t0 + 40_000).toISOString(),
    eventType: 'CHECKOUT_ATTEMPT',
    eventIdempotencyKey: 'fk_2',
    accountId: 'fam_member_2',
    sessionId: 'fs_2',
    eventContext: { eventSaleId: saleId, deviceId: 'fam_ipad', networkId: 'home_ip', paymentTokenHash: 'fam_card' },
  });
  assert.equal(fam1.decision, 'ALLOW');
  assert.equal(fam2.decision, 'ALLOW');
  assert.equal(fam2.riskScore, 0);
  assert.equal(fam2.clusterSummary?.isBenignHousehold, true);
});

test('HTTP security server + concurrent purchase burst handles 100 simultaneous checkouts with 0 oversell', async () => {
  const engine = new RiskEngine();
  const server = createSecurityServer(engine);

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    const cfgRes = await fetch(`${baseUrl}/sales/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSaleId: 'concert_http', capacity: 25, requireQueueGrants: true }),
    });
    assert.equal(cfgRes.status, 200);

    const ts = Date.parse('2026-11-21T05:00:00+05:30');
    const grants = await Promise.all(
      Array.from({ length: 100 }, async (_, idx) => {
        const i = idx + 1;
        const gRes = await fetch(`${baseUrl}/grants/issue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            eventSaleId: 'concert_http',
            accountId: `http_fan_${i}`,
            sessionId: `http_sess_${i}`,
            issuedAtMs: ts,
          }),
        });
        const gJson = (await gRes.json()) as { queueGrant: string };
        return gJson.queueGrant;
      })
    );

    const checkoutResponses = await Promise.all(
      Array.from({ length: 100 }, async (_, idx) => {
        const i = idx + 1;
        const res = await fetch(`${baseUrl}/evaluate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            eventId: `http_evt_${i}`,
            timestamp: new Date(ts + 1_000).toISOString(),
            eventType: 'CHECKOUT_ATTEMPT',
            eventIdempotencyKey: `http_idem_${i}`,
            accountId: `http_fan_${i}`,
            sessionId: `http_sess_${i}`,
            eventContext: {
              eventSaleId: 'concert_http',
              deviceId: `http_dev_${i}`,
              networkId: `http_net_${i}`,
              paymentTokenHash: `http_pay_${i}`,
              queueGrant: grants[idx],
            },
          }),
        });
        return (await res.json()) as { decision: string; reasons: string[] };
      })
    );

    const allowed = checkoutResponses.filter((r) => r.decision === 'ALLOW').length;
    const exhausted = checkoutResponses.filter((r) => r.reasons.includes('INVENTORY_EXHAUSTED')).length;
    assert.equal(allowed, 25);
    assert.equal(exhausted, 75);
    assert.equal(engine.getSaleState('concert_http').soldInventory, 25);

    const auditRes = await fetch(`${baseUrl}/audit`);
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as { ok: boolean; decisions: unknown[] };
    assert.equal(auditJson.ok, true);
    assert.equal(auditJson.decisions.length, 100);
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
});

test('Distributed bots scenario and full IBM Baseline vs Protected benchmark pass all 7 targets', () => {
  const dist = runDistributedBotsScenario({ protectionsEnabled: true });
  assert.equal(dist.unauthorizedCheckoutsSucceeded, 0);
  assert.equal(dist.linkedBotsFlagged, 30);
  assert.equal(dist.linkedBotsPrevented, 30);
  assert.equal(dist.stealthBotsSucceeded, 5);

  const report = runIbmBenchmarkSuite();
  for (const target of report.ibmTargets) {
    assert.equal(target.passed, true, `IBM target failed: ${target.target} (${target.observed})`);
  }
  assert.equal(report.protected.classification.precision, 1);
  assert.equal(report.protected.classification.recallLinkableAndPolicy, 1);
  assert.ok(report.protected.classification.recallOverall >= 0.95);
  assert.equal(report.protected.classification.falsePositiveRate, 0);
  assert.equal(report.protected.classification.sharedWifiFalsePositiveRate, 0);
  assert.equal(report.deltas.unauthorizedCheckoutsPrevented, 20);
  assert.ok(report.deltas.legitimateFanTicketsGained >= 60);
});

test('CLI integration: security-eval (cumulative), demo-attack account-farm, and security-benchmark', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const cliPath = join(repoRoot, 'src', 'cli.cjs');
  const tempStateDir = mkdtempSync(join(tmpdir(), 'fairtickets-sec-cli-'));

  try {
    const env = { ...process.env, FAIRTICKETS_STATE_DIR: tempStateDir };

    const ev1 = JSON.stringify({
      eventId: 'cli_evt_1',
      timestamp: '2026-11-21T01:32:00+05:30',
      eventType: 'QUEUE_JOIN',
      eventIdempotencyKey: 'cli_k_1',
      accountId: 'cli_user_1',
      sessionId: 'cli_sess_1',
      eventContext: { eventSaleId: 'concert_cli', deviceId: 'cli_dev_shared', networkId: 'net_1', paymentTokenHash: null },
    });
    const out1 = JSON.parse(execFileSync(process.execPath, [cliPath, 'security-eval', '--event', ev1, '--json'], { cwd: repoRoot, env, encoding: 'utf8' }));
    assert.equal(out1.ok, true);
    assert.equal(out1.decision, 'ALLOW');

    const ev2 = JSON.stringify({
      eventId: 'cli_evt_2',
      timestamp: '2026-11-21T01:32:01+05:30',
      eventType: 'QUEUE_JOIN',
      eventIdempotencyKey: 'cli_k_2',
      accountId: 'cli_user_2',
      sessionId: 'cli_sess_2',
      eventContext: { eventSaleId: 'concert_cli', deviceId: 'cli_dev_shared', networkId: 'net_2', paymentTokenHash: null },
    });
    const out2 = JSON.parse(execFileSync(process.execPath, [cliPath, 'security-eval', '--event', ev2, '--json'], { cwd: repoRoot, env, encoding: 'utf8' }));
    assert.equal(out2.ok, true);
    assert.equal(out2.decision, 'CHALLENGE');
    assert.ok(out2.reasons.includes('LINKED_ACCOUNT_CLUSTER'));
    assert.ok(out2.supportingEventIds.includes('cli_evt_1'));

    const farmOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'demo-attack', '--scenario', 'account-farm', '--json'], { cwd: repoRoot, env, encoding: 'utf8' }));
    assert.equal(farmOut.ok, true);
    assert.equal(farmOut.scenario, 'account-farm');
    assert.equal(farmOut.farmAccountsFlagged, 50);
    assert.equal(farmOut.sharedWifiFlagged, 0);

    const benchOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'security-benchmark', '--json'], { cwd: repoRoot, env, encoding: 'utf8' }));
    assert.equal(benchOut.ok, true);
    assert.equal(benchOut.ibmTargets.every((t: { passed: boolean }) => t.passed), true);
  } finally {
    rmSync(tempStateDir, { recursive: true, force: true });
  }
});
