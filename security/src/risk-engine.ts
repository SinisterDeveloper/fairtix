import { AccountGraph, type AccountGraphOptions, type ClusterAnalysis } from './account-graph.ts';
import {
  clampRiskScore,
  DecisionAuditLog,
  scoreToDecision,
  type ClusterSummary,
  type DecisionAuditRecord,
  type RiskDecision,
  type RuleSignal,
} from './decisions.ts';
import { validateAndNormalizeEvent, type NormalizedSecurityEvent } from './events.ts';
import { SessionBehaviorTracker } from './ml-features.ts';
import { evaluateBehavioralMl, type MlInferenceResult } from './ml-scorer.ts';
import { evaluateAccountCreationRule } from './rules/account-creation.ts';
import { ExpeditingGuard, type IssueQueueGrantParams } from './rules/expediting.ts';
import {
  InventoryAbuseGuard,
  type SaleInventoryConfig,
  type SaleInventoryState,
} from './rules/inventory-abuse.ts';
import { evaluateScalpingRule } from './rules/scalping.ts';

export interface RiskEngineOptions {
  protectionsEnabled?: boolean;
  mlEnabled?: boolean;
  graphOptions?: AccountGraphOptions;
  secret?: string;
}

export interface EngineStats {
  protectionsEnabled: boolean;
  totalEventsEvaluated: number;
  allowCount: number;
  challengeCount: number;
  blockCount: number;
  hardFailureCount: number;
  idempotentCacheHits: number;
  totalAccounts: number;
  unauthorizedCheckoutAttempts: number;
  unauthorizedCheckoutsAllowed: number;
}

/**
 * Core Risk Decision Engine combining:
 * - Event normalization & idempotency
 * - Priority 1 (OAT-021): Inventory hold & abandonment abuse
 * - Priority 2 (OAT-006): Signed queue grant enforcement (hard auth bypasses score)
 * - Priority 3 (OAT-019): Account cluster creation & duplicate entry detection
 * - Priority 4 (OAT-005): Multi-account scalping & synchronized purchasing correlation
 */
export class RiskEngine {
  readonly protectionsEnabled: boolean;
  readonly mlEnabled: boolean;
  readonly graph: AccountGraph;
  readonly inventory: InventoryAbuseGuard;
  readonly expediting: ExpeditingGuard;
  readonly auditLog: DecisionAuditLog;
  readonly behaviorTracker: SessionBehaviorTracker;

  private readonly idempotencyCache = new Map<string, RiskDecision>();
  private totalEventsEvaluated = 0;
  private allowCount = 0;
  private challengeCount = 0;
  private blockCount = 0;
  private hardFailureCount = 0;
  private idempotentCacheHits = 0;

  constructor(options: RiskEngineOptions = {}) {
    this.protectionsEnabled = options.protectionsEnabled ?? true;
    this.mlEnabled = options.mlEnabled ?? true;
    this.graph = new AccountGraph(options.graphOptions);
    this.inventory = new InventoryAbuseGuard();
    this.expediting = new ExpeditingGuard(options.secret);
    this.auditLog = new DecisionAuditLog();
    this.behaviorTracker = new SessionBehaviorTracker();
  }

  configureSale(
    eventSaleId: string,
    config: SaleInventoryConfig & { requireQueueGrants?: boolean } = {}
  ): void {
    this.inventory.configureSale(eventSaleId, config);
    if (config.requireQueueGrants !== undefined) {
      this.expediting.configureSale(eventSaleId, config.requireQueueGrants);
    }
  }

  issueQueueGrant(params: IssueQueueGrantParams): string {
    return this.expediting.issueQueueGrant(params);
  }

  getSaleState(eventSaleId: string): SaleInventoryState {
    return this.inventory.getSaleState(eventSaleId);
  }

  getAuditLog(): DecisionAuditRecord[] {
    return this.auditLog.getAll();
  }

  getClusters(eventSaleId: string, nowMs = Date.now()): ClusterAnalysis[] {
    return this.graph.listMultiAccountClusters(eventSaleId, nowMs);
  }

  getStats(): EngineStats {
    const expStats = this.expediting.getStats();
    return {
      protectionsEnabled: this.protectionsEnabled,
      totalEventsEvaluated: this.totalEventsEvaluated,
      allowCount: this.allowCount,
      challengeCount: this.challengeCount,
      blockCount: this.blockCount,
      hardFailureCount: this.hardFailureCount,
      idempotentCacheHits: this.idempotentCacheHits,
      totalAccounts: this.graph.getAllAccountIds().length,
      unauthorizedCheckoutAttempts: expStats.unauthorizedCheckoutAttempts,
      unauthorizedCheckoutsAllowed: expStats.unauthorizedCheckoutsAllowed,
    };
  }

  evaluate(rawEvent: unknown): RiskDecision {
    const event: NormalizedSecurityEvent = validateAndNormalizeEvent(rawEvent);

    const cached = this.idempotencyCache.get(event.eventIdempotencyKey);
    if (cached) {
      this.idempotentCacheHits += 1;
      return cached;
    }

    const saleId = event.eventContext.eventSaleId;

    // 1. Update relationship graph and queue participation
    this.graph.recordEvent(event);
    if (event.eventType === 'QUEUE_JOIN') {
      this.expediting.recordQueueJoin(saleId, event.accountId);
    }

    const cluster = this.graph.getClusterForAccount(event.accountId, saleId, event.timestampMs);
    const saleState = this.inventory.getSaleState(saleId);

    // 2. Run layered detection rules
    const expeditingResult = this.expediting.evaluate(event, this.protectionsEnabled);
    const inventoryResult = this.inventory.evaluate(event, cluster, this.protectionsEnabled);

    const heuristicSignals: RuleSignal[] = [];
    let mlResult: MlInferenceResult | null = null;
    const features = this.behaviorTracker.recordAndExtract(event, cluster, saleState, inventoryResult);
    if (this.protectionsEnabled) {
      heuristicSignals.push(
        ...evaluateAccountCreationRule(event, cluster),
        ...evaluateScalpingRule(event, cluster, inventoryResult, {
          maxTicketsPerCluster: saleState.maxTicketsPerCluster,
        })
      );
      if (this.mlEnabled) {
        mlResult = evaluateBehavioralMl(features, event.eventId);
        if (mlResult.signal) {
          heuristicSignals.push(mlResult.signal);
        }
      }
    }

    // 3. Combine hard authorization failures and heuristic signals
    const allSignals: RuleSignal[] = [
      ...expeditingResult.signals,
      ...inventoryResult.signals,
      ...(this.protectionsEnabled ? heuristicSignals : []),
    ];

    // Deduplicate reason codes while keeping highest points per reason
    const seenReasons = new Map<string, RuleSignal>();
    for (const sig of allSignals) {
      const prev = seenReasons.get(sig.reason);
      if (!prev || (sig.hardFailure && !prev.hardFailure) || sig.points > prev.points) {
        seenReasons.set(sig.reason, sig);
      }
    }

    const uniqueSignals = Array.from(seenReasons.values());
    const hardFailure = uniqueSignals.some((s) => Boolean(s.hardFailure));
    const reasons = uniqueSignals.map((s) => s.reason);

    const rawScore = uniqueSignals.reduce((acc, s) => acc + s.points, 0);
    const riskScore = hardFailure ? 100 : clampRiskScore(rawScore);
    const decision = scoreToDecision(riskScore, hardFailure);

    const supportingSet = new Set<string>([event.eventId]);
    for (const sig of uniqueSignals) {
      for (const id of sig.supportingEventIds ?? []) {
        supportingSet.add(id);
      }
    }
    const supportingEventIds = Array.from(supportingSet);

    const clusterSummary: ClusterSummary = {
      clusterId: cluster.clusterId,
      accountCount: cluster.accountCount,
      competingCount: cluster.competingCount,
      sharedIdentifiers: cluster.sharedIdentifiers,
      distinctNetworkCount: cluster.distinctNetworkCount,
      isBenignHousehold: cluster.isBenignHousehold,
    };

    // 4. Commit inventory holds, ticket checkouts, and queue grant consumption only on ALLOW
    if (decision === 'ALLOW') {
      const committed = this.inventory.commitIfAllowed(event);
      if (!committed.committed) {
        // Race-safe fallback if capacity ran out during evaluation
        const exhaustedDecision: RiskDecision = {
          decision: 'BLOCK',
          riskScore: 100,
          reasons: ['INVENTORY_EXHAUSTED'],
          decisionId: this.auditLog.nextDecisionId(),
          hardFailure: true,
          clusterSummary,
          supportingEventIds,
        };
        this.recordAuditAndStats(event, exhaustedDecision, [
          {
            rule: 'OAT-021:inventory-abuse',
            reason: 'INVENTORY_EXHAUSTED',
            points: 0,
            detail: committed.reason || 'Inventory exhausted',
          },
        ]);
        this.idempotencyCache.set(event.eventIdempotencyKey, exhaustedDecision);
        return exhaustedDecision;
      }

      if (event.eventType === 'CHECKOUT_ATTEMPT' && expeditingResult.grantNonce) {
        this.expediting.consumeGrant(expeditingResult.grantNonce);
      }
    }

    const finalDecision: RiskDecision = {
      decision,
      riskScore,
      reasons,
      decisionId: this.auditLog.nextDecisionId(),
      hardFailure,
      clusterSummary,
      supportingEventIds,
      ...(mlResult
        ? {
            mlScore: mlResult.mlScore,
            mlTopContributors: mlResult.topContributors,
          }
        : {}),
    };

    this.recordAuditAndStats(
      event,
      finalDecision,
      uniqueSignals.map((s) => ({
        rule: s.rule,
        reason: s.reason,
        points: s.points,
        detail: s.detail,
      }))
    );

    this.idempotencyCache.set(event.eventIdempotencyKey, finalDecision);
    return finalDecision;
  }

  private recordAuditAndStats(
    event: NormalizedSecurityEvent,
    result: RiskDecision,
    ruleContributions: DecisionAuditRecord['ruleContributions']
  ): void {
    this.totalEventsEvaluated += 1;
    if (result.decision === 'ALLOW') this.allowCount += 1;
    else if (result.decision === 'CHALLENGE') this.challengeCount += 1;
    else this.blockCount += 1;
    if (result.hardFailure) this.hardFailureCount += 1;

    this.auditLog.append({
      decisionId: result.decisionId,
      eventId: event.eventId,
      eventType: event.eventType,
      accountId: event.accountId,
      sessionId: event.sessionId,
      eventSaleId: event.eventContext.eventSaleId,
      networkId: event.eventContext.networkId,
      timestamp: event.timestamp,
      decision: result.decision,
      riskScore: result.riskScore,
      reasons: result.reasons,
      hardFailure: result.hardFailure,
      ruleContributions,
      clusterSummary: result.clusterSummary,
      supportingEventIds: result.supportingEventIds,
      ...(result.mlScore !== undefined ? { mlScore: result.mlScore } : {}),
      ...(result.mlTopContributors !== undefined ? { mlTopContributors: result.mlTopContributors } : {}),
    });
  }
}
