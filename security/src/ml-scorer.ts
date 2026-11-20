import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuleSignal } from './decisions.ts';
import {
  ML_FEATURE_NAMES,
  type BehavioralFeatureVector,
  type MlFeatureName,
} from './ml-features.ts';

export interface MlModelArtifact {
  modelType: string;
  version: string;
  trainedAt: string;
  featureNames: string[];
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  thresholds: {
    challengeProbability: number;
    blockProbability: number;
    minSessionEvents: number;
  };
  validationMetrics?: Record<string, number>;
}

export interface MlFeatureContribution {
  feature: MlFeatureName;
  value: number;
  contribution: number;
}

export interface MlInferenceResult {
  probability: number;
  mlScore: number;
  topContributors: MlFeatureContribution[];
  signal: RuleSignal | null;
}

const DEFAULT_MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ml-model.json');

let cachedModel: MlModelArtifact | null = null;

export function loadMlModel(modelPath = DEFAULT_MODEL_PATH): MlModelArtifact {
  if (cachedModel && modelPath === DEFAULT_MODEL_PATH) {
    return cachedModel;
  }
  const raw = readFileSync(modelPath, 'utf8');
  const parsed = JSON.parse(raw) as MlModelArtifact;
  if (modelPath === DEFAULT_MODEL_PATH) {
    cachedModel = parsed;
  }
  return parsed;
}

function sigmoid(z: number): number {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Evaluates a standardized L2 Logistic Regression behavioral model in < 0.1ms.
 * Produces an explainable probability, per-feature log-odds attributions, and an
 * optional ML_BEHAVIORAL_ANOMALY signal once minimum session telemetry exists.
 */
export function evaluateBehavioralMl(
  features: BehavioralFeatureVector,
  eventId: string,
  model: MlModelArtifact = loadMlModel()
): MlInferenceResult {
  const contributions: MlFeatureContribution[] = [];
  let z = model.bias;

  for (let i = 0; i < ML_FEATURE_NAMES.length; i++) {
    const name = ML_FEATURE_NAMES[i];
    const value = features[name];
    const mean = model.means[i] ?? 0;
    const std = model.stds[i] && model.stds[i] > 0 ? model.stds[i] : 1;
    const weight = model.weights[i] ?? 0;
    const standardized = (value - mean) / std;
    const contribution = weight * standardized;
    z += contribution;
    contributions.push({
      feature: name,
      value: Number(value.toFixed(3)),
      contribution: Number(contribution.toFixed(3)),
    });
  }

  const probability = sigmoid(z);
  const mlScore = Math.round(probability * 100);

  // Top positive contributors driving bot probability up
  const topContributors = contributions
    .filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  let signal: RuleSignal | null = null;
  if (features.sessionEventCount >= model.thresholds.minSessionEvents) {
    if (probability >= model.thresholds.blockProbability) {
      signal = {
        rule: 'ML:behavioral-anomaly-detector',
        reason: 'ML_BEHAVIORAL_ANOMALY',
        points: 70,
        detail: `High-confidence behavioral ML anomaly ${mlScore}/100 (p=${probability.toFixed(3)}) driven by ${topContributors.map((c) => c.feature).join(', ') || 'timing'}`,
        supportingEventIds: [eventId],
      };
    } else if (probability >= model.thresholds.challengeProbability) {
      signal = {
        rule: 'ML:behavioral-anomaly-detector',
        reason: 'ML_BEHAVIORAL_ANOMALY',
        points: 45,
        detail: `Behavioral ML anomaly ${mlScore}/100 (p=${probability.toFixed(3)}) driven by ${topContributors.map((c) => c.feature).join(', ') || 'timing'}`,
        supportingEventIds: [eventId],
      };
    }
  }

  return {
    probability: Number(probability.toFixed(4)),
    mlScore,
    topContributors,
    signal,
  };
}
