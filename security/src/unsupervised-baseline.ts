import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuleSignal } from './decisions.ts';
import type { BehavioralFeatureVector } from './ml-features.ts';

export const UNSUPERVISED_BEHAVIORAL_FEATURES = [
  'queueToReserveMs',
  'reserveToCheckoutMs',
  'interEventMeanMs',
  'interEventCv',
  'eventsPerMinute',
  'abandonmentRatio',
] as const;

export type UnsupervisedFeatureName = (typeof UNSUPERVISED_BEHAVIORAL_FEATURES)[number];

/**
 * Direction of suspicious deviation from legitimate human baseline:
 * -1: abnormally LOW values are suspicious (e.g., robotic sub-second pacing, near-zero jitter)
 * +1: abnormally HIGH values are suspicious (e.g., burst events/min, high abandonment)
 */
const SUSPICIOUS_DIRECTION: Record<UnsupervisedFeatureName, -1 | 1> = {
  queueToReserveMs: -1,
  reserveToCheckoutMs: -1,
  interEventMeanMs: -1,
  interEventCv: -1,
  eventsPerMinute: 1,
  abandonmentRatio: 1,
};

export interface BaselineStatsSnapshot {
  sampleCount: number;
  means: Record<UnsupervisedFeatureName, number>;
  m2: Record<UnsupervisedFeatureName, number>;
  stds: Record<UnsupervisedFeatureName, number>;
  updatedAt: string;
}

export interface UnsupervisedEvaluationResult {
  anomalyScore: number; // 0-100 scaled score
  sigmaDistance: number;
  topDeviations: Array<{ feature: UnsupervisedFeatureName; zScore: number }>;
  signal: RuleSignal | null;
}

/**
 * Default cold-start human baseline (used before enough live human traces accumulate).
 * Slow/patient humans are never penalized due to directional Z-score clamping.
 */
const DEFAULT_HUMAN_BASELINE: BaselineStatsSnapshot = {
  sampleCount: 50,
  means: {
    queueToReserveMs: 2400,
    reserveToCheckoutMs: 2600,
    interEventMeanMs: 2000,
    interEventCv: 0.38,
    eventsPerMinute: 28,
    abandonmentRatio: 0.03,
  },
  m2: {
    queueToReserveMs: 50 * 900 ** 2,
    reserveToCheckoutMs: 50 * 1000 ** 2,
    interEventMeanMs: 50 * 700 ** 2,
    interEventCv: 50 * 0.12 ** 2,
    eventsPerMinute: 50 * 14 ** 2,
    abandonmentRatio: 50 * 0.08 ** 2,
  },
  stds: {
    queueToReserveMs: 900,
    reserveToCheckoutMs: 1000,
    interEventMeanMs: 700,
    interEventCv: 0.12,
    eventsPerMinute: 14,
    abandonmentRatio: 0.08,
  },
  updatedAt: '2026-11-21T00:00:00.000Z',
};

export interface UnsupervisedBaselineOptions {
  baselinePath?: string | null;
  liveTracePath?: string | null;
  challengeSigmaThreshold?: number;
  blockSigmaThreshold?: number;
  minSessionEvents?: number;
}

/**
 * Unsupervised Human-Baseline Anomaly Detector + Live Trace Auto-Learner.
 *
 * Uses Welford's online algorithm to continuously update mean/variance from
 * clean ALLOW human sessions (no bot labels required), and flags out-of-distribution
 * robotic pacing / abandonment using directional RMS Z-score distance.
 */
export class UnsupervisedBaselineDetector {
  private readonly baselinePath: string | null;
  private readonly liveTracePath: string | null;
  private readonly challengeSigma: number;
  private readonly blockSigma: number;
  private readonly minSessionEvents: number;
  private baseline: BaselineStatsSnapshot;
  private readonly liveTraces: Array<{
    timestamp: string;
    accountId: string;
    decision: string;
    features: BehavioralFeatureVector;
  }> = [];

  constructor(options: UnsupervisedBaselineOptions = {}) {
    this.baselinePath = options.baselinePath ?? null;
    this.liveTracePath = options.liveTracePath ?? null;
    this.challengeSigma = options.challengeSigmaThreshold ?? 3.1;
    this.blockSigma = options.blockSigmaThreshold ?? 4.5;
    this.minSessionEvents = options.minSessionEvents ?? 3;
    this.baseline = this.loadOrDefaultBaseline();
  }

  private loadOrDefaultBaseline(): BaselineStatsSnapshot {
    if (this.baselinePath && existsSync(this.baselinePath)) {
      try {
        return JSON.parse(readFileSync(this.baselinePath, 'utf8')) as BaselineStatsSnapshot;
      } catch {
        // Fall back to default if corrupted
      }
    }
    return structuredClone(DEFAULT_HUMAN_BASELINE);
  }

  getBaselineSnapshot(): BaselineStatsSnapshot {
    return structuredClone(this.baseline);
  }

  getLiveTracesCount(): number {
    return this.liveTraces.length;
  }

  exportLiveTraces(): Array<{
    timestamp: string;
    accountId: string;
    decision: string;
    features: BehavioralFeatureVector;
  }> {
    return this.liveTraces.slice();
  }

  evaluate(features: BehavioralFeatureVector, eventId: string): UnsupervisedEvaluationResult {
    const directionalZScores: Array<{ feature: UnsupervisedFeatureName; zScore: number }> = [];
    let sumSq = 0;

    for (const feat of UNSUPERVISED_BEHAVIORAL_FEATURES) {
      const val = features[feat];
      const mean = this.baseline.means[feat];
      const std = Math.max(1e-4, this.baseline.stds[feat]);
      const dir = SUSPICIOUS_DIRECTION[feat];
      const rawZ = (val - mean) / std;
      // Only penalize deviations in the suspicious direction (e.g. faster, not slower)
      const dirZ = Math.max(0, dir * rawZ);
      sumSq += dirZ * dirZ;
      if (dirZ > 0.5) {
        directionalZScores.push({ feature: feat, zScore: Number(dirZ.toFixed(3)) });
      }
    }

    const sigmaDistance = Math.sqrt(sumSq / UNSUPERVISED_BEHAVIORAL_FEATURES.length);
    const anomalyScore = Math.min(100, Math.round((sigmaDistance / 5.5) * 100));
    const topDeviations = directionalZScores.sort((a, b) => b.zScore - a.zScore).slice(0, 3);

    let signal: RuleSignal | null = null;
    if (features.sessionEventCount >= this.minSessionEvents) {
      if (sigmaDistance >= this.blockSigma) {
        signal = {
          rule: 'ML:unsupervised-human-baseline',
          reason: 'UNSUPERVISED_BEHAVIORAL_ANOMALY',
          points: 70,
          detail: `Unsupervised deviation ${sigmaDistance.toFixed(2)}σ from live human baseline (${topDeviations.map((d) => `${d.feature}:${d.zScore}σ`).join(', ')})`,
          supportingEventIds: [eventId],
        };
      } else if (sigmaDistance >= this.challengeSigma) {
        signal = {
          rule: 'ML:unsupervised-human-baseline',
          reason: 'UNSUPERVISED_BEHAVIORAL_ANOMALY',
          points: 45,
          detail: `Moderate unsupervised deviation ${sigmaDistance.toFixed(2)}σ from live human baseline (${topDeviations.map((d) => `${d.feature}:${d.zScore}σ`).join(', ')})`,
          supportingEventIds: [eventId],
        };
      }
    }

    return {
      anomalyScore,
      sigmaDistance: Number(sigmaDistance.toFixed(3)),
      topDeviations,
      signal,
    };
  }

  /**
   * Online auto-learning hook: records live session traces and updates the
   * Welford human baseline ONLY on clean ALLOW decisions with sufficient telemetry.
   */
  observeLiveDecision(params: {
    timestamp: string;
    accountId: string;
    decision: string;
    riskScore: number;
    hardFailure: boolean;
    isClustered: boolean;
    features: BehavioralFeatureVector;
  }): void {
    const { features } = params;
    if (features.sessionEventCount >= this.minSessionEvents) {
      const entry = {
        timestamp: params.timestamp,
        accountId: params.accountId,
        decision: params.decision,
        features,
      };
      this.liveTraces.push(entry);

      if (this.liveTracePath) {
        mkdirSync(dirname(this.liveTracePath), { recursive: true });
        appendFileSync(this.liveTracePath, `${JSON.stringify(entry)}\n`, 'utf8');
      }
    }

    // Only learn into the human baseline from clean, unclustered ALLOW sessions
    const isCleanHumanObservation =
      params.decision === 'ALLOW' &&
      !params.hardFailure &&
      !params.isClustered &&
      params.riskScore < 20 &&
      features.sessionEventCount >= this.minSessionEvents;

    if (!isCleanHumanObservation) {
      return;
    }

    this.baseline.sampleCount += 1;
    const n = this.baseline.sampleCount;

    for (const feat of UNSUPERVISED_BEHAVIORAL_FEATURES) {
      const x = features[feat];
      const oldMean = this.baseline.means[feat];
      const delta = x - oldMean;
      const newMean = oldMean + delta / n;
      const delta2 = x - newMean;
      this.baseline.means[feat] = Number(newMean.toFixed(6));
      this.baseline.m2[feat] = this.baseline.m2[feat] + delta * delta2;
      this.baseline.stds[feat] = Number(
        Math.max(1e-4, Math.sqrt(this.baseline.m2[feat] / Math.max(1, n - 1))).toFixed(6)
      );
    }

    this.baseline.updatedAt = params.timestamp;

    if (this.baselinePath) {
      mkdirSync(dirname(this.baselinePath), { recursive: true });
      writeFileSync(this.baselinePath, `${JSON.stringify(this.baseline, null, 2)}\n`, 'utf8');
    }
  }
}
