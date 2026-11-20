import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ML_FEATURE_NAMES, type BehavioralFeatureVector } from '../src/ml-features.ts';

interface LabeledSample {
  features: BehavioralFeatureVector;
  label: 0 | 1; // 0 = legitimate fan, 1 = automated bot
  archetype: string;
}

export interface TrainedMlModel {
  modelType: 'l2_logistic_regression_behavioral';
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
  validationMetrics: {
    trainSamples: number;
    heldOutSamples: number;
    heldOutAccuracy: number;
    heldOutPrecision: number;
    heldOutRecall: number;
    heldOutFpr: number;
    heldOutF1: number;
    heldOutRocAuc: number;
  };
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1));
}

function generateDataset(count: number, seed: number, distributionShiftMs = 0): LabeledSample[] {
  const rng = createRng(seed);
  const samples: LabeledSample[] = [];

  for (let i = 0; i < count; i++) {
    const r = rng();

    if (r < 0.36) {
      // Normal human fan (including shared-Wi-Fi & family households)
      const t1 = randRange(rng, 1000 + distributionShiftMs, 8000);
      const t2 = randRange(rng, 1200 + distributionShiftMs, 10000);
      const mean = (1000 + t1 + t2) / 3;
      const cv = randRange(rng, 0.2, 0.85);
      samples.push({
        label: 0,
        archetype: 'human_normal',
        features: {
          queueToReserveMs: t1,
          reserveToCheckoutMs: t2,
          interEventMeanMs: mean,
          interEventCv: cv,
          eventsPerMinute: Math.min(240, (4 * 60_000) / Math.max(1500, 1000 + t1 + t2)),
          sessionEventCount: randInt(rng, 3, 5),
          skippedReservation: 0,
          abandonmentRatio: rng() < 0.08 ? randRange(rng, 0.1, 0.35) : 0,
          clusterAccountCount: 1,
          competingInSaleCount: 1,
          sharedIdentifierCount: 0,
        },
      });
    } else if (r < 0.48) {
      // Fast-clicking human fan (stress test against false positives)
      const t1 = randRange(rng, 750 + distributionShiftMs, 2200);
      const t2 = randRange(rng, 850 + distributionShiftMs, 2600);
      const mean = (900 + t1 + t2) / 3;
      const cv = randRange(rng, 0.18, 0.55);
      samples.push({
        label: 0,
        archetype: 'human_fast_clicker',
        features: {
          queueToReserveMs: t1,
          reserveToCheckoutMs: t2,
          interEventMeanMs: mean,
          interEventCv: cv,
          eventsPerMinute: Math.min(240, (4 * 60_000) / Math.max(1200, 900 + t1 + t2)),
          sessionEventCount: 4,
          skippedReservation: 0,
          abandonmentRatio: 0,
          clusterAccountCount: 1,
          competingInSaleCount: 1,
          sharedIdentifierCount: 0,
        },
      });
    } else if (r < 0.66) {
      // Behavioral stealth sniper bot (no shared identifiers, valid grant, robotic sub-second timing)
      const t1 = randRange(rng, 80, 420 + distributionShiftMs * 0.15);
      const t2 = randRange(rng, 90, 460 + distributionShiftMs * 0.15);
      const skip = rng() < 0.65 ? 1 : 0;
      const mean = skip ? t1 : (200 + t1 + t2) / 3;
      const cv = randRange(rng, 0.01, 0.14);
      samples.push({
        label: 1,
        archetype: 'stealth_behavioral_bot',
        features: {
          queueToReserveMs: t1,
          reserveToCheckoutMs: t2,
          interEventMeanMs: mean,
          interEventCv: cv,
          eventsPerMinute: randRange(rng, 95, 240),
          sessionEventCount: skip ? 3 : 4,
          skippedReservation: skip,
          abandonmentRatio: rng() < 0.25 ? randRange(rng, 0.3, 0.8) : 0,
          clusterAccountCount: 1,
          competingInSaleCount: 1,
          sharedIdentifierCount: 0,
        },
      });
    } else if (r < 0.84) {
      // Account farm / distributed linked bot
      const clusterSize = randInt(rng, 3, 50);
      const t1 = randRange(rng, 150, 1200);
      const t2 = randRange(rng, 200, 1500);
      samples.push({
        label: 1,
        archetype: 'linked_cluster_bot',
        features: {
          queueToReserveMs: t1,
          reserveToCheckoutMs: t2,
          interEventMeanMs: randRange(rng, 180, 1100),
          interEventCv: randRange(rng, 0.02, 0.22),
          eventsPerMinute: randRange(rng, 55, 220),
          sessionEventCount: randInt(rng, 2, 4),
          skippedReservation: rng() < 0.5 ? 1 : 0,
          abandonmentRatio: rng() < 0.3 ? randRange(rng, 0.3, 0.9) : 0,
          clusterAccountCount: clusterSize,
          competingInSaleCount: randInt(rng, 3, clusterSize),
          sharedIdentifierCount: randInt(rng, 1, 2),
        },
      });
    } else {
      // Inventory hoarder bot (OAT-021)
      samples.push({
        label: 1,
        archetype: 'inventory_hoarder_bot',
        features: {
          queueToReserveMs: randRange(rng, 120, 700),
          reserveToCheckoutMs: randRange(rng, 400, 2000),
          interEventMeanMs: randRange(rng, 200, 900),
          interEventCv: randRange(rng, 0.03, 0.25),
          eventsPerMinute: randRange(rng, 60, 210),
          sessionEventCount: randInt(rng, 3, 6),
          skippedReservation: 0,
          abandonmentRatio: randRange(rng, 0.6, 1.0),
          clusterAccountCount: rng() < 0.5 ? randInt(rng, 3, 12) : 1,
          competingInSaleCount: rng() < 0.5 ? randInt(rng, 3, 12) : 1,
          sharedIdentifierCount: rng() < 0.5 ? 1 : 0,
        },
      });
    }
  }

  return samples;
}

function vectorize(vec: BehavioralFeatureVector): number[] {
  return ML_FEATURE_NAMES.map((name) => vec[name]);
}

function sigmoid(z: number): number {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

function computeRocAuc(probs: number[], labels: number[]): number {
  const paired = probs.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => b.p - a.p);
  const positives = labels.filter((y) => y === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 1;

  let tp = 0;
  let fp = 0;
  let prevTp = 0;
  let prevFp = 0;
  let auc = 0;

  for (const item of paired) {
    if (item.y === 1) tp += 1;
    else fp += 1;
    auc += ((fp - prevFp) * (tp + prevTp)) / 2;
    prevTp = tp;
    prevFp = fp;
  }

  return auc / (positives * negatives);
}

export function trainAndExportModel(outputPath?: string): TrainedMlModel {
  const trainSet = generateDataset(1400, 20261121, 0);
  // Held-out set uses a different RNG seed + timing distribution shift to prevent overfitting
  const heldOutSet = generateDataset(700, 99118822, 120);

  const dim = ML_FEATURE_NAMES.length;
  const XTrain = trainSet.map((s) => vectorize(s.features));
  const yTrain = trainSet.map((s) => s.label);

  // Standardize features (zero mean, unit variance) using training split only
  const means = new Array<number>(dim).fill(0);
  const stds = new Array<number>(dim).fill(1);

  for (let j = 0; j < dim; j++) {
    const colMean = XTrain.reduce((acc, row) => acc + row[j], 0) / XTrain.length;
    const colVar = XTrain.reduce((acc, row) => acc + (row[j] - colMean) ** 2, 0) / XTrain.length;
    means[j] = colMean;
    stds[j] = Math.max(1e-6, Math.sqrt(colVar));
  }

  const normalize = (row: number[]): number[] => row.map((v, j) => (v - means[j]) / stds[j]);
  const XTrainNorm = XTrain.map(normalize);

  // Train L2-regularized Logistic Regression via batch gradient descent
  const weights = new Array<number>(dim).fill(0);
  let bias = 0;
  const lr = 0.15;
  const l2Lambda = 0.03;
  const epochs = 900;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array<number>(dim).fill(0);
    let gradB = 0;

    for (let i = 0; i < XTrainNorm.length; i++) {
      const row = XTrainNorm[i];
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j] * row[j];
      const pred = sigmoid(z);
      const err = pred - yTrain[i];
      gradB += err;
      for (let j = 0; j < dim; j++) {
        gradW[j] += err * row[j];
      }
    }

    bias -= (lr * gradB) / XTrainNorm.length;
    for (let j = 0; j < dim; j++) {
      const regTerm = l2Lambda * weights[j];
      weights[j] -= lr * (gradW[j] / XTrainNorm.length + regTerm);
    }
  }

  // Evaluate on held-out split
  const XTestNorm = heldOutSet.map((s) => normalize(vectorize(s.features)));
  const yTest = heldOutSet.map((s) => s.label);
  const probs = XTestNorm.map((row) => {
    let z = bias;
    for (let j = 0; j < dim; j++) z += weights[j] * row[j];
    return sigmoid(z);
  });

  const challengeThreshold = 0.65;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (let i = 0; i < probs.length; i++) {
    const pred = probs[i] >= challengeThreshold ? 1 : 0;
    const actual = yTest[i];
    if (pred === 1 && actual === 1) tp += 1;
    else if (pred === 1 && actual === 0) fp += 1;
    else if (pred === 0 && actual === 0) tn += 1;
    else fn += 1;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const accuracy = (tp + tn) / probs.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const rocAuc = computeRocAuc(probs, yTest);

  const model: TrainedMlModel = {
    modelType: 'l2_logistic_regression_behavioral',
    version: '1.0.0',
    trainedAt: new Date().toISOString(),
    featureNames: [...ML_FEATURE_NAMES],
    means: means.map((v) => Number(v.toFixed(6))),
    stds: stds.map((v) => Number(v.toFixed(6))),
    weights: weights.map((v) => Number(v.toFixed(6))),
    bias: Number(bias.toFixed(6)),
    thresholds: {
      challengeProbability: challengeThreshold,
      blockProbability: 0.85,
      minSessionEvents: 3,
    },
    validationMetrics: {
      trainSamples: trainSet.length,
      heldOutSamples: heldOutSet.length,
      heldOutAccuracy: Number(accuracy.toFixed(4)),
      heldOutPrecision: Number(precision.toFixed(4)),
      heldOutRecall: Number(recall.toFixed(4)),
      heldOutFpr: Number(fpr.toFixed(4)),
      heldOutF1: Number(f1.toFixed(4)),
      heldOutRocAuc: Number(rocAuc.toFixed(4)),
    },
  };

  const targetPath = outputPath ?? join(resolve('security/src'), 'ml-model.json');
  writeFileSync(targetPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = trainAndExportModel();
  console.log(JSON.stringify(model.validationMetrics, null, 2));
}
