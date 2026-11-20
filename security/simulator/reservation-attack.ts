import { pathToFileURL } from 'node:url';
import { RiskEngine } from '../src/risk-engine.ts';
import {
  buildSecurityEvent,
  createEmptyTrace,
  recordDecisionInTrace,
  resetSimEventCounter,
  type ActorTrace,
  type SimActor,
} from './legitimate-users.ts';

export interface ReservationAttackResult {
  scenario: 'oat021_reservation_and_concurrency';
  eventSaleId: string;
  protectionsEnabled: boolean;
  capacity: number;
  hoarderBotsTotal: number;
  hoarderBotsFlagged: number;
  hoarderBotsBlockedOnHoldLimitOrAbandonment: number;
  expiredHoldsTotal: number;
  exactOnceRestorations: number;
  duplicateReleaseAttemptsIgnored: number;
  availableAfterExpirySweep: number;
  concurrentCheckoutRequests: number;
  ticketsSold: number;
  oversoldTickets: number;
  traces: ActorTrace[];
}

export function generateHoarderBots(count = 15): SimActor[] {
  const bots: SimActor[] = [];
  for (let i = 1; i <= count; i++) {
    bots.push({
      accountId: `hoarder_bot_${i}`,
      sessionId: `sess_hoarder_${i}`,
      group: 'inventory_hoarder_bot',
      groundTruthMalicious: true,
      deviceId: `device_hoarder_${i}`,
      networkId: `ip_hoarder_${i}`,
      paymentTokenHash: `pay_hoarder_${i}`,
      grantMode: 'valid',
    });
  }
  return bots;
}

/**
 * Runs OAT-021 Denial of Inventory (reservation hoarding & abandonment)
 * followed by a concurrent checkout burst exceeding capacity to prove:
 * 1) Every expired/abandoned hold releases inventory exactly once.
 * 2) Repeated reservation abandoners are detected and restricted.
 * 3) Concurrent purchases produce 0 oversold tickets.
 */
export function runReservationAttackScenario(options: {
  protectionsEnabled?: boolean;
  eventSaleId?: string;
  capacity?: number;
  hoarderCount?: number;
  concurrentBuyers?: number;
  baseTimeMs?: number;
  engine?: RiskEngine;
} = {}): ReservationAttackResult {
  const protectionsEnabled = options.protectionsEnabled ?? true;
  const eventSaleId = options.eventSaleId ?? 'concert_oat021';
  const capacity = options.capacity ?? 25;
  const hoarderCount = options.hoarderCount ?? 15;
  const concurrentBuyers = options.concurrentBuyers ?? 60;
  const baseTimeMs = options.baseTimeMs ?? Date.parse('2026-11-21T02:20:00+05:30');

  if (!options.engine) {
    resetSimEventCounter();
  }
  const engine = options.engine ?? new RiskEngine({ protectionsEnabled });
  engine.configureSale(eventSaleId, {
    capacity,
    holdTtlMs: 30_000,
    maxActiveHoldsPerAccount: 1,
    maxActiveHoldsPerCluster: 2,
    requireQueueGrants: true,
  });

  const hoarders = generateHoarderBots(hoarderCount);
  const traces: ActorTrace[] = [];
  let expiredHoldsTotal = 0;

  for (let i = 0; i < hoarders.length; i++) {
    const actor = hoarders[i];
    const trace = createEmptyTrace(actor);
    const t0 = baseTimeMs + i * 100;

    const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 }));
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');

    const grant = engine.issueQueueGrant({
      eventSaleId,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      issuedAtMs: t0,
      ttlMs: 600_000,
    });

    // Hold 1: created and then simultaneously attempts Hold 2 (triggers HOLD_LIMIT_EXCEEDED)
    const res1Id = `res_h1_${actor.accountId}`;
    const res1 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 200,
        queueGrant: grant,
        reservationId: res1Id,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res1, 'RESERVATION_CREATE');

    const res2Id = `res_h2_${actor.accountId}`;
    const res2 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 300,
        queueGrant: grant,
        reservationId: res2Id,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res2, 'RESERVATION_CREATE');

    // Let Hold 1 expire (+35s > 30s TTL) AND send a duplicate RESERVATION_EXPIRE to prove exact-once restoration
    if (res1.decision === 'ALLOW') {
      expiredHoldsTotal += 1;
    }
    const exp1 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_EXPIRE',
        eventSaleId,
        timestampMs: t0 + 35_000,
        reservationId: res1Id,
      })
    );
    recordDecisionInTrace(trace, exp1, 'RESERVATION_EXPIRE');

    const expDup = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_EXPIRE',
        eventSaleId,
        timestampMs: t0 + 35_100,
        reservationId: res1Id,
      })
    );
    recordDecisionInTrace(trace, expDup, 'RESERVATION_EXPIRE');

    // Hold 3: created and explicitly abandoned
    const res3Id = `res_h3_${actor.accountId}`;
    const res3 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 36_000,
        queueGrant: grant,
        reservationId: res3Id,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res3, 'RESERVATION_CREATE');
    if (res3.decision === 'ALLOW') {
      expiredHoldsTotal += 1;
    }

    const abandon3 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_ABANDON',
        eventSaleId,
        timestampMs: t0 + 37_000,
        reservationId: res3Id,
      })
    );
    recordDecisionInTrace(trace, abandon3, 'RESERVATION_ABANDON');

    // Hold 4: after 2 abandonments (+25) + prior failed verification or repeated hold limit -> blocked/challenged
    const failVer = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'VERIFICATION_FAILED',
        eventSaleId,
        timestampMs: t0 + 37_500,
      })
    );
    recordDecisionInTrace(trace, failVer, 'VERIFICATION_FAILED');

    const res4 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 38_000,
        queueGrant: grant,
        reservationId: `res_h4_${actor.accountId}`,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res4, 'RESERVATION_CREATE');

    traces.push(trace);
  }

  // Sweep all expired holds after hoarder phase
  const sweepTimeMs = baseTimeMs + 120_000;
  engine.inventory.sweepExpiredHolds(eventSaleId, sweepTimeMs);
  const stateBeforeBurst = engine.getSaleState(eventSaleId);
  const availableAfterExpirySweep = stateBeforeBurst.availableInventory;
  const exactOnceRestorations = stateBeforeBurst.exactOnceReleaseCount;
  const duplicateReleaseAttemptsIgnored = stateBeforeBurst.duplicateReleaseAttemptsIgnored;

  // Concurrent purchase burst of 60 distinct fans competing for `capacity` seats
  for (let b = 1; b <= concurrentBuyers; b++) {
    const actor: SimActor = {
      accountId: `burst_buyer_${b}`,
      sessionId: `sess_burst_${b}`,
      group: 'solo_fan',
      groundTruthMalicious: false,
      deviceId: `device_burst_${b}`,
      networkId: `ip_burst_${b}`,
      paymentTokenHash: `pay_burst_${b}`,
      grantMode: 'valid',
    };
    const tBurst = sweepTimeMs + 1_000;
    const grant = engine.issueQueueGrant({
      eventSaleId,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      issuedAtMs: tBurst,
    });
    engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'CHECKOUT_ATTEMPT',
        eventSaleId,
        timestampMs: tBurst,
        queueGrant: grant,
      })
    );
  }

  const finalState = engine.getSaleState(eventSaleId);
  const oversoldTickets = Math.max(0, finalState.soldInventory - finalState.capacity);

  return {
    scenario: 'oat021_reservation_and_concurrency',
    eventSaleId,
    protectionsEnabled,
    capacity,
    hoarderBotsTotal: hoarders.length,
    hoarderBotsFlagged: traces.filter((t) => t.flagged).length,
    hoarderBotsBlockedOnHoldLimitOrAbandonment: traces.filter((t) => t.blocked || t.hardFailed).length,
    expiredHoldsTotal,
    exactOnceRestorations,
    duplicateReleaseAttemptsIgnored,
    availableAfterExpirySweep,
    concurrentCheckoutRequests: concurrentBuyers,
    ticketsSold: finalState.soldInventory,
    oversoldTickets,
    traces,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runReservationAttackScenario({ protectionsEnabled: true });
  const { traces: _t, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}
