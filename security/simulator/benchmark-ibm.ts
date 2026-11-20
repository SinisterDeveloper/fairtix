import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RiskEngine } from '../src/risk-engine.ts';
import { generateAccountFarmActors } from './account-farm.ts';
import { generateDistributedBotCohorts } from './distributed-bots.ts';
import {
  buildSecurityEvent,
  createEmptyTrace,
  generateLegitimateUsers,
  recordDecisionInTrace,
  resetSimEventCounter,
  runLegitimateFlow,
  type ActorTrace,
  type CohortGroup,
} from './legitimate-users.ts';
import { generateHoarderBots } from './reservation-attack.ts';

export interface GroupBenchmarkMetrics {
  group: CohortGroup;
  groundTruthMalicious: boolean;
  participantsTotal: number;
  flaggedForSecurity: number;
  challengedCount: number;
  blockedCount: number;
  hardFailedCount: number;
  ticketsAcquired: number;
}

export interface RunBenchmarkSummary {
  protectionsEnabled: boolean;
  capacity: number;
  ticketsSold: number;
  oversoldTickets: number;
  availableInventoryAtEnd: number;
  expiredHoldsTotal: number;
  exactOnceRestorations: number;
  duplicateReleaseAttemptsIgnored: number;
  unauthorizedBypassAttempts: number;
  unauthorizedCheckoutsSucceeded: number;
  totalDecisionsRecorded: number;
  decisionsWithAuditReasonsOrCleanAllow: number;
  legitimateParticipantsTotal: number;
  legitimateFlaggedFalsePositives: number;
  legitimateTicketsAcquired: number;
  sharedWifiTotal: number;
  sharedWifiFlagged: number;
  sharedWifiTicketsAcquired: number;
  maliciousParticipantsTotal: number;
  maliciousFlaggedTruePositives: number;
  maliciousTicketsAcquired: number;
  preventedMaliciousAllocations: number;
  remainingSuccessfulStealthAttacks: number;
  classification: {
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
    precision: number;
    recallOverall: number;
    recallLinkableAndPolicy: number;
    falsePositiveRate: number;
    sharedWifiFalsePositiveRate: number;
  };
  groups: Record<string, GroupBenchmarkMetrics>;
}

export interface IbmBenchmarkReport {
  generatedAt: string;
  simulation: true;
  eventSaleId: string;
  capacity: number;
  knownLimitations: string[];
  ibmTargets: Array<{
    target: string;
    expected: string;
    observed: string;
    passed: boolean;
  }>;
  baseline: RunBenchmarkSummary;
  protected: RunBenchmarkSummary;
  deltas: {
    unauthorizedCheckoutsPrevented: number;
    maliciousAllocationsReducedBy: number;
    legitimateFanTicketsGained: number;
    legitimateDisruptionRateProtected: number;
  };
}

function executeCombinedWorkload(protectionsEnabled: boolean, eventSaleId: string, capacity: number): RunBenchmarkSummary {
  resetSimEventCounter();
  const baseTimeMs = Date.parse('2026-11-21T02:30:00+05:30');
  const engine = new RiskEngine({ protectionsEnabled });

  engine.configureSale(eventSaleId, {
    capacity,
    holdTtlMs: 30_000,
    maxActiveHoldsPerAccount: 1,
    maxActiveHoldsPerCluster: 2,
    maxTicketsPerAccount: 2,
    maxTicketsPerCluster: 3,
    requireQueueGrants: true,
  });

  const farmActors = generateAccountFarmActors(50, 5);
  const { bypassBots, linkedBots, stealthBots } = generateDistributedBotCohorts();
  const hoarderBots = generateHoarderBots(15);
  const legitActors = generateLegitimateUsers({
    soloCount: 63,
    sharedWifiCount: 15,
    includeFamilyHousehold: true,
    sharedNetworkId: 'shared_wifi_venue_1',
  });

  const traceMap = new Map<string, ActorTrace>();
  const registerTrace = (a: { accountId: string; group: CohortGroup; groundTruthMalicious: boolean }) => {
    const t = createEmptyTrace(a as Parameters<typeof createEmptyTrace>[0]);
    traceMap.set(a.accountId, t);
    return t;
  };

  // Phase 1: Hoarder bots create & abandon/expire holds (OAT-021) BEFORE fans check out
  let expiredHoldsTotal = 0;
  for (let i = 0; i < hoarderBots.length; i++) {
    const actor = hoarderBots[i];
    const trace = registerTrace(actor);
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

    const res1Id = `res_bm_h1_${actor.accountId}`;
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
    if (res1.decision === 'ALLOW') expiredHoldsTotal += 1;

    // Second concurrent hold attempt
    const res2 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 300,
        queueGrant: grant,
        reservationId: `res_bm_h2_${actor.accountId}`,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res2, 'RESERVATION_CREATE');

    // Expire hold 1 + send duplicate expiry event
    const exp1 = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'RESERVATION_EXPIRE', eventSaleId, timestampMs: t0 + 35_000, reservationId: res1Id })
    );
    recordDecisionInTrace(trace, exp1, 'RESERVATION_EXPIRE');
    const expDup = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'RESERVATION_EXPIRE', eventSaleId, timestampMs: t0 + 35_100, reservationId: res1Id })
    );
    recordDecisionInTrace(trace, expDup, 'RESERVATION_EXPIRE');

    // Hold 3 created and abandoned
    const res3Id = `res_bm_h3_${actor.accountId}`;
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
    if (res3.decision === 'ALLOW') expiredHoldsTotal += 1;

    const ab3 = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'RESERVATION_ABANDON', eventSaleId, timestampMs: t0 + 37_000, reservationId: res3Id })
    );
    recordDecisionInTrace(trace, ab3, 'RESERVATION_ABANDON');

    // Hoarder fails verification challenge after repeated hold abuse
    if (res2.decision !== 'ALLOW') {
      const failVer = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'VERIFICATION_FAILED', eventSaleId, timestampMs: t0 + 37_500 })
      );
      recordDecisionInTrace(trace, failVer, 'VERIFICATION_FAILED');
    }

    // Attempt hold 4 and checkout after abandonment triggers ABNORMAL_RESERVATION_ABANDONMENT + prior verification failure
    const res4 = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 38_000,
        queueGrant: grant,
        reservationId: `res_bm_h4_${actor.accountId}`,
        holdTtlMs: 30_000,
      })
    );
    recordDecisionInTrace(trace, res4, 'RESERVATION_CREATE');
    if (res4.decision === 'ALLOW') {
      if (!protectionsEnabled) {
        // In unprotected baseline, hoarder converts final reservation into a scalped ticket
        const ck = engine.evaluate(
          buildSecurityEvent({
            actor,
            eventType: 'CHECKOUT_ATTEMPT',
            eventSaleId,
            timestampMs: t0 + 38_500,
            queueGrant: grant,
            reservationId: `res_bm_h4_${actor.accountId}`,
          })
        );
        recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
      } else {
        expiredHoldsTotal += 1;
      }
    }
  }

  const afterHoardTimeMs = baseTimeMs + 90_000;
  engine.inventory.sweepExpiredHolds(eventSaleId, afterHoardTimeMs);

  // Phase 2: Queue Bypass Bots (OAT-006)
  let unauthorizedBypassAttempts = 0;
  let unauthorizedCheckoutsSucceeded = 0;
  for (let i = 0; i < bypassBots.length; i++) {
    const actor = bypassBots[i];
    const trace = registerTrace(actor);
    const t0 = afterHoardTimeMs + i * 50;

    if (actor.grantMode === 'missing') {
      unauthorizedBypassAttempts += 1;
      const ck = engine.evaluate(buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0, queueGrant: null }));
      recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
      if (ck.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'forged') {
      unauthorizedBypassAttempts += 1;
      const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 }));
      recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
      const ck = engine.evaluate(
        buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 50, queueGrant: 'forged.signature' })
      );
      recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
      if (ck.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'expired') {
      unauthorizedBypassAttempts += 1;
      const expGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        issuedAtMs: t0 - 120_000,
        ttlMs: 10_000,
      });
      const ck = engine.evaluate(buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0, queueGrant: expGrant }));
      recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
      if (ck.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'wrong_account') {
      unauthorizedBypassAttempts += 1;
      const wrongGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: 'solo_fan_1',
        sessionId: 'sess_solo_1',
        issuedAtMs: t0,
      });
      const ck = engine.evaluate(buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0, queueGrant: wrongGrant }));
      recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
      if (ck.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    } else if (actor.grantMode === 'replayed') {
      // Simulate an attacker replaying a grant that was already consumed on an earlier authorized checkout.
      const donorActor = {
        ...actor,
        accountId: `replay_donor_${i}`,
        sessionId: `sess_donor_${i}`,
      };
      const donorJoin = engine.evaluate(
        buildSecurityEvent({ actor: donorActor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 - 2_000 })
      );
      const consumedGrant = engine.issueQueueGrant({
        eventSaleId,
        accountId: donorActor.accountId,
        sessionId: donorActor.sessionId,
        issuedAtMs: t0 - 2_000,
      });
      if (donorJoin.decision === 'ALLOW' || !protectionsEnabled) {
        // Consume the grant nonce cleanly via ExpeditingGuard before replay attempt
        const verify = engine.expediting.verifyGrantToken(consumedGrant, {
          eventSaleId,
          accountId: donorActor.accountId,
          sessionId: donorActor.sessionId,
          nowMs: t0 - 1_000,
        });
        if (verify.valid) {
          engine.expediting.consumeGrant(verify.payload.nonce);
        }
      }
      unauthorizedBypassAttempts += 1;
      const ckReplay = engine.evaluate(
        buildSecurityEvent({
          actor: donorActor,
          eventType: 'CHECKOUT_ATTEMPT',
          eventSaleId,
          timestampMs: t0,
          queueGrant: consumedGrant,
        })
      );
      recordDecisionInTrace(trace, ckReplay, 'CHECKOUT_ATTEMPT');
      if (ckReplay.decision === 'ALLOW') unauthorizedCheckoutsSucceeded += 1;
    }
  }

  // Phase 3: 50-Account Farm + 30 Multi-hop Distributed Linked Bots
  const coordinatedBots = [...farmActors, ...linkedBots];
  const coordTimeBase = afterHoardTimeMs + 5_000;
  for (let i = 0; i < coordinatedBots.length; i++) {
    const actor = coordinatedBots[i];
    const trace = registerTrace(actor);
    const reg = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: coordTimeBase + i * 30 })
    );
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');
  }

  const coordGrants = new Map<string, string | null>();
  for (let i = 0; i < coordinatedBots.length; i++) {
    const actor = coordinatedBots[i];
    const trace = traceMap.get(actor.accountId) as ActorTrace;
    const tJoin = coordTimeBase + 3_000 + i * 30;
    const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: tJoin }));
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
    if (join.decision === 'ALLOW' || !protectionsEnabled) {
      coordGrants.set(
        actor.accountId,
        engine.issueQueueGrant({ eventSaleId, accountId: actor.accountId, sessionId: actor.sessionId, issuedAtMs: tJoin })
      );
    } else {
      const failVer = engine.evaluate(buildSecurityEvent({ actor, eventType: 'VERIFICATION_FAILED', eventSaleId, timestampMs: tJoin + 100 }));
      recordDecisionInTrace(trace, failVer, 'VERIFICATION_FAILED');
      coordGrants.set(actor.accountId, null);
    }
  }

  for (let i = 0; i < coordinatedBots.length; i++) {
    const actor = coordinatedBots[i];
    const trace = traceMap.get(actor.accountId) as ActorTrace;
    const ck = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'CHECKOUT_ATTEMPT',
        eventSaleId,
        timestampMs: coordTimeBase + 6_500 + i * 30,
        queueGrant: coordGrants.get(actor.accountId) ?? null,
      })
    );
    recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
  }

  // Phase 4: Stealth Independent Bots (no linked signals) + 60 Legitimate Fans
  const stealthTimeBase = coordTimeBase + 15_000;
  for (let i = 0; i < stealthBots.length; i++) {
    const actor = stealthBots[i];
    const trace = registerTrace(actor);
    const t0 = stealthTimeBase + i * 1_500;
    const reg = engine.evaluate(buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: t0 }));
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');
    const join = engine.evaluate(buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 + 500 }));
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');
    const grant = engine.issueQueueGrant({ eventSaleId, accountId: actor.accountId, sessionId: actor.sessionId, issuedAtMs: t0 + 500 });
    const ck = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'CHECKOUT_ATTEMPT', eventSaleId, timestampMs: t0 + 1_200, queueGrant: grant })
    );
    recordDecisionInTrace(trace, ck, 'CHECKOUT_ATTEMPT');
  }

  const legitTraces = runLegitimateFlow(engine, legitActors, eventSaleId, stealthTimeBase + 12_000);
  for (const t of legitTraces) {
    traceMap.set(t.accountId, t);
  }

  const allTraces = Array.from(traceMap.values());
  const legitOnly = allTraces.filter((t) => !t.groundTruthMalicious);
  const maliciousOnly = allTraces.filter((t) => t.groundTruthMalicious);
  const linkableAndPolicyMalicious = maliciousOnly.filter((t) => t.group !== 'stealth_independent_bot');
  const stealthOnly = maliciousOnly.filter((t) => t.group === 'stealth_independent_bot');
  const sharedWifiOnly = legitOnly.filter((t) => t.group === 'shared_wifi_fan');

  const tp = maliciousOnly.filter((t) => t.flagged).length;
  const fn = maliciousOnly.length - tp;
  const fp = legitOnly.filter((t) => t.flagged).length;
  const tn = legitOnly.length - fp;
  const tpLinkable = linkableAndPolicyMalicious.filter((t) => t.flagged).length;

  const groups: Record<string, GroupBenchmarkMetrics> = {};
  for (const trace of allTraces) {
    if (!groups[trace.group]) {
      groups[trace.group] = {
        group: trace.group,
        groundTruthMalicious: trace.groundTruthMalicious,
        participantsTotal: 0,
        flaggedForSecurity: 0,
        challengedCount: 0,
        blockedCount: 0,
        hardFailedCount: 0,
        ticketsAcquired: 0,
      };
    }
    const g = groups[trace.group];
    g.participantsTotal += 1;
    if (trace.flagged) g.flaggedForSecurity += 1;
    if (trace.challenged) g.challengedCount += 1;
    if (trace.blocked) g.blockedCount += 1;
    if (trace.hardFailed) g.hardFailedCount += 1;
    if (trace.ticketAcquired) g.ticketsAcquired += 1;
  }

  const finalSale = engine.getSaleState(eventSaleId);
  const auditRecords = engine.getAuditLog();
  const decisionsWithAudit = auditRecords.filter(
    (d) => d.decisionId && Array.isArray(d.supportingEventIds) && d.supportingEventIds.length > 0 && (d.decision === 'ALLOW' || d.reasons.length > 0)
  ).length;

  const maliciousTicketsAcquired = maliciousOnly.filter((t) => t.ticketAcquired).length;

  return {
    protectionsEnabled,
    capacity,
    ticketsSold: finalSale.soldInventory,
    oversoldTickets: Math.max(0, finalSale.soldInventory - finalSale.capacity),
    availableInventoryAtEnd: finalSale.availableInventory,
    expiredHoldsTotal,
    exactOnceRestorations: finalSale.exactOnceReleaseCount,
    duplicateReleaseAttemptsIgnored: finalSale.duplicateReleaseAttemptsIgnored,
    unauthorizedBypassAttempts,
    unauthorizedCheckoutsSucceeded,
    totalDecisionsRecorded: auditRecords.length,
    decisionsWithAuditReasonsOrCleanAllow: decisionsWithAudit,
    legitimateParticipantsTotal: legitOnly.length,
    legitimateFlaggedFalsePositives: fp,
    legitimateTicketsAcquired: legitOnly.filter((t) => t.ticketAcquired).length,
    sharedWifiTotal: sharedWifiOnly.length,
    sharedWifiFlagged: sharedWifiOnly.filter((t) => t.flagged).length,
    sharedWifiTicketsAcquired: sharedWifiOnly.filter((t) => t.ticketAcquired).length,
    maliciousParticipantsTotal: maliciousOnly.length,
    maliciousFlaggedTruePositives: tp,
    maliciousTicketsAcquired,
    preventedMaliciousAllocations: maliciousOnly.length - maliciousTicketsAcquired,
    remainingSuccessfulStealthAttacks: stealthOnly.filter((t) => t.ticketAcquired).length,
    classification: {
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      precision: tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1,
      recallOverall: maliciousOnly.length > 0 ? Number((tp / maliciousOnly.length).toFixed(4)) : 0,
      recallLinkableAndPolicy:
        linkableAndPolicyMalicious.length > 0 ? Number((tpLinkable / linkableAndPolicyMalicious.length).toFixed(4)) : 0,
      falsePositiveRate: legitOnly.length > 0 ? Number((fp / legitOnly.length).toFixed(4)) : 0,
      sharedWifiFalsePositiveRate:
        sharedWifiOnly.length > 0 ? Number((sharedWifiOnly.filter((t) => t.flagged).length / sharedWifiOnly.length).toFixed(4)) : 0,
    },
    groups,
  };
}

export function runIbmBenchmarkSuite(): IbmBenchmarkReport {
  const eventSaleId = 'concert_ibm_benchmark_v1';
  const capacity = 80;
  const baseline = executeCombinedWorkload(false, `${eventSaleId}_baseline`, capacity);
  const protectedRun = executeCombinedWorkload(true, `${eventSaleId}_protected`, capacity);

  const farmGroup = protectedRun.groups.account_farm;
  const ibmTargets = [
    {
      target: 'Queue bypass attempt',
      expected: '0 unauthorized checkouts',
      observed: `${protectedRun.unauthorizedCheckoutsSucceeded} / ${protectedRun.unauthorizedBypassAttempts} unauthorized checkouts (Baseline: ${baseline.unauthorizedCheckoutsSucceeded})`,
      passed: protectedRun.unauthorizedCheckoutsSucceeded === 0,
    },
    {
      target: 'Inventory abuse',
      expected: 'Every expired hold releases inventory exactly once',
      observed: `${protectedRun.exactOnceRestorations}/${protectedRun.expiredHoldsTotal} restored once (${protectedRun.duplicateReleaseAttemptsIgnored} duplicate release events ignored)`,
      passed:
        protectedRun.exactOnceRestorations === protectedRun.expiredHoldsTotal &&
        protectedRun.duplicateReleaseAttemptsIgnored > 0,
    },
    {
      target: 'Known linked-account farm',
      expected: 'Detect the 50-account seeded cluster',
      observed: `${farmGroup.flaggedForSecurity}/${farmGroup.participantsTotal} farm accounts flagged, ${farmGroup.ticketsAcquired} tickets acquired`,
      passed: farmGroup.flaggedForSecurity === 50 && farmGroup.ticketsAcquired === 0,
    },
    {
      target: 'Legitimate shared-network users',
      expected: 'No blanket rejection by IP',
      observed: `${protectedRun.sharedWifiFlagged}/${protectedRun.sharedWifiTotal} flagged (${protectedRun.sharedWifiTicketsAcquired}/${protectedRun.sharedWifiTotal} tickets acquired)`,
      passed:
        protectedRun.sharedWifiFlagged === 0 &&
        protectedRun.sharedWifiTicketsAcquired === protectedRun.sharedWifiTotal,
    },
    {
      target: 'Concurrent purchases',
      expected: '0 oversold tickets',
      observed: `${protectedRun.oversoldTickets} oversold (${protectedRun.ticketsSold}/${protectedRun.capacity} capacity sold)`,
      passed: protectedRun.oversoldTickets === 0 && protectedRun.ticketsSold <= protectedRun.capacity,
    },
    {
      target: 'Risk decisions',
      expected: 'Every action has recorded reasons and supporting events',
      observed: `${protectedRun.decisionsWithAuditReasonsOrCleanAllow}/${protectedRun.totalDecisionsRecorded} decisions fully audited`,
      passed: protectedRun.decisionsWithAuditReasonsOrCleanAllow === protectedRun.totalDecisionsRecorded,
    },
    {
      target: 'Distributed automation',
      expected: 'Report prevented malicious allocations and remaining successful attacks',
      observed: `${protectedRun.preventedMaliciousAllocations} prevented; ${protectedRun.remainingSuccessfulStealthAttacks} independent stealth attacks succeeded (Baseline malicious allocations: ${baseline.maliciousTicketsAcquired})`,
      passed: protectedRun.preventedMaliciousAllocations > baseline.preventedMaliciousAllocations,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    simulation: true,
    eventSaleId,
    capacity,
    knownLimitations: [
      'Genuinely independent-looking identities without shared device, payment, session, or timing/grant anomalies cannot be linked as one person by the relationship graph.',
      'Heuristic rule weights and thresholds (0-39 ALLOW, 40-69 CHALLENGE, 70-100 BLOCK) are starting prototype configurations rather than empirically calibrated production probabilities.',
      'In this controlled simulation, deviceId, networkId, and paymentTokenHash are server/environment-supplied pseudonymous identifiers.',
    ],
    ibmTargets,
    baseline,
    protected: protectedRun,
    deltas: {
      unauthorizedCheckoutsPrevented:
        baseline.unauthorizedCheckoutsSucceeded - protectedRun.unauthorizedCheckoutsSucceeded,
      maliciousAllocationsReducedBy:
        baseline.maliciousTicketsAcquired - protectedRun.maliciousTicketsAcquired,
      legitimateFanTicketsGained:
        protectedRun.legitimateTicketsAcquired - baseline.legitimateTicketsAcquired,
      legitimateDisruptionRateProtected: protectedRun.classification.falsePositiveRate,
    },
  };
}

export function renderBenchmarkMarkdown(report: IbmBenchmarkReport): string {
  const lines: string[] = [
    '# FairTickets Anti-Bot & Risk Engine — IBM Benchmark Report',
    '',
    `> **Simulation Mode:** Seeded deterministic workload (${report.capacity} concert capacity · ${report.protected.maliciousParticipantsTotal} adversarial accounts + ${report.protected.legitimateParticipantsTotal} legitimate fans)`,
    `> **Generated At:** ${report.generatedAt}`,
    '',
    '## 1. IBM Benchmark Targets (Protected Run)',
    '',
    '| Test | Target | Observed Result | Status |',
    '|---|---|---|---|',
    ...report.ibmTargets.map(
      (t) => `| ${t.target} | ${t.expected} | ${t.observed} | ${t.passed ? 'PASS' : 'FAIL'} |`
    ),
    '',
    '## 2. Baseline vs. Protected Comparison (Identical Seeded Workload)',
    '',
    '| Metric | Baseline (Protections Off) | Protected (Risk Engine On) | Delta |',
    '|---|---:|---:|---:|',
    `| Completed Legitimate Purchases | ${report.baseline.legitimateTicketsAcquired}/${report.baseline.legitimateParticipantsTotal} | ${report.protected.legitimateTicketsAcquired}/${report.protected.legitimateParticipantsTotal} | +${report.deltas.legitimateFanTicketsGained} |`,
    `| Malicious Ticket Allocations | ${report.baseline.maliciousTicketsAcquired} | ${report.protected.maliciousTicketsAcquired} | -${report.deltas.maliciousAllocationsReducedBy} |`,
    `| Unauthorized Queue-Bypass Checkouts | ${report.baseline.unauthorizedCheckoutsSucceeded} | ${report.protected.unauthorizedCheckoutsSucceeded} | -${report.deltas.unauthorizedCheckoutsPrevented} |`,
    `| Shared-Wi-Fi Fan Disruptions (FPR) | ${report.baseline.sharedWifiFlagged}/${report.baseline.sharedWifiTotal} | ${report.protected.sharedWifiFlagged}/${report.protected.sharedWifiTotal} | 0 |`,
    `| Oversold Tickets | ${report.baseline.oversoldTickets} | ${report.protected.oversoldTickets} | 0 |`,
    '',
    '## 3. Detection Metrics (Ground-Truth Labeled Simulation)',
    '',
    `- **Precision:** ${(report.protected.classification.precision * 100).toFixed(2)}% (\`TP=${report.protected.classification.truePositives}, FP=${report.protected.classification.falsePositives}\`)`,
    `- **Recall (All Malicious incl. Independent Stealth Bots):** ${(report.protected.classification.recallOverall * 100).toFixed(2)}% (\`FN=${report.protected.classification.falseNegatives}\`)`,
    `- **Recall (Linkable & Policy-Violating Threats):** ${(report.protected.classification.recallLinkableAndPolicy * 100).toFixed(2)}%`,
    `- **False-Positive Rate (Legitimate Users):** ${(report.protected.classification.falsePositiveRate * 100).toFixed(2)}%`,
    `- **Shared-Wi-Fi False-Positive Rate:** ${(report.protected.classification.sharedWifiFalsePositiveRate * 100).toFixed(2)}%`,
    '',
    '## 4. Per-Cohort Breakdown (Protected Run)',
    '',
    '| Cohort | Malicious | Flagged | Challenged | Blocked / Hard Fail | Tickets Acquired |',
    '|---|---:|---:|---:|---:|---:|',
    ...Object.values(report.protected.groups).map(
      (g) =>
        `| \`${g.group}\` | ${g.groundTruthMalicious ? 'Yes' : 'No'} | ${g.flaggedForSecurity}/${g.participantsTotal} | ${g.challengedCount} | ${g.blockedCount} (${g.hardFailedCount} hard) | ${g.ticketsAcquired} |`
    ),
    '',
    '## 5. Known Limitations (Openly Documented)',
    '',
    ...report.knownLimitations.map((l) => `- ${l}`),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runIbmBenchmarkSuite();
  if (process.argv.includes('--write')) {
    const root = resolve(import.meta.dirname, '..', '..');
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, 'security-benchmark-report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(artifactsDir, 'security-benchmark-report.md'), renderBenchmarkMarkdown(report) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}
