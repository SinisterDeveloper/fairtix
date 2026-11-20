export type DecisionOutcome = 'ALLOW' | 'CHALLENGE' | 'BLOCK';

export type ReasonCode =
  | 'ABNORMAL_RESERVATION_ABANDONMENT'
  | 'LINKED_ACCOUNT_CLUSTER'
  | 'ABNORMAL_SESSION_VELOCITY'
  | 'UNUSUAL_REGISTRATION_VELOCITY'
  | 'REPEATED_DUPLICATE_ENTRY'
  | 'PREVIOUSLY_FAILED_VERIFICATION'
  | 'INVALID_QUEUE_GRANT'
  | 'EXPIRED_QUEUE_GRANT'
  | 'REPLAYED_QUEUE_GRANT'
  | 'QUEUE_BYPASS_ATTEMPT'
  | 'HOLD_LIMIT_EXCEEDED'
  | 'INVENTORY_EXHAUSTED'
  | 'CLUSTER_PURCHASE_LIMIT_EXCEEDED';

export const RISK_WEIGHTS: Readonly<Record<string, number>> = {
  ABNORMAL_RESERVATION_ABANDONMENT: 25,
  LINKED_ACCOUNT_CLUSTER: 20,
  ABNORMAL_SESSION_VELOCITY: 20,
  UNUSUAL_REGISTRATION_VELOCITY: 15,
  REPEATED_DUPLICATE_ENTRY: 10,
  PREVIOUSLY_FAILED_VERIFICATION: 20,
};

export interface RuleSignal {
  rule: string;
  reason: ReasonCode;
  points: number;
  detail: string;
  hardFailure?: boolean;
  supportingEventIds?: string[];
}

export interface ClusterSummary {
  clusterId: string;
  accountCount: number;
  competingCount: number;
  sharedIdentifiers: string[];
  distinctNetworkCount: number;
  isBenignHousehold: boolean;
}

export interface RiskDecision {
  decision: DecisionOutcome;
  riskScore: number;
  reasons: string[];
  decisionId: string;
  hardFailure: boolean;
  clusterSummary?: ClusterSummary;
  supportingEventIds: string[];
}

export interface DecisionAuditRecord {
  decisionId: string;
  eventId: string;
  eventType: string;
  accountId: string;
  sessionId: string;
  eventSaleId: string;
  networkId: string | null;
  timestamp: string;
  decision: DecisionOutcome;
  riskScore: number;
  reasons: string[];
  hardFailure: boolean;
  ruleContributions: Array<{
    rule: string;
    reason: string;
    points: number;
    detail: string;
  }>;
  clusterSummary?: ClusterSummary;
  supportingEventIds: string[];
}

/**
 * Maps a capped [0, 100] risk score (or hard authorization failure) to an actionable decision.
 */
export function scoreToDecision(riskScore: number, hardFailure = false): DecisionOutcome {
  if (hardFailure) return 'BLOCK';
  if (riskScore >= 70) return 'BLOCK';
  if (riskScore >= 40) return 'CHALLENGE';
  return 'ALLOW';
}

export function clampRiskScore(rawScore: number): number {
  if (!Number.isFinite(rawScore) || rawScore <= 0) return 0;
  if (rawScore >= 100) return 100;
  return Math.round(rawScore);
}

/**
 * Append-only audit log for every RiskDecision produced by the engine.
 */
export class DecisionAuditLog {
  private seq = 500;
  private readonly records: DecisionAuditRecord[] = [];

  nextDecisionId(): string {
    this.seq += 1;
    return `risk_${this.seq}`;
  }

  append(record: DecisionAuditRecord): DecisionAuditRecord {
    this.records.push(record);
    return record;
  }

  getAll(): DecisionAuditRecord[] {
    return this.records.slice();
  }

  getByAccount(accountId: string): DecisionAuditRecord[] {
    return this.records.filter((r) => r.accountId === accountId);
  }

  getBySale(eventSaleId: string): DecisionAuditRecord[] {
    return this.records.filter((r) => r.eventSaleId === eventSaleId);
  }
}
