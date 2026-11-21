import type { ClusterAnalysis } from '../account-graph.ts';
import type { RuleSignal } from '../decisions.ts';
import { RISK_WEIGHTS } from '../decisions.ts';
import type { NormalizedSecurityEvent } from '../events.ts';
import type { InventoryEvaluationResult } from './inventory-abuse.ts';

export interface ScalpingRuleConfig {
  maxTicketsPerCluster: number;
}

/**
 * Priority 4 — OAT-005: Coordinated Scalping Correlation Rule.
 * Correlates account-linkage clusters, synchronized purchasing/session velocity,
 * prior verification failures, and per-cluster acquisition caps.
 */
export function evaluateScalpingRule(
  event: NormalizedSecurityEvent,
  cluster: ClusterAnalysis,
  inventory: InventoryEvaluationResult,
  config: ScalpingRuleConfig
): RuleSignal[] {
  const signals: RuleSignal[] = [];

  if (
    !cluster.isBenignHousehold &&
    (cluster.accountCount >= 3 || cluster.competingCount >= 2)
  ) {
    signals.push({
      rule: 'OAT-005:scalping',
      reason: 'LINKED_ACCOUNT_CLUSTER',
      points: RISK_WEIGHTS.LINKED_ACCOUNT_CLUSTER,
      detail: `Cluster ${cluster.clusterId} links ${cluster.accountCount} accounts (${cluster.competingCount} competing in ${event.eventContext.eventSaleId}) via ${cluster.sharedIdentifiers.join(', ') || 'shared session'}`,
      supportingEventIds: cluster.supportingEventIds,
    });
  }

  if (
    (!cluster.isBenignHousehold && cluster.synchronizedAccountsInWindow >= 2) ||
    (!cluster.isBenignHousehold && cluster.competingCount >= 4 && cluster.coordinatedAccountsInSaleWindow >= 3) ||
    cluster.accountSensitiveActionsInWindow >= 5
  ) {
    signals.push({
      rule: 'OAT-005:scalping',
      reason: 'ABNORMAL_SESSION_VELOCITY',
      points: RISK_WEIGHTS.ABNORMAL_SESSION_VELOCITY,
      detail: `${cluster.synchronizedAccountsInWindow} linked accounts acted within sync window (${cluster.accountSensitiveActionsInWindow} recent actions for ${event.accountId})`,
      supportingEventIds: cluster.supportingEventIds,
    });
  }

  if (cluster.clusterFailedVerifications > 0) {
    signals.push({
      rule: 'OAT-005:scalping',
      reason: 'PREVIOUSLY_FAILED_VERIFICATION',
      points: RISK_WEIGHTS.PREVIOUSLY_FAILED_VERIFICATION,
      detail: `Cluster ${cluster.clusterId} has ${cluster.clusterFailedVerifications} prior failed verification(s)`,
      supportingEventIds: cluster.supportingEventIds,
    });
  }

  if (
    (event.eventType === 'CHECKOUT_ATTEMPT' || event.eventType === 'RESERVATION_CREATE') &&
    !cluster.isBenignHousehold &&
    cluster.accountCount >= 2
  ) {
    const projectedTickets =
      inventory.clusterSoldCount + inventory.clusterHeldQuantity - inventory.convertedHoldQuantity + event.quantity;
    if (projectedTickets > config.maxTicketsPerCluster) {
      signals.push({
        rule: 'OAT-005:scalping',
        reason: 'CLUSTER_PURCHASE_LIMIT_EXCEEDED',
        points: 0,
        hardFailure: true,
        detail: `Cluster ${cluster.clusterId} reached ticket acquisition limit (${config.maxTicketsPerCluster})`,
        supportingEventIds: cluster.supportingEventIds,
      });
    }
  }

  return signals;
}
