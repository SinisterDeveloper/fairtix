import type { ClusterAnalysis } from './account-graph.ts';
import type { NormalizedSecurityEvent } from './events.ts';
import type { InventoryEvaluationResult, SaleInventoryState } from './rules/inventory-abuse.ts';

export const ML_FEATURE_NAMES = [
  'queueToReserveMs',
  'reserveToCheckoutMs',
  'interEventMeanMs',
  'interEventCv',
  'eventsPerMinute',
  'sessionEventCount',
  'skippedReservation',
  'abandonmentRatio',
  'clusterAccountCount',
  'competingInSaleCount',
  'sharedIdentifierCount',
] as const;

export type MlFeatureName = (typeof ML_FEATURE_NAMES)[number];

export type BehavioralFeatureVector = Record<MlFeatureName, number>;

interface SessionTelemetryState {
  firstEventMs: number;
  lastEventMs: number;
  queueJoinMs: number | null;
  reserveCreateMs: number | null;
  checkoutMs: number | null;
  intervalsMs: number[];
  eventCount: number;
  hasReservationCreate: boolean;
}

/**
 * Server-side behavioral & timing telemetry tracker.
 * Computes pacing, jitter (coefficient of variation), and funnel transitions
 * strictly from server-observed event timestamps—never trusting client claims.
 */
export class SessionBehaviorTracker {
  private readonly sessions = new Map<string, SessionTelemetryState>();

  recordAndExtract(
    event: NormalizedSecurityEvent,
    cluster: ClusterAnalysis,
    saleState: SaleInventoryState,
    inventoryResult: InventoryEvaluationResult
  ): BehavioralFeatureVector {
    const key = `${event.accountId}::${event.sessionId}::${event.eventContext.eventSaleId}`;
    let state = this.sessions.get(key);

    if (!state) {
      state = {
        firstEventMs: event.timestampMs,
        lastEventMs: event.timestampMs,
        queueJoinMs: null,
        reserveCreateMs: null,
        checkoutMs: null,
        intervalsMs: [],
        eventCount: 0,
        hasReservationCreate: false,
      };
      this.sessions.set(key, state);
    } else {
      const deltaMs = Math.max(0, event.timestampMs - state.lastEventMs);
      state.intervalsMs.push(deltaMs);
      if (event.timestampMs > state.lastEventMs) {
        state.lastEventMs = event.timestampMs;
      }
    }

    state.eventCount += 1;

    if (event.eventType === 'QUEUE_JOIN' && state.queueJoinMs === null) {
      state.queueJoinMs = event.timestampMs;
    } else if (event.eventType === 'RESERVATION_CREATE') {
      state.hasReservationCreate = true;
      if (state.reserveCreateMs === null) {
        state.reserveCreateMs = event.timestampMs;
      }
    } else if (event.eventType === 'CHECKOUT_ATTEMPT' && state.checkoutMs === null) {
      state.checkoutMs = event.timestampMs;
    }

    // Default neutral human-like timing when a transition hasn't happened yet
    const queueToReserveMs =
      state.queueJoinMs !== null && state.reserveCreateMs !== null
        ? Math.max(0, state.reserveCreateMs - state.queueJoinMs)
        : state.queueJoinMs !== null && state.checkoutMs !== null
          ? Math.max(0, state.checkoutMs - state.queueJoinMs)
          : 2500;

    const reserveToCheckoutMs =
      state.reserveCreateMs !== null && state.checkoutMs !== null
        ? Math.max(0, state.checkoutMs - state.reserveCreateMs)
        : state.queueJoinMs !== null && state.checkoutMs !== null && !state.hasReservationCreate
          ? Math.max(0, state.checkoutMs - state.queueJoinMs)
          : 2500;

    let interEventMeanMs = 2000;
    let interEventCv = 0.35;
    if (state.intervalsMs.length > 0) {
      const sum = state.intervalsMs.reduce((a, b) => a + b, 0);
      interEventMeanMs = sum / state.intervalsMs.length;
      if (state.intervalsMs.length >= 2 && interEventMeanMs > 0) {
        const variance =
          state.intervalsMs.reduce((acc, v) => acc + (v - interEventMeanMs) ** 2, 0) /
          state.intervalsMs.length;
        interEventCv = Math.sqrt(variance) / interEventMeanMs;
      } else {
        // With only 1 interval, infer mild neutral variance unless sub-second robotic speed
        interEventCv = interEventMeanMs < 500 ? 0.05 : 0.3;
      }
    }

    const elapsedMinutes = Math.max(0.01, (state.lastEventMs - state.firstEventMs) / 60_000);
    const eventsPerMinute = state.eventCount >= 2 ? Math.min(240, state.eventCount / elapsedMinutes) : 12;

    const skippedReservation =
      event.eventType === 'CHECKOUT_ATTEMPT' && !state.hasReservationCreate ? 1 : 0;

    // Preserve shared-Wi-Fi & benign 2-account household protections in graph features
    const effectiveClusterSize = cluster.isBenignHousehold ? 1 : cluster.accountCount;
    const effectiveCompeting = cluster.isBenignHousehold ? 1 : cluster.competingCount;
    const effectiveSharedIds = cluster.isBenignHousehold ? 0 : cluster.sharedIdentifiers.length;

    const abandonedCount = saleState.abandonedByAccount.get(event.accountId) ?? 0;
    const totalAccountOutcomes =
      abandonedCount + inventoryResult.accountSoldCount + inventoryResult.accountActiveHolds;
    const abandonmentRatio =
      totalAccountOutcomes > 0 ? Math.min(1, abandonedCount / totalAccountOutcomes) : 0;

    return {
      queueToReserveMs: Math.min(30_000, queueToReserveMs),
      reserveToCheckoutMs: Math.min(30_000, reserveToCheckoutMs),
      interEventMeanMs: Math.min(30_000, interEventMeanMs),
      interEventCv: Math.min(2.0, interEventCv),
      eventsPerMinute,
      sessionEventCount: state.eventCount,
      skippedReservation,
      abandonmentRatio,
      clusterAccountCount: effectiveClusterSize,
      competingInSaleCount: effectiveCompeting,
      sharedIdentifierCount: effectiveSharedIds,
    };
  }
}

export function featureVectorToArray(vec: BehavioralFeatureVector): number[] {
  return ML_FEATURE_NAMES.map((name) => vec[name]);
}
