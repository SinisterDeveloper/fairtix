import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseCapacityConfig, runCapacityBenchmark } from '../simulator/capacity-benchmark.ts';
import { parseReplayConfig, runDefensiveReplay } from '../simulator/defensive-replay.ts';
import type { SecurityEventType } from '../src/events.ts';
import { RiskEngine } from '../src/risk-engine.ts';

test('all replay fixtures are repeatable and reconcile with backend inventory', () => {
  for (const fixture of ['scalping', 'inventory', 'queue']) {
    const config = parseReplayConfig({ fixture });
    const report = runDefensiveReplay(config);
    assert.deepEqual(runDefensiveReplay(config), report);
    assert.ok(report.eventCount <= 500);
    for (const run of [report.observe, report.enforce]) {
      assert.equal(run.available + run.held + run.sold, config.inventory);
      assert.equal(run.legitimateTicketsSold + run.maliciousTicketsSold, run.sold);
      assert.equal(run.unauthorizedCheckouts, 0);
      assert.ok(run.minimumAvailable >= 0);
      assert.equal(run.legitimateCompletion.numerator, run.legitimateCompletion.denominator);
      assert.equal(run.falsePositiveRate.numerator, 0);
    }
    if (fixture === 'scalping') {
      assert.ok(report.observe.maliciousTicketsSold > report.enforce.maliciousTicketsSold);
      assert.ok(report.observe.evidence.some((entry) => entry.reasons.includes('CLUSTER_PURCHASE_LIMIT_EXCEEDED')));
      assert.ok(report.enforce.evidence.some((entry) => !entry.hardFailure && entry.behavioralDecision !== 'ALLOW'));
      assert.ok(report.enforce.evidence.some((entry) =>
        entry.eventType === 'CHECKOUT_ATTEMPT' && entry.mlScore !== null &&
        entry.unsupervisedAnomalyScore !== null && entry.mlTopContributors.length > 0));
    }
    if (fixture === 'inventory') {
      assert.ok(report.observe.releasedHolds > 0);
      assert.ok(report.enforce.releasedHolds > 0);
      assert.ok(report.observe.evidence.some((entry) => entry.reasons.includes('HOLD_LIMIT_EXCEEDED')));
    }
    if (fixture === 'queue') {
      for (const run of [report.observe, report.enforce]) {
        const denial = run.evidence.find((entry) => entry.reasons.includes('QUEUE_BYPASS_ATTEMPT'));
        assert.equal(denial?.hardFailure, true);
        assert.equal(denial?.riskScore, 100);
        assert.equal(denial?.ticketsCommitted, 0);
      }
    }
  }
});

test('frozen learner and hard ticket caps apply in both behavioral modes', () => {
  const baseline = new RiskEngine().getBaselineStats();
  for (const behavioralMode of ['observe', 'enforce'] as const) {
    const engine = new RiskEngine({
      behavioralMode,
      unsupervisedOptions: { frozenSnapshot: baseline },
    });
    const saleId = 'cap-regression';
    engine.configureSale(saleId, { capacity: 10, maxTicketsPerAccount: 2, maxTicketsPerCluster: 4 });
    let eventNumber = 0;
    function evaluate(accountId: string, eventType: SecurityEventType, time: number, quantity?: number, reservationId?: string) {
      const eventId = `cap-${++eventNumber}`;
      return engine.evaluate({
        eventId, eventIdempotencyKey: eventId, accountId, sessionId: `session-${accountId}`,
        timestamp: new Date(Date.UTC(2026, 0, 1) + time).toISOString(), eventType,
        eventContext: {
          eventSaleId: saleId,
          deviceId: accountId.startsWith('linked') ? 'linked-device' : accountId,
          networkId: `network-${accountId}`,
          quantity, reservationId,
        },
      });
    }

    assert.equal(evaluate('solo', 'QUEUE_JOIN', 0).decision, 'ALLOW');
    assert.equal(evaluate('solo', 'RESERVATION_CREATE', 4000, 2, 'solo-hold').decision, 'ALLOW');
    assert.equal(evaluate('solo', 'CHECKOUT_ATTEMPT', 9000, 2, 'solo-hold').decision, 'ALLOW');
    const accountDenied = evaluate('solo', 'CHECKOUT_ATTEMPT', 14_000, 1);
    assert.equal(accountDenied.hardFailure, true);
    assert.ok(accountDenied.reasons.includes('ACCOUNT_PURCHASE_LIMIT_EXCEEDED'));

    assert.equal(evaluate('linked-c', 'QUEUE_JOIN', 20_000).decision, 'ALLOW');
    assert.equal(evaluate('linked-a', 'RESERVATION_CREATE', 30_000, 2, 'a-hold').decision, 'ALLOW');
    assert.equal(evaluate('linked-b', 'RESERVATION_CREATE', 40_000, 2, 'b-hold').decision, 'ALLOW');
    assert.equal(evaluate('linked-a', 'CHECKOUT_ATTEMPT', 50_000, 2, 'a-hold').decision, 'ALLOW');
    const clusterDenied = evaluate('linked-b', 'CHECKOUT_ATTEMPT', 60_000, 1);
    assert.equal(clusterDenied.hardFailure, true);
    assert.ok(clusterDenied.reasons.includes('CLUSTER_PURCHASE_LIMIT_EXCEEDED'));
    assert.equal(engine.getSaleState(saleId).soldInventory, 4);
    assert.deepEqual(engine.getBaselineStats(), baseline);
    assert.deepEqual(engine.exportLiveTraces(), []);
  }
});

test('separate clean sessions move the live learner toward the new baseline', () => {
  const engine = new RiskEngine();
  const initial = engine.getBaselineStats();
  const start = Date.UTC(2026, 0, 2);
  const events = [
    ['QUEUE_JOIN', 0],
    ['RESERVATION_CREATE', 29_750],
    ['CHECKOUT_ATTEMPT', 55_000],
  ] as const;

  for (const index of [0, 1, 2]) {
    const accountId = `drift-${index}`;
    for (const [eventType, offset] of events) {
      const eventId = `${accountId}-${eventType}`;
      const result = engine.evaluate({
        eventId,
        eventIdempotencyKey: eventId,
        accountId,
        sessionId: accountId,
        timestamp: new Date(start + index * 60_000 + offset).toISOString(),
        eventType,
        eventContext: { eventSaleId: 'clean-drift', reservationId: accountId },
      });
      assert.equal(result.decision, 'ALLOW');
    }
  }

  const learned = engine.getBaselineStats();
  assert.equal(learned.sampleCount, initial.sampleCount + 3);
  assert.ok(learned.means.queueToReserveMs > initial.means.queueToReserveMs);
  assert.ok(learned.means.queueToReserveMs <= 29_750);
});

test('CLI replay requires explicit enablement and validates configuration', () => {
  function run(enabled: string, args: string[]) {
    const child = spawnSync(process.execPath, ['src/cli.cjs', 'security-replay', ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, FAIRTICKETS_REPLAY_ENABLED: enabled },
    });
    return { status: child.status, payload: JSON.parse(child.stdout) };
  }
  assert.deepEqual(run('0', []), {
    status: 1,
    payload: { ok: false, error: 'Security replay is disabled.' },
  });
  assert.deepEqual(run('1', ['--participants', '51']), {
    status: 1,
    payload: { ok: false, error: 'participants must be an integer from 4 to 50.' },
  });
  const result = run('1', ['--fixture', 'queue', '--participants', '4']);
  assert.equal(result.status, 0);
  assert.equal(result.payload.enforce.unauthorizedCheckouts, 0);
});

test('capacity benchmark completes one sale across multiple waves', () => {
  assert.deepEqual(parseCapacityConfig({}), { buyers: 100_000, waveSize: 1024, buyersPerNetwork: 64 });
  assert.throws(() => parseCapacityConfig({ buyers: '100001' }), /buyers must be an integer/);
  assert.throws(() => parseCapacityConfig({ 'wave-size': '4097' }), /wave-size must be an integer/);
  assert.throws(() => parseCapacityConfig({ 'buyers-per-network': '0' }), /buyers-per-network must be an integer/);
  const report = runCapacityBenchmark(parseCapacityConfig({
    buyers: '1025',
    'wave-size': '512',
    'buyers-per-network': '128',
  }));
  assert.equal(report.ok, true);
  assert.equal(report.events, 3075);
  assert.equal(report.peakHeld, 512);
  assert.equal(report.buyersPerNetwork, 128);
  assert.equal(report.convertedHolds, 1025);
  assert.equal(report.sold, 1025);
  assert.equal(report.finalHeld, 0);
  assert.equal(report.unauthorizedCheckouts, 0);
});
