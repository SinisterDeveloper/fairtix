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
  clusterHeldQuantity: number;
  convertedHoldQuantity: number;
  availableInventory: number;
}

function convertibleHold(sale: SaleInventoryState, event: NormalizedSecurityEvent): HoldRecord | undefined {
  const id = event.eventContext.reservationId;
  const hold = id ? sale.holds.get(id) : undefined;
  if (hold?.status === 'ACTIVE' && hold.accountId === event.accountId && hold.quantity >= event.quantity) {
    return hold;
  }
}

interface ActiveHoldIndex {
  holds: Set<HoldRecord>;
  byAccount: Map<string, { count: number; quantity: number }>;
  nextExpiry: number;
}

/**
 * Priority 1 — OAT-021: Denial of Inventory Guard.
 * Tracks inventory holds, enforces per-account/per-cluster hold limits,
 * detects repeated reservation abandonment, and guarantees exact-once
 * restoration of inventory when holds expire or are abandoned.
 */
export class InventoryAbuseGuard {
  private readonly sales = new Map<string, SaleInventoryState>();
  private readonly activeHolds = new WeakMap<SaleInventoryState, ActiveHoldIndex>();

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
    this.activeHolds.set(state, { holds: new Set(), byAccount: new Map(), nextExpiry: Infinity });
    this.sales.set(eventSaleId, state);
    return state;
  }

  getSaleState(eventSaleId: string): SaleInventoryState {
    return this.sales.get(eventSaleId) ?? this.configureSale(eventSaleId);
  }

  private removeActiveHold(sale: SaleInventoryState, hold: HoldRecord): void {
    const index = this.activeHolds.get(sale)!;
    index.holds.delete(hold);
    const account = index.byAccount.get(hold.accountId)!;
    account.count -= 1;
    account.quantity -= hold.quantity;
    if (account.count === 0) index.byAccount.delete(hold.accountId);
    if (index.holds.size === 0) index.nextExpiry = Infinity;
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
    this.removeActiveHold(sale, hold);
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
    const index = this.activeHolds.get(sale)!;
    const expiredIds: string[] = [];
    if (nowMs < index.nextExpiry) return expiredIds;

    index.nextExpiry = Infinity;
    for (const hold of index.holds) {
      if (hold.expiresAtMs <= nowMs) {
        if (this.releaseHoldExactOnce(sale, hold, 'EXPIRED', nowMs)) {
          expiredIds.push(hold.reservationId);
        }
      } else {
        index.nextExpiry = Math.min(index.nextExpiry, hold.expiresAtMs);
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

    const index = this.activeHolds.get(sale)!;
    const accountAbandoned = sale.abandonedByAccount.get(event.accountId) ?? 0;
    const accountActiveHolds = index.byAccount.get(event.accountId)?.count ?? 0;
    const accountSoldCount = sale.soldByAccount.get(event.accountId) ?? 0;
    let clusterAbandoned = 0;
    let clusterActiveHolds = 0;
    let clusterHeldQuantity = 0;
    let clusterSoldCount = 0;
    for (const accId of cluster.accountIds) {
      clusterAbandoned += sale.abandonedByAccount.get(accId) ?? 0;
      clusterSoldCount += sale.soldByAccount.get(accId) ?? 0;
      const active = index.byAccount.get(accId);
      clusterActiveHolds += active?.count ?? 0;
      clusterHeldQuantity += active?.quantity ?? 0;
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

    let convertedHoldQuantity = 0;
    if (event.eventType === 'CHECKOUT_ATTEMPT') {
      convertedHoldQuantity = convertibleHold(sale, event)?.quantity ?? 0;
      if (protectionsEnabled && accountSoldCount + event.quantity > sale.maxTicketsPerAccount) {
        signals.push({
          rule: 'purchase-limit',
          reason: 'ACCOUNT_PURCHASE_LIMIT_EXCEEDED',
          points: 0,
          hardFailure: true,
          detail: `Account exceeded the ticket limit (${sale.maxTicketsPerAccount})`,
          supportingEventIds: [event.eventId],
        });
      }

      if (!convertedHoldQuantity && sale.availableInventory < event.quantity) {
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
      clusterHeldQuantity,
      convertedHoldQuantity,
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
      const hold: HoldRecord = {
        reservationId,
        accountId: event.accountId,
        eventSaleId: event.eventContext.eventSaleId,
        quantity: event.quantity,
        createdAtMs: event.timestampMs,
        expiresAtMs: event.timestampMs + ttl,
        status: 'ACTIVE',
      };
      sale.holds.set(reservationId, hold);
      const index = this.activeHolds.get(sale)!;
      index.holds.add(hold);
      index.nextExpiry = Math.min(index.nextExpiry, hold.expiresAtMs);
      const account = index.byAccount.get(event.accountId) ?? { count: 0, quantity: 0 };
      account.count += 1;
      account.quantity += hold.quantity;
      index.byAccount.set(event.accountId, account);
      return { committed: true, reservationId };
    }

    if (event.eventType === 'CHECKOUT_ATTEMPT') {
      const existingHold = convertibleHold(sale, event);
      if (existingHold) {
        existingHold.status = 'CONVERTED';
        this.removeActiveHold(sale, existingHold);
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
