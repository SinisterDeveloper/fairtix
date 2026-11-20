import type { DecisionOutcome, RiskDecision } from '../src/decisions.ts';
import type { SecurityEvent, SecurityEventType } from '../src/events.ts';
import type { RiskEngine } from '../src/risk-engine.ts';

export type CohortGroup =
  | 'solo_fan'
  | 'shared_wifi_fan'
  | 'family_household'
  | 'account_farm'
  | 'queue_bypass_bot'
  | 'distributed_linked_bot'
  | 'inventory_hoarder_bot'
  | 'behavioral_stealth_bot'
  | 'stealth_independent_bot';

export interface SimActor {
  accountId: string;
  sessionId: string;
  group: CohortGroup;
  groundTruthMalicious: boolean;
  deviceId: string | null;
  networkId: string | null;
  paymentTokenHash: string | null;
  grantMode?: 'valid' | 'missing' | 'forged' | 'expired' | 'wrong_account' | 'replayed';
}

export interface ActorTrace {
  accountId: string;
  group: CohortGroup;
  groundTruthMalicious: boolean;
  flagged: boolean;
  challenged: boolean;
  blocked: boolean;
  hardFailed: boolean;
  maxRiskScore: number;
  reasons: string[];
  decisionIds: string[];
  checkoutDecision: DecisionOutcome | null;
  ticketAcquired: boolean;
}

let eventCounter = 0;

export function resetSimEventCounter(): void {
  eventCounter = 0;
}

export function buildSecurityEvent(params: {
  actor: SimActor;
  eventType: SecurityEventType;
  eventSaleId: string;
  timestampMs: number;
  queueGrant?: string | null;
  reservationId?: string | null;
  holdTtlMs?: number | null;
  quantity?: number;
  idempotencySuffix?: string;
}): SecurityEvent {
  eventCounter += 1;
  const eventId = `evt_sim_${eventCounter}`;
  return {
    eventId,
    timestamp: new Date(params.timestampMs).toISOString(),
    eventType: params.eventType,
    eventIdempotencyKey: params.idempotencySuffix
      ? `idem_${params.actor.accountId}_${params.eventType}_${params.idempotencySuffix}`
      : `idem_${eventId}`,
    accountId: params.actor.accountId,
    sessionId: params.actor.sessionId,
    eventContext: {
      eventSaleId: params.eventSaleId,
      deviceId: params.actor.deviceId,
      networkId: params.actor.networkId,
      paymentTokenHash: params.actor.paymentTokenHash,
      queueGrant: params.queueGrant ?? null,
      reservationId: params.reservationId ?? null,
      holdTtlMs: params.holdTtlMs ?? null,
      quantity: params.quantity ?? 1,
    },
  };
}

export function isSecurityFlagDecision(decision: RiskDecision): boolean {
  if (decision.decision === 'ALLOW') return false;
  const nonSoldOutReasons = decision.reasons.filter((r) => r !== 'INVENTORY_EXHAUSTED');
  return nonSoldOutReasons.length > 0;
}

export function createEmptyTrace(actor: SimActor): ActorTrace {
  return {
    accountId: actor.accountId,
    group: actor.group,
    groundTruthMalicious: actor.groundTruthMalicious,
    flagged: false,
    challenged: false,
    blocked: false,
    hardFailed: false,
    maxRiskScore: 0,
    reasons: [],
    decisionIds: [],
    checkoutDecision: null,
    ticketAcquired: false,
  };
}

export function recordDecisionInTrace(trace: ActorTrace, decision: RiskDecision, eventType: SecurityEventType): void {
  trace.decisionIds.push(decision.decisionId);
  if (decision.riskScore > trace.maxRiskScore && !decision.reasons.every((r) => r === 'INVENTORY_EXHAUSTED')) {
    trace.maxRiskScore = decision.riskScore;
  }
  for (const r of decision.reasons) {
    if (!trace.reasons.includes(r)) {
      trace.reasons.push(r);
    }
  }
  if (isSecurityFlagDecision(decision)) {
    trace.flagged = true;
    if (decision.decision === 'CHALLENGE') trace.challenged = true;
    if (decision.decision === 'BLOCK') trace.blocked = true;
    if (decision.hardFailure) trace.hardFailed = true;
  }
  if (eventType === 'CHECKOUT_ATTEMPT') {
    trace.checkoutDecision = decision.decision;
    if (decision.decision === 'ALLOW') {
      trace.ticketAcquired = true;
    }
  }
}

export function generateLegitimateUsers(options: {
  soloCount?: number;
  sharedWifiCount?: number;
  includeFamilyHousehold?: boolean;
  sharedNetworkId?: string;
} = {}): SimActor[] {
  const soloCount = options.soloCount ?? 10;
  const sharedWifiCount = options.sharedWifiCount ?? 15;
  const includeFamilyHousehold = options.includeFamilyHousehold ?? true;
  const sharedNetworkId = options.sharedNetworkId ?? 'shared_wifi_venue_1';

  const actors: SimActor[] = [];

  for (let i = 1; i <= sharedWifiCount; i++) {
    actors.push({
      accountId: `wifi_fan_${i}`,
      sessionId: `sess_wifi_${i}`,
      group: 'shared_wifi_fan',
      groundTruthMalicious: false,
      deviceId: `device_wifi_${i}`,
      networkId: sharedNetworkId,
      paymentTokenHash: `pay_wifi_${i}`,
      grantMode: 'valid',
    });
  }

  if (includeFamilyHousehold) {
    actors.push(
      {
        accountId: 'family_fan_1',
        sessionId: 'sess_family_1',
        group: 'family_household',
        groundTruthMalicious: false,
        deviceId: 'device_family_home_1',
        networkId: 'home_net_family_1',
        paymentTokenHash: 'pay_family_shared_1',
        grantMode: 'valid',
      },
      {
        accountId: 'family_fan_2',
        sessionId: 'sess_family_2',
        group: 'family_household',
        groundTruthMalicious: false,
        deviceId: 'device_family_home_1',
        networkId: 'home_net_family_1',
        paymentTokenHash: 'pay_family_shared_1',
        grantMode: 'valid',
      }
    );
  }

  for (let i = 1; i <= soloCount; i++) {
    actors.push({
      accountId: `solo_fan_${i}`,
      sessionId: `sess_solo_${i}`,
      group: 'solo_fan',
      groundTruthMalicious: false,
      deviceId: `device_solo_${i}`,
      networkId: `home_net_${i}`,
      paymentTokenHash: `pay_solo_${i}`,
      grantMode: 'valid',
    });
  }

  return actors;
}

/**
 * Simulates a legitimate cohort executing registration -> queue join ->
 * grant issuance -> reservation -> checkout with realistic human pacing.
 */
export function runLegitimateFlow(
  engine: RiskEngine,
  actors: SimActor[],
  eventSaleId: string,
  baseTimeMs: number
): ActorTrace[] {
  const traces: ActorTrace[] = [];

  for (let idx = 0; idx < actors.length; idx++) {
    const actor = actors[idx];
    const trace = createEmptyTrace(actor);
    // Space family members out by 25 seconds so they don't look like a synchronized bot burst.
    const spacingMs = actor.group === 'family_household' ? idx * 25_000 : idx * 200;
    const t0 = baseTimeMs + spacingMs;

    const reg = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'ACCOUNT_REGISTER', eventSaleId, timestampMs: t0 })
    );
    recordDecisionInTrace(trace, reg, 'ACCOUNT_REGISTER');

    const join = engine.evaluate(
      buildSecurityEvent({ actor, eventType: 'QUEUE_JOIN', eventSaleId, timestampMs: t0 + 1_000 })
    );
    recordDecisionInTrace(trace, join, 'QUEUE_JOIN');

    let grant: string | null = null;
    if (join.decision === 'ALLOW' || !engine.protectionsEnabled) {
      grant = engine.issueQueueGrant({
        eventSaleId,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        issuedAtMs: t0 + 1_000,
      });
    }

    const resId = `res_${actor.accountId}_${eventSaleId}`;
    const res = engine.evaluate(
      buildSecurityEvent({
        actor,
        eventType: 'RESERVATION_CREATE',
        eventSaleId,
        timestampMs: t0 + 2_500,
        queueGrant: grant,
        reservationId: resId,
      })
    );
    recordDecisionInTrace(trace, res, 'RESERVATION_CREATE');

    if (res.decision === 'ALLOW') {
      const checkout = engine.evaluate(
        buildSecurityEvent({
          actor,
          eventType: 'CHECKOUT_ATTEMPT',
          eventSaleId,
          timestampMs: t0 + 4_000,
          queueGrant: grant,
          reservationId: resId,
        })
      );
      recordDecisionInTrace(trace, checkout, 'CHECKOUT_ATTEMPT');
    }

    traces.push(trace);
  }

  return traces;
}
