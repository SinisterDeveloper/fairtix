import type { ClusterAnalysis } from '../account-graph.ts';
import type { RuleSignal } from '../decisions.ts';
import { RISK_WEIGHTS } from '../decisions.ts';
import type { NormalizedSecurityEvent } from '../events.ts';

/**
 * Priority 3 — OAT-019: Account Creation & Duplicate Entry Rule.
 * Detects Sybil registration bursts across linked identifiers and repeated
 * duplicate queue entry attempts for the same event sale.
 */
export function evaluateAccountCreationRule(
  event: NormalizedSecurityEvent,
  cluster: ClusterAnalysis
): RuleSignal[] {
  const signals: RuleSignal[] = [];

  if (!cluster.isBenignHousehold && cluster.recentRegistrationsInWindow >= 3) {
    signals.push({
      rule: 'OAT-019:account-creation',
      reason: 'UNUSUAL_REGISTRATION_VELOCITY',
      points: RISK_WEIGHTS.UNUSUAL_REGISTRATION_VELOCITY,
      detail: `${cluster.recentRegistrationsInWindow} linked accounts registered in burst window within ${cluster.clusterId}`,
      supportingEventIds: cluster.supportingEventIds,
    });
  }

  if (event.eventType === 'QUEUE_JOIN' && cluster.accountQueueJoinCount >= 2) {
    signals.push({
      rule: 'OAT-019:account-creation',
      reason: 'REPEATED_DUPLICATE_ENTRY',
      points: RISK_WEIGHTS.REPEATED_DUPLICATE_ENTRY,
      detail: `Account ${event.accountId} made ${cluster.accountQueueJoinCount} queue entry attempts for ${event.eventContext.eventSaleId}`,
      supportingEventIds: [event.eventId],
    });
  }

  return signals;
}
