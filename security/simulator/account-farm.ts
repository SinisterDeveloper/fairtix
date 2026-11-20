import { pathToFileURL } from 'node:url';
import type { ClusterAnalysis } from '../src/account-graph.ts';
import { RiskEngine } from '../src/risk-engine.ts';
import {
  buildSecurityEvent,
  createEmptyTrace,
  generateLegitimateUsers,
  recordDecisionInTrace,
  resetSimEventCounter,
  runLegitimateFlow,
  type ActorTrace,
  type SimActor,
} from './legitimate-users.ts';

export interface AccountFarmResult {
  scenario: 'milestone_1_account_farm';
  eventSaleId: string;
  protectionsEnabled: boolean;
  farmAccountsTotal: number;
  farmAccountsFlagged: number;
  farmAccountsChallengedOrBlocked: number;
  farmCheckoutsSucceeded: number;
  discoveredFarmClusters: Array<{
    clusterId: string;
    accountCount: number;
    distinctNetworkCount: number;
    sharedIdentifiers: string[];
  }>;
  sharedWifiTotal: number;
  sharedWifiFlagged: number;
  sharedWifiCheckoutsSucceeded: number;
  familyTotal: number;
  familyFlagged: number;
  familyCheckoutsSucceeded: number;
  farmTraces: ActorTrace[];
  legitimateTraces: ActorTrace[];
}

export function generateAccountFarmActors(count = 50, clusterCount = 5): SimActor[] {
  const actors: SimActor[] = [];
  for (let i = 0; i < count; i++) {
    const clusterIdx = i % clusterCount;
    const idx = i + 1;
    actors.push({
      accountId: `farm_user_${idx}`,
      sessionId: `sess_farm_${idx}`,
      group: 'account_farm',
      groundTruthMalicious: true,
      // Distinct IP and session per account, but shared device and payment pool
      deviceId: `device_farm_${clusterIdx}`,
      networkId: `ip_farm_${idx}`,
      paymentTokenHash: `pay_farm_${clusterIdx}`,
      grantMode: 'valid',
    });
  }
  return actors;
}

/**
 * Runs Milestone 1: 50 coordinated farm accounts with 50 distinct IPs & sessions
 * sharing 5 device/payment pools alongside 15 shared-Wi-Fi fans and 2 family members.
 */
export function runAccountFarmScenario(options: {
  protectionsEnabled?: boolean;
  eventSaleId?: string;
  capacity?: number;
  baseTimeMs?: number;
  engine?: RiskEngine;
} = {}): AccountFarmResult {
  const protectionsEnabled = options.protectionsEnabled ?? true;
  const eventSaleId = options.eventSaleId ?? 'concert_milestone_1';
  const capacity = options.capacity ?? 100;
  const baseTimeMs = options.baseTimeMs ?? Date.parse('2026-11-21T02:00:00+05:30');

  if (!options.engine) {
    resetSimEventCounter();
  }
  const engine = options.engine ?? new RiskEngine({ protectionsEnabled });
  engine.configureSale(eventSaleId, {
    capacity,
    requireQueueGrants: true,
    maxTicketsPerCluster: 4,
    maxActiveHoldsPerCluster: 3,
  });

  const farmActors = generateAccountFarmActors(50, 5);
  const legitActors = generateLegitimateUsers({
    soloCount: 0,
    sharedWifiCount: 15,
    includeFamilyHousehold: true,
    sharedNetworkId: 'shared_wifi_venue_1',
  });

  const farmTracesMap = new Map<string, ActorTrace>();
  for (const actor of farmActors) {
    farmTracesMap.set(actor.accountId, createEmptyTrace(actor));
  }

  // 1. Farm accounts register in a rapid burst using 50 distinct IPs
  for (let i = 0; i < farmActors.length; i++) {
    const actor = farmActors[i];
    const trace = farmTracesMap.get(actor.accountId) as ActorTrace;
    const reg = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'ACCOUNT_REGISTER',
        eventSaleId,
        timestampMs: baseTimeMs + i * 40,
      })
    );
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');
  }

  // 2. Farm accounts join queue together in a coordinated wave
  const grantByAccount = new Map<string, string | null>();
  for (let i = 0; i < farmActors.length; i++) {
    const actor = farmActors[i];
    const trace = farmTracesMap.get(actor.accountId) as ActorTrace;
    const tJoin = baseTimeMs + 3_000 + i * 30;
    const join = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'QUEUE_JOIN',
        eventSaleId,
        timestampMs: tJoin,
      })
    );
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');

    if (join.decision === 'ALLOW' || !engine.protectionsEnabled) {
      grantByAccount.set(
        actor.accountId,
        engine.issueQueueGrant({
          eventSaleId,
          accountId: actor.accountId,
          sessionId: actor.sessionId,
          issuedAtMs: tJoin,
        })
      );
    } else {
      // Bot fails additional challenge verification
      const failVer = engine.evaluate(
        buildSecurityEvent({
          actor,
          eventType: 'VERIFICATION_FAILED',
          eventSaleId,
          timestampMs: tJoin + 200,
        })
      );
      recordDecisionInTrace(trace, failVer, 'VERIFICATION_FAILED');
      grantByAccount.set(actor.accountId, null);
    }
  }

  // 3. Farm accounts attempt coordinated reservation & checkout
  for (let i = 0; i < farmActors.length; i++) {
    const actor = farmActors[i];
    const trace = farmTracesMap.get(actor.accountId) as ActorTrace;
    const tCheckout = baseTimeMs + 5_000 + i * 30;
    const grant = grantByAccount.get(actor.accountId) ?? null;

    const checkout = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'CHECKOUT_ATTEMPT',
        eventSaleId,
        timestampMs: tCheckout,
        queueGrant: grant,
      })
    );
    recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
  }

  // 4. Legitimate shared-Wi-Fi (15) + family household (2) arrive in the same sale
  const legitTraces = runLegitimateFlow(engine, legitActors, eventSaleId, baseTimeMs + 12_000);

  const farmTraces = farmActors.map((a) => farmTracesMap.get(a.accountId) as ActorTrace);
  const discoveredClusters: ClusterAnalysis[] = engine
    .getClusters(eventSaleId, baseTimeMs + 60_000)
    .filter((c) => c.accountIds.some((id) => id.startsWith('farm_user_')));

  const sharedWifiTraces = legitTraces.filter((t) => t.group === 'shared_wifi_fan');
  const familyTraces = legitTraces.filter((t) => t.group === 'family_household');

  return {
    scenario: 'milestone_1_account_farm',
    eventSaleId,
    protectionsEnabled,
    farmAccountsTotal: farmTraces.length,
    farmAccountsFlagged: farmTraces.filter((t) => t.flagged).length,
    farmAccountsChallengedOrBlocked: farmTraces.filter((t) => t.challenged || t.blocked).length,
    farmCheckoutsSucceeded: farmTraces.filter((t) => t.ticketAcquired).length,
    discoveredFarmClusters: discoveredClusters.map((c) => ({
      clusterId: c.clusterId,
      accountCount: c.accountCount,
      distinctNetworkCount: c.distinctNetworkCount,
      sharedIdentifiers: c.sharedIdentifiers,
    })),
    sharedWifiTotal: sharedWifiTraces.length,
    sharedWifiFlagged: sharedWifiTraces.filter((t) => t.flagged).length,
    sharedWifiCheckoutsSucceeded: sharedWifiTraces.filter((t) => t.ticketAcquired).length,
    familyTotal: familyTraces.length,
    familyFlagged: familyTraces.filter((t) => t.flagged).length,
    familyCheckoutsSucceeded: familyTraces.filter((t) => t.ticketAcquired).length,
    farmTraces,
    legitimateTraces: legitTraces,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runAccountFarmScenario({ protectionsEnabled: true });
  const { farmTraces: _ft, legitimateTraces: _lt, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}
