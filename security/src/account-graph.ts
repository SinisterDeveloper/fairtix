import { createHash } from 'node:crypto';
import type { NormalizedSecurityEvent } from './events.ts';

export interface AccountProfile {
  accountId: string;
  registeredAtMs: number | null;
  devices: Set<string>;
  payments: Set<string>;
  sessions: Set<string>;
  networks: Set<string>;
  eventsBySale: Map<string, NormalizedSecurityEvent[]>;
  queueJoinCountBySale: Map<string, number>;
  sensitiveActionTimesBySale: Map<string, number[]>;
  failedVerificationCount: number;
}

export interface ClusterAnalysis {
  clusterId: string;
  accountIds: string[];
  accountCount: number;
  sharedDevices: string[];
  sharedPayments: string[];
  sharedSessions: string[];
  sharedIdentifiers: string[];
  distinctNetworks: string[];
  distinctNetworkCount: number;
  competingAccountsInSale: string[];
  competingCount: number;
  recentRegistrationsInWindow: number;
  synchronizedAccountsInWindow: number;
  coordinatedAccountsInSaleWindow: number;
  accountQueueJoinCount: number;
  accountSensitiveActionsInWindow: number;
  clusterFailedVerifications: number;
  supportingEventIds: string[];
  isBenignHousehold: boolean;
}

export interface AccountGraphOptions {
  registrationWindowMs?: number;
  syncWindowMs?: number;
  saleCoordinationWindowMs?: number;
}

const SENSITIVE_ACTION_TYPES = new Set([
  'QUEUE_JOIN',
  'RESERVATION_CREATE',
  'CHECKOUT_ATTEMPT',
]);

/**
 * In-memory multi-entity relationship graph connecting accounts via strong
 * linkage signals (devices, payment tokens, and sessions).
 *
 * IMPORTANT: networkId (IP / Wi-Fi subnet) is recorded for telemetry only and
 * NEVER merged as a graph edge, preventing false-positive blocking of fans
 * on shared venue or campus Wi-Fi.
 */
export class AccountGraph {
  private readonly registrationWindowMs: number;
  private readonly syncWindowMs: number;
  private readonly saleCoordinationWindowMs: number;
  private readonly adjacency = new Map<string, Set<string>>();
  private readonly profiles = new Map<string, AccountProfile>();

  constructor(options: AccountGraphOptions = {}) {
    this.registrationWindowMs = options.registrationWindowMs ?? 60_000;
    this.syncWindowMs = options.syncWindowMs ?? 5_000;
    this.saleCoordinationWindowMs = options.saleCoordinationWindowMs ?? 60_000;
  }

  private ensureNode(nodeId: string): Set<string> {
    let neighbors = this.adjacency.get(nodeId);
    if (!neighbors) {
      neighbors = new Set();
      this.adjacency.set(nodeId, neighbors);
    }
    return neighbors;
  }

  private linkNodes(a: string, b: string): void {
    this.ensureNode(a).add(b);
    this.ensureNode(b).add(a);
  }

  private ensureProfile(accountId: string): AccountProfile {
    let profile = this.profiles.get(accountId);
    if (!profile) {
      profile = {
        accountId,
        registeredAtMs: null,
        devices: new Set(),
        payments: new Set(),
        sessions: new Set(),
        networks: new Set(),
        eventsBySale: new Map(),
        queueJoinCountBySale: new Map(),
        sensitiveActionTimesBySale: new Map(),
        failedVerificationCount: 0,
      };
      this.profiles.set(accountId, profile);
      this.ensureNode(`account:${accountId}`);
    }
    return profile;
  }

  recordEvent(event: NormalizedSecurityEvent): void {
    const profile = this.ensureProfile(event.accountId);
    const accNode = `account:${event.accountId}`;
    const ctx = event.eventContext;

    if (event.sessionId) {
      profile.sessions.add(event.sessionId);
      this.linkNodes(accNode, `session:${event.sessionId}`);
    }
    if (ctx.deviceId) {
      profile.devices.add(ctx.deviceId);
      this.linkNodes(accNode, `device:${ctx.deviceId}`);
    }
    if (ctx.paymentTokenHash) {
      profile.payments.add(ctx.paymentTokenHash);
      this.linkNodes(accNode, `payment:${ctx.paymentTokenHash}`);
    }
    if (ctx.networkId) {
      // Telemetry only; intentionally NOT added to strong linkage adjacency.
      profile.networks.add(ctx.networkId);
    }

    if (event.eventType === 'ACCOUNT_REGISTER' && profile.registeredAtMs === null) {
      profile.registeredAtMs = event.timestampMs;
    }

    const saleId = ctx.eventSaleId;
    let saleEvents = profile.eventsBySale.get(saleId);
    if (!saleEvents) {
      saleEvents = [];
      profile.eventsBySale.set(saleId, saleEvents);
    }
    saleEvents.push(event);

    if (event.eventType === 'QUEUE_JOIN') {
      profile.queueJoinCountBySale.set(saleId, (profile.queueJoinCountBySale.get(saleId) ?? 0) + 1);
    }

    if (SENSITIVE_ACTION_TYPES.has(event.eventType)) {
      let times = profile.sensitiveActionTimesBySale.get(saleId);
      if (!times) {
        times = [];
        profile.sensitiveActionTimesBySale.set(saleId, times);
      }
      times.push(event.timestampMs);
    }

    if (event.eventType === 'VERIFICATION_FAILED') {
      profile.failedVerificationCount += 1;
    }
  }

  getProfile(accountId: string): AccountProfile | undefined {
    return this.profiles.get(accountId);
  }

  getAllAccountIds(): string[] {
    return Array.from(this.profiles.keys());
  }

  /**
   * Discovers the connected component containing `accountId` via BFS over strong
   * device/payment/session edges and computes sale-scoped behavioral metrics.
   */
  getClusterForAccount(accountId: string, eventSaleId: string, nowMs: number): ClusterAnalysis {
    const startNode = `account:${accountId}`;
    const visited = new Set<string>();
    const queue: string[] = [startNode];
    visited.add(startNode);

    const accountIds: string[] = [];
    const deviceDegrees = new Map<string, number>();
    const paymentDegrees = new Map<string, number>();
    const sessionDegrees = new Map<string, number>();

    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current.startsWith('account:')) {
        accountIds.push(current.slice('account:'.length));
      }
      const neighbors = this.adjacency.get(current);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (current.startsWith('account:')) {
          if (next.startsWith('device:')) {
            const id = next.slice('device:'.length);
            deviceDegrees.set(id, (deviceDegrees.get(id) ?? 0) + 1);
          } else if (next.startsWith('payment:')) {
            const id = next.slice('payment:'.length);
            paymentDegrees.set(id, (paymentDegrees.get(id) ?? 0) + 1);
          } else if (next.startsWith('session:')) {
            const id = next.slice('session:'.length);
            sessionDegrees.set(id, (sessionDegrees.get(id) ?? 0) + 1);
          }
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    accountIds.sort();

    const sharedDevices = Array.from(deviceDegrees.entries())
      .filter(([, count]) => count >= 2)
      .map(([id]) => id)
      .sort();
    const sharedPayments = Array.from(paymentDegrees.entries())
      .filter(([, count]) => count >= 2)
      .map(([id]) => id)
      .sort();
    const sharedSessions = Array.from(sessionDegrees.entries())
      .filter(([, count]) => count >= 2)
      .map(([id]) => id)
      .sort();

    const sharedIdentifiers = [
      ...sharedDevices.map((d) => `device:${d}`),
      ...sharedPayments.map((p) => `payment:${p}`),
      ...sharedSessions.map((s) => `session:${s}`),
    ];

    const distinctNetworksSet = new Set<string>();
    const competingAccountsInSale: string[] = [];
    const regTimestamps: number[] = [];
    const synchronizedAccounts = new Set<string>();
    const coordinatedAccounts = new Set<string>();
    let clusterFailedVerifications = 0;
    let duplicateQueueJoinsInCluster = 0;
    const recentClusterEvents: NormalizedSecurityEvent[] = [];

    for (const accId of accountIds) {
      const profile = this.profiles.get(accId);
      if (!profile) continue;

      for (const net of profile.networks) {
        distinctNetworksSet.add(net);
      }
      if (profile.registeredAtMs !== null) {
        regTimestamps.push(profile.registeredAtMs);
      }
      clusterFailedVerifications += profile.failedVerificationCount;
      const joins = profile.queueJoinCountBySale.get(eventSaleId) ?? 0;
      if (joins > 1) {
        duplicateQueueJoinsInCluster += joins - 1;
      }

      const saleEvents = profile.eventsBySale.get(eventSaleId) ?? [];
      if (saleEvents.length > 0) {
        competingAccountsInSale.push(accId);
        for (const ev of saleEvents) {
          recentClusterEvents.push(ev);
        }
      }

      const actionTimes = profile.sensitiveActionTimesBySale.get(eventSaleId) ?? [];
      if (actionTimes.some((t) => nowMs - t >= 0 && nowMs - t <= this.syncWindowMs)) {
        synchronizedAccounts.add(accId);
      }
      if (actionTimes.some((t) => nowMs - t >= 0 && nowMs - t <= this.saleCoordinationWindowMs)) {
        coordinatedAccounts.add(accId);
      }
    }

    // Measure peak registration burst within any registrationWindowMs sliding window
    // so farms that mass-register minutes before sale open are still flagged at checkout.
    regTimestamps.sort((a, b) => a - b);
    let maxRegBurst = 0;
    let left = 0;
    for (let right = 0; right < regTimestamps.length; right++) {
      while (regTimestamps[right] - regTimestamps[left] > this.registrationWindowMs) {
        left += 1;
      }
      const windowCount = right - left + 1;
      if (windowCount > maxRegBurst) {
        maxRegBurst = windowCount;
      }
    }
    const recentWindowRegs = regTimestamps.filter(
      (t) => nowMs - t >= 0 && nowMs - t <= this.registrationWindowMs
    ).length;
    const recentRegistrationsInWindow = Math.max(recentWindowRegs, maxRegBurst);

    const currentProfile = this.profiles.get(accountId);
    const accountQueueJoinCount = currentProfile?.queueJoinCountBySale.get(eventSaleId) ?? 0;
    const accountSensitiveActionsInWindow = (
      currentProfile?.sensitiveActionTimesBySale.get(eventSaleId) ?? []
    ).filter((t) => nowMs - t >= 0 && nowMs - t <= this.syncWindowMs).length;

    recentClusterEvents.sort((a, b) => a.timestampMs - b.timestampMs);
    const supportingEventIds = recentClusterEvents.slice(-12).map((e) => e.eventId);

    const clusterHash = createHash('sha256')
      .update(accountIds.join('|'))
      .digest('hex')
      .slice(0, 10);
    const clusterId = accountIds.length > 1 ? `cluster_${clusterHash}` : `solo_${accountId}`;

    // A household of <= 2 accounts sharing a device/payment card with normal pacing
    // and no failed verifications or duplicate entries is treated as benign.
    const isBenignHousehold =
      accountIds.length === 2 &&
      recentRegistrationsInWindow <= 2 &&
      synchronizedAccounts.size <= 1 &&
      clusterFailedVerifications === 0 &&
      duplicateQueueJoinsInCluster === 0;

    const distinctNetworks = Array.from(distinctNetworksSet).sort();

    return {
      clusterId,
      accountIds,
      accountCount: accountIds.length,
      sharedDevices,
      sharedPayments,
      sharedSessions,
      sharedIdentifiers,
      distinctNetworks,
      distinctNetworkCount: distinctNetworks.length,
      competingAccountsInSale,
      competingCount: competingAccountsInSale.length,
      recentRegistrationsInWindow,
      synchronizedAccountsInWindow: synchronizedAccounts.size,
      coordinatedAccountsInSaleWindow: coordinatedAccounts.size,
      accountQueueJoinCount,
      accountSensitiveActionsInWindow,
      clusterFailedVerifications,
      supportingEventIds,
      isBenignHousehold,
    };
  }

  /**
   * Returns all multi-account connected components currently discovered in the graph.
   */
  listMultiAccountClusters(eventSaleId: string, nowMs: number): ClusterAnalysis[] {
    const seenClusterIds = new Set<string>();
    const clusters: ClusterAnalysis[] = [];
    for (const accId of this.profiles.keys()) {
      const analysis = this.getClusterForAccount(accId, eventSaleId, nowMs);
      if (analysis.accountCount > 1 && !seenClusterIds.has(analysis.clusterId)) {
        seenClusterIds.add(analysis.clusterId);
        clusters.push(analysis);
      }
    }
    return clusters.sort((a, b) => b.accountCount - a.accountCount);
  }
}
