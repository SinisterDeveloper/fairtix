import type { ClusterAnalysis } from '../account-graph.ts';
import type { RuleSignal } from '../decisions.ts';
import { RISK_WEIGHTS } from '../decisions.ts';
import type { NormalizedSecurityEvent } from '../events.ts';

export interface SaleInventoryConfig {
  capacity?: number;
  holdTtlMs?: number;
  maxActiveHoldsPerAccount?: number;
  maxActiveHoldsPerCluster?: number;
  maxTicketsPerAccount?: number;
  maxTicketsPerCluster?: number;
}

export interface HoldRecord {
  reservationId: string;
  accountId: string;
  eventSaleId: string;
  quantity: number;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'ACTIVE' | 'ABANDONED' | 'EXPIRED' | 'CONVERTED';
  releasedAtMs?: number;
}

export interface SaleInventoryState {
  eventSaleId: string;
  capacity: number;
  availableInventory: number;
  soldInventory: number;
  holdTtlMs: number;
  maxActiveHoldsPerAccount: number;
  maxActiveHoldsPerCluster: number;
  maxTicketsPerAccount: number;
  maxTicketsPerCluster: number;
  holds: Map<string, HoldRecord>;
  releasedHoldIds: Set<string>;
  exactOnceReleaseCount: number;
  duplicateReleaseAttemptsIgnored: number;
  soldByAccount: Map<string, number>;
  abandonedByAccount: Map<string, number>;
  processedStandaloneAbandons: Set<string>;
}

export interface InventoryEvaluationResult {
  signals: RuleSignal[];
  expiredReservationIds: string[];
  accountSoldCount: number;
  clusterSoldCount: number;
  accountActiveHolds: number;
  clusterActiveHolds: number;
  availableInventory: number;
}

/**
 * Priority 1 — OAT-021: Denial of Inventory Guard.
 * Tracks inventory holds, enforces per-account/per-cluster hold limits,
 * detects repeated reservation abandonment, and guarantees exact-once
 * restoration of inventory when holds expire or are abandoned.
 */
export class InventoryAbuseGuard {
  private readonly sales = new Map<string, SaleInventoryState>();

  configureSale(eventSaleId: string, config: SaleInventoryConfig = {}): SaleInventoryState {
    const existing = this.sales.get(eventSaleId);
    if (existing) {
      if (config.capacity !== undefined) {
        const diff = config.capacity - existing.capacity;
        existing.capacity = config.capacity;
        existing.availableInventory = Math.max(0, existing.availableInventory + diff);
      }
      if (config.holdTtlMs !== undefined) existing.holdTtlMs = config.holdTtlMs;
      if (config.maxActiveHoldsPerAccount !== undefined) {
        existing.maxActiveHoldsPerAccount = config.maxActiveHoldsPerAccount;
      }
      if (config.maxActiveHoldsPerCluster !== undefined) {
        existing.maxActiveHoldsPerCluster = config.maxActiveHoldsPerCluster;
      }
      if (config.maxTicketsPerAccount !== undefined) {
        existing.maxTicketsPerAccount = config.maxTicketsPerAccount;
      }
      if (config.maxTicketsPerCluster !== undefined) {
        existing.maxTicketsPerCluster = config.maxTicketsPerCluster;
      }
      return existing;
    }

    const capacity = config.capacity ?? 100;
    const state: SaleInventoryState = {
      eventSaleId,
      capacity,
      availableInventory: capacity,
      soldInventory: 0,
      holdTtlMs: config.holdTtlMs ?? 120_000,
      maxActiveHoldsPerAccount: config.maxActiveHoldsPerAccount ?? 1,
      maxActiveHoldsPerCluster: config.maxActiveHoldsPerCluster ?? 3,
      maxTicketsPerAccount: config.maxTicketsPerAccount ?? 2,
      maxTicketsPerCluster: config.maxTicketsPerCluster ?? 4,
      holds: new Map(),
      releasedHoldIds: new Set(),
      exactOnceReleaseCount: 0,
      duplicateReleaseAttemptsIgnored: 0,
      soldByAccount: new Map(),
      abandonedByAccount: new Map(),
      processedStandaloneAbandons: new Set(),
    };
    this.sales.set(eventSaleId, state);
    return state;
  }

  getSaleState(eventSaleId: string): SaleInventoryState {
    return this.sales.get(eventSaleId) ?? this.configureSale(eventSaleId);
  }

  private releaseHoldExactOnce(
    sale: SaleInventoryState,
    hold: HoldRecord,
    newStatus: 'EXPIRED' | 'ABANDONED',
    nowMs: number
  ): boolean {
    if (sale.releasedHoldIds.has(hold.reservationId) || hold.status !== 'ACTIVE') {
      sale.duplicateReleaseAttemptsIgnored += 1;
      return false;
    }
    hold.status = newStatus;
    hold.releasedAtMs = nowMs;
    sale.releasedHoldIds.add(hold.reservationId);
    sale.availableInventory = Math.min(sale.capacity, sale.availableInventory + hold.quantity);
    sale.exactOnceReleaseCount += 1;
    sale.abandonedByAccount.set(
      hold.accountId,
      (sale.abandonedByAccount.get(hold.accountId) ?? 0) + 1
    );
    return true;
  }

  /**
   * Sweeps any active holds whose TTL has elapsed at `nowMs` and restores
   * their inventory exactly once.
   */
  sweepExpiredHolds(eventSaleId: string, nowMs: number): string[] {
    const sale = this.getSaleState(eventSaleId);
    const expiredIds: string[] = [];
    for (const hold of sale.holds.values()) {
      if (hold.status === 'ACTIVE' && hold.expiresAtMs <= nowMs) {
        if (this.releaseHoldExactOnce(sale, hold, 'EXPIRED', nowMs)) {
          expiredIds.push(hold.reservationId);
        }
      }
    }
    return expiredIds;
  }

  evaluate(
    event: NormalizedSecurityEvent,
    cluster: ClusterAnalysis,
    protectionsEnabled: boolean
  ): InventoryEvaluationResult {
    const saleId = event.eventContext.eventSaleId;
    const sale = this.getSaleState(saleId);
    const expiredReservationIds = this.sweepExpiredHolds(saleId, event.timestampMs);
    const signals: RuleSignal[] = [];

    if (event.eventType === 'RESERVATION_ABANDON' || event.eventType === 'RESERVATION_EXPIRE') {
      const targetResId = event.eventContext.reservationId;
      const targetStatus = event.eventType === 'RESERVATION_EXPIRE' ? 'EXPIRED' : 'ABANDONED';
      if (targetResId && sale.holds.has(targetResId)) {
        const hold = sale.holds.get(targetResId) as HoldRecord;
        this.releaseHoldExactOnce(sale, hold, targetStatus, event.timestampMs);
      } else {
        const dedupKey = targetResId || event.eventId;
        if (!sale.processedStandaloneAbandons.has(dedupKey)) {
          sale.processedStandaloneAbandons.add(dedupKey);
          sale.abandonedByAccount.set(
            event.accountId,
            (sale.abandonedByAccount.get(event.accountId) ?? 0) + 1
          );
        } else {
          sale.duplicateReleaseAttemptsIgnored += 1;
        }
      }
    }

    const accountAbandoned = sale.abandonedByAccount.get(event.accountId) ?? 0;
    let clusterAbandoned = 0;
    for (const accId of cluster.accountIds) {
      clusterAbandoned += sale.abandonedByAccount.get(accId) ?? 0;
    }

    if (accountAbandoned >= 2 || (!cluster.isBenignHousehold && clusterAbandoned >= 3)) {
      signals.push({
        rule: 'OAT-021:inventory-abuse',
        reason: 'ABNORMAL_RESERVATION_ABANDONMENT',
        points: RISK_WEIGHTS.ABNORMAL_RESERVATION_ABANDONMENT,
        detail: `Account ${event.accountId} has ${accountAbandoned} abandoned/expired holds (cluster total: ${clusterAbandoned})`,
        supportingEventIds: [event.eventId],
      });
    }

    let accountActiveHolds = 0;
    let clusterActiveHolds = 0;
    const clusterSet = new Set(cluster.accountIds);
    for (const hold of sale.holds.values()) {
      if (hold.status === 'ACTIVE') {
        if (hold.accountId === event.accountId) accountActiveHolds += 1;
        if (clusterSet.has(hold.accountId)) clusterActiveHolds += 1;
      }
    }

    const accountSoldCount = sale.soldByAccount.get(event.accountId) ?? 0;
    let clusterSoldCount = 0;
    for (const accId of cluster.accountIds) {
      clusterSoldCount += sale.soldByAccount.get(accId) ?? 0;
    }

    if (event.eventType === 'RESERVATION_CREATE') {
      if (protectionsEnabled) {
        if (accountActiveHolds >= sale.maxActiveHoldsPerAccount) {
          signals.push({
            rule: 'OAT-021:inventory-abuse',
            reason: 'HOLD_LIMIT_EXCEEDED',
            points: 0,
            hardFailure: true,
            detail: `Account ${event.accountId} exceeded active hold limit (${sale.maxActiveHoldsPerAccount})`,
            supportingEventIds: [event.eventId],
          });
        } else if (!cluster.isBenignHousehold && clusterActiveHolds >= sale.maxActiveHoldsPerCluster) {
          signals.push({
            rule: 'OAT-021:inventory-abuse',
            reason: 'HOLD_LIMIT_EXCEEDED',
            points: 0,
            hardFailure: true,
            detail: `Linked cluster ${cluster.clusterId} exceeded active hold limit (${sale.maxActiveHoldsPerCluster})`,
            supportingEventIds: [event.eventId],
          });
        }
      }

      if (sale.availableInventory < event.quantity) {
        signals.push({
          rule: 'OAT-021:inventory-abuse',
          reason: 'INVENTORY_EXHAUSTED',
          points: 0,
          hardFailure: true,
          detail: `Requested ${event.quantity} ticket(s), but only ${sale.availableInventory} available`,
          supportingEventIds: [event.eventId],
        });
      }
    }

    if (event.eventType === 'CHECKOUT_ATTEMPT') {
      const resId = event.eventContext.reservationId;
      const existingHold = resId ? sale.holds.get(resId) : undefined;
      const usesValidOwnHold =
        existingHold !== undefined &&
        existingHold.status === 'ACTIVE' &&
        existingHold.accountId === event.accountId &&
        existingHold.quantity >= event.quantity;

      if (!usesValidOwnHold && sale.availableInventory < event.quantity) {
        signals.push({
          rule: 'OAT-021:inventory-abuse',
          reason: 'INVENTORY_EXHAUSTED',
          points: 0,
          hardFailure: true,
          detail: `Insufficient remaining inventory (${sale.availableInventory}) for checkout`,
          supportingEventIds: [event.eventId],
        });
      }
    }

    return {
      signals,
      expiredReservationIds,
      accountSoldCount,
      clusterSoldCount,
      accountActiveHolds,
      clusterActiveHolds,
      availableInventory: sale.availableInventory,
    };
  }

  /**
   * Commits a reservation hold or checkout sale strictly within available capacity
   * so concurrent bursts can never oversell tickets.
   */
  commitIfAllowed(event: NormalizedSecurityEvent): { committed: boolean; reservationId?: string; reason?: string } {
    const sale = this.getSaleState(event.eventContext.eventSaleId);

    if (event.eventType === 'RESERVATION_CREATE') {
      if (sale.availableInventory < event.quantity) {
        return { committed: false, reason: 'INVENTORY_EXHAUSTED' };
      }
      const reservationId = event.eventContext.reservationId || `res_${event.eventId}`;
      if (sale.holds.has(reservationId)) {
        return { committed: true, reservationId };
      }
      const ttl = event.eventContext.holdTtlMs ?? sale.holdTtlMs;
      sale.availableInventory -= event.quantity;
      sale.holds.set(reservationId, {
        reservationId,
        accountId: event.accountId,
        eventSaleId: event.eventContext.eventSaleId,
        quantity: event.quantity,
        createdAtMs: event.timestampMs,
        expiresAtMs: event.timestampMs + ttl,
        status: 'ACTIVE',
      });
      return { committed: true, reservationId };
    }

    if (event.eventType === 'CHECKOUT_ATTEMPT') {
      const resId = event.eventContext.reservationId;
      const existingHold = resId ? sale.holds.get(resId) : undefined;
      if (existingHold && existingHold.status === 'ACTIVE' && existingHold.accountId === event.accountId) {
        existingHold.status = 'CONVERTED';
        const diff = existingHold.quantity - event.quantity;
        if (diff > 0) {
          sale.availableInventory = Math.min(sale.capacity, sale.availableInventory + diff);
        }
        sale.soldInventory += event.quantity;
        sale.soldByAccount.set(
          event.accountId,
          (sale.soldByAccount.get(event.accountId) ?? 0) + event.quantity
        );
        return { committed: true, reservationId: existingHold.reservationId };
      }

      if (sale.availableInventory < event.quantity) {
        return { committed: false, reason: 'INVENTORY_EXHAUSTED' };
      }
      sale.availableInventory -= event.quantity;
      sale.soldInventory += event.quantity;
      sale.soldByAccount.set(
        event.accountId,
        (sale.soldByAccount.get(event.accountId) ?? 0) + event.quantity
      );
      return { committed: true };
    }

    return { committed: true };
  }
}
