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

export interface DistributedBotsResult {
  scenario: 'distributed_bots';
  eventSaleId: string;
  protectionsEnabled: boolean;
  bypassBotsTotal: number;
  unauthorizedBypassAttempts: number;
  unauthorizedCheckoutsSucceeded: number;
  linkedBotsTotal: number;
  linkedBotsFlagged: number;
  linkedBotsPrevented: number;
  behavioralStealthTotal: number;
  behavioralStealthFlagged: number;
  behavioralStealthPrevented: number;
  stealthBotsTotal: number;
  stealthBotsSucceeded: number;
  traces: ActorTrace[];
}

export function generateDistributedBotCohorts(): {
  bypassBots: SimActor[];
  linkedBots: SimActor[];
  behavioralStealthBots: SimActor[];
  stealthBots: SimActor[];
} {
  const bypassBots: SimActor[] = [];
  const modes: Array<SimActor['grantMode']> = [
    ...Array(5).fill('missing'),
    ...Array(5).fill('forged'),
    ...Array(5).fill('expired'),
    ...Array(3).fill('wrong_account'),
    ...Array(2).fill('replayed'),
  ];

  for (let i = 0; i < modes.length; i++) {
    const idx = i + 1;
    bypassBots.push({
      accountId: `bypass_bot_${idx}`,
      sessionId: `sess_bypass_${idx}`,
      group: 'queue_bypass_bot',
      groundTruthMalicious: true,
      deviceId: `device_bypass_${idx}`,
      networkId: `ip_bypass_${idx}`,
      paymentTokenHash: `pay_bypass_${idx}`,
      grantMode: modes[i],
    });
  }

  // 30 distributed linked bots: 5 clusters of 6 accounts linked via multi-hop device/payment chains
  const linkedBots: SimActor[] = [];
  for (let c = 0; c < 5; c++) {
    for (let m = 0; m < 6; m++) {
      const idx = c * 6 + m + 1;
      // Multi-hop chain: (m 0,1,2) share devA, (m 2,3,4) share payB, (m 4,5) share devC
      const deviceId = m <= 2 ? `dist_dev_${c}_a` : `dist_dev_${c}_b`;
      const paymentTokenHash = m >= 2 && m <= 4 ? `dist_pay_${c}_x` : `dist_pay_${c}_y`;
      linkedBots.push({
        accountId: `dist_bot_${idx}`,
        sessionId: `sess_dist_${idx}`,
        group: 'distributed_linked_bot',
        groundTruthMalicious: true,
        deviceId,
        networkId: `ip_dist_proxy_${idx}`,
        paymentTokenHash,
        grantMode: 'valid',
      });
    }
  }

  // 10 behavioral stealth bots: zero shared identifiers, valid grants, but robotic sub-second pacing
  const behavioralStealthBots: SimActor[] = [];
  for (let i = 1; i <= 10; i++) {
    behavioralStealthBots.push({
      accountId: `sniper_bot_${i}`,
      sessionId: `sess_sniper_${i}`,
      group: 'behavioral_stealth_bot',
      groundTruthMalicious: true,
      deviceId: `device_sniper_unique_${i}`,
      networkId: `ip_sniper_res_${i}`,
      paymentTokenHash: `pay_sniper_unique_${i}`,
      grantMode: 'valid',
    });
  }

  // 5 genuinely independent-looking stealth bots (honest limitation cohort: no shared graph identifiers & human pacing)
  const stealthBots: SimActor[] = [];
  for (let i = 1; i <= 5; i++) {
    stealthBots.push({
      accountId: `stealth_bot_${i}`,
      sessionId: `sess_stealth_${i}`,
      group: 'stealth_independent_bot',
      groundTruthMalicious: true,
      deviceId: `device_stealth_unique_${i}`,
      networkId: `ip_residential_unique_${i}`,
      paymentTokenHash: `pay_stealth_unique_${i}`,
      grantMode: 'valid',
    });
  }

  return { bypassBots, linkedBots, behavioralStealthBots, stealthBots };
}

export function runDistributedBotsScenario(options: {
  protectionsEnabled?: boolean;
  eventSaleId?: string;
  capacity?: number;
  baseTimeMs?: number;
  engine?: RiskEngine;
} = {}): DistributedBotsResult {
  const protectionsEnabled = options.protectionsEnabled ?? true;
  const eventSaleId = options.eventSaleId ?? 'concert_distributed';
  const capacity = options.capacity ?? 120;
  const baseTimeMs = options.baseTimeMs ?? Date.parse('2026-11-21T02:10:00+05:30');

  if (!options.engine) {
    resetSimEventCounter();
  }
  const engine = options.engine ?? new RiskEngine({ protectionsEnabled });
  engine.configureSale(eventSaleId, {
    capacity,
    requireQueueGrants: true,
    maxTicketsPerCluster: 3,
    maxActiveHoldsPerCluster: 2,
  });

  const { bypassBots, linkedBots, behavioralStealthBots, stealthBots } = generateDistributedBotCohorts();
  const traces: ActorTrace[] = [];

  // 1. OAT-006 Queue Bypass Bots
  let unauthorizedBypassAttempts = 0;
  let unauthorizedCheckoutsSucceeded = 0;

  for (let i = 0; i < bypassBots.length; i++) {
    const actor = bypassBots[i];
    const trace = createEmptyTrace(actor);
    const t0 = baseTimeMs + i * 100;

    if (actor.grantMode === 'missing') {
      unauthorizedBypassAttempts += 1;
      const checkout = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0, queueGrant: null })
      );
      recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
      if (checkout.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'forged') {
      unauthorizedBypassAttempts += 1;
      const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 }));
      recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
      const checkout = engine.evaluate(
        buildSecurityEvent({
          actor,
          eventType: 'CHECKOUT_ATTEMPT',
          eventSaleId,
          timestampMs: t0 + 100,
          queueGrant: 'eyJldmVudFNhbGVJZCI6ImNvbmNlcnQifQ.deadbeef0000',
        })
      );
      recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
      if (checkout.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'expired') {
      unauthorizedBypassAttempts += 1;
      const expiredGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        issuedAtMs: t0 - 120_000,
        ttlMs: 10_000,
      });
      const checkout = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0, queueGrant: expiredGrant })
      );
      recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
      if (checkout.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'wrong_account') {
      unauthorizedBypassAttempts += 1;
      const stolenGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: 'legit_victim_account',
        sessionId: 'sess_victim',
        issuedAtMs: t0,
      });
      const checkout = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 50, queueGrant: stolenGrant })
      );
      recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
      if (checkout.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'replayed') {
      const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 }));
      recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
      const validGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        issuedAtMs: t0,
      });
      // First legitimate checkout consumes the single-use grant
      const firstCheckout = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 100, queueGrant: validGrant })
      );
      recordDecisionInTrace(trace, firstCheckout, 'CHECKOUT_ATTEMPT');
      // Second checkout replays the already-consumed grant (unauthorized!)
      unauthorizedBypassAttempts += 1;
      const replayCheckout = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 200, queueGrant: validGrant })
      );
      recordDecisionInTrace(trace, replayCheckout, 'CHECKOUT_ATTEMPT');
      if (replayCheckout.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
      // Only treat as ticketAcquired from unauthorized attempt for bypass tracking; reset trace.ticketAcquired
      trace.ticketAcquired = replayCheckout.decision === 'ALLOW';
    }

    traces.push(trace);
  }

  // 2. Multi-hop linked distributed bots
  const linkedMap = new Map<string, ActorTrace>();
  for (let i = 0; i < linkedBots.length; i++) {
    const actor = linkedBots[i];
    const trace = createEmptyTrace(actor);
    linkedMap.set(actor.accountId, trace);
    const reg = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: baseTimeMs + 5_000 + i * 35 })
    );
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');
  }

  const linkedGrants = new Map<string, string | null>();
  for (let i = 0; i < linkedBots.length; i++) {
    const actor = linkedBots[i];
    const trace = linkedMap.get(actor.accountId) as ActorTrace;
    const tJoin = baseTimeMs + 8_000 + i * 35;
    const join = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: tJoin })
    );
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
    if (join.decision === 'ALLOW' || !engine.protectionsEnabled) {
      linkedGrants.set(
        actor.accountId,
        engine.issueQueueGrant({
          eventSaleId,
          accountId: actor.accountId,
          sessionId: actor.sessionId,
          issuedAtMs: tJoin,
        })
      );
    } else {
      const failVer = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'VERIFICATION_FAILED', eventSaleId, timestampMs: tJoin + 100 })
      );
      recordDecisionInTrace(trace, failVer, 'VERIFICATION_FAILED');
      linkedGrants.set(actor.accountId, null);
    }
  }

  for (let i = 0; i < linkedBots.length; i++) {
    const actor = linkedBots[i];
    const trace = linkedMap.get(actor.accountId) as ActorTrace;
    const checkout = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'CHECKOUT_ATTEMPT',
        eventSaleId,
        timestampMs: baseTimeMs + 10_000 + i * 35,
        queueGrant: linkedGrants.get(actor.accountId) ?? null,
      })
    );
    recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
    traces.push(trace);
  }

  // 3. Behavioral stealth bots (no shared graph IDs, valid grants, robotic sub-second pacing caught by ML)
  for (let i = 0; i < behavioralStealthBots.length; i++) {
    const actor = behavioralStealthBots[i];
    const trace = createEmptyTrace(actor);
    const t0 = baseTimeMs + 20_000 + i * 500;
    const reg = engine.evaluate(buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: t0 }));
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');

    const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 + 180 }));
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');

    const grant = engine.issueQueueGrant({
      eventSaleId,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      issuedAtMs: t0 + 180,
    });
    const resId = `res_sniper_${actor.accountId}_${eventSaleId}`;
    const res = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 360,
        queueGrant: grant,
        reservationId: resId,
      })
    );
    recordDecisionInTrace(trace, res, 'RESERVATION_CREATE');

    const checkout = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'CHECKOUT_ATTEMPT',
        eventSaleId,
        timestampMs: t0 + 540,
        queueGrant: grant,
        reservationId: resId,
      })
    );
    recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
    traces.push(trace);
  }

  // 4. Stealth independent-looking bots (honest boundary: distinct devices, payments, IPs, human timing)
  for (let i = 0; i < stealthBots.length; i++) {
    const actor = stealthBots[i];
    const trace = createEmptyTrace(actor);
    const t0 = baseTimeMs + 30_000 + i * 2_000;
    const reg = engine.evaluate(buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: t0 }));
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');

    const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 + 1_000 }));
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');

    const grant = engine.issueQueueGrant({
      eventSaleId,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      issuedAtMs: t0 + 1_000,
    });
    const checkout = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 3_000, queueGrant: grant })
    );
    recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
    traces.push(trace);
  }

  const linkedTraces = traces.filter((t) => t.group === 'distributed_linked_bot');
  const behavioralStealthTraces = traces.filter((t) => t.group === 'behavioral_stealth_bot');
  const stealthTraces = traces.filter((t) => t.group === 'stealth_independent_bot');

  return {
    scenario: 'distributed_bots',
    eventSaleId,
    protectionsEnabled,
    bypassBotsTotal: bypassBots.length,
    unauthorizedBypassAttempts,
    unauthorizedCheckoutsSucceeded,
    linkedBotsTotal: linkedBots.length,
    linkedBotsFlagged: linkedTraces.filter((t) => t.flagged).length,
    linkedBotsPrevented: linkedTraces.filter((t) => !t.ticketAcquired).length,
    behavioralStealthTotal: behavioralStealthBots.length,
    behavioralStealthFlagged: behavioralStealthTraces.filter((t) => t.flagged).length,
    behavioralStealthPrevented: behavioralStealthTraces.filter((t) => !t.ticketAcquired).length,
    stealthBotsTotal: stealthBots.length,
    stealthBotsSucceeded: stealthTraces.filter((t) => t.ticketAcquired).length,
    traces,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runDistributedBotsScenario({ protectionsEnabled: true });
  const { traces: _t, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}
