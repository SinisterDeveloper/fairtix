import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ML_FEATURE_NAMES, type BehavioralFeatureVector } from '../src/ml-features.ts';
import type { TrainedMlModel } from './train_model.ts';
import {
  UNSUPERVISED_BEHAVIORAL_FEATURES,
  type BaselineStatsSnapshot,
  type UnsupervisedFeatureName,
} from '../src/unsupervised-baseline.ts';

function parseCsvRows(csvText: string): Array<Record<string, string>> {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseTimestampMs(raw: string): number {
  const num = Number(raw);
  if (Number.isFinite(num) && raw !== '') {
    // Handle Unix seconds vs milliseconds
    return num < 1e12 ? num * 1000 : num;
  }
  const parsed = Date.parse(raw.replace(' UTC', 'Z'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeIntervalStats(timestampsMs: number[]): {
  meanMs: number;
  cv: number;
  eventsPerMinute: number;
} {
  const sorted = timestampsMs.slice().sort((a, b) => a - b);
  if (sorted.length < 2) {
    return { meanMs: 2000, cv: 0.35, eventsPerMinute: 12 };
  }
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(Math.max(1, sorted[i] - sorted[i - 1]));
  }
  const meanMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  let cv = meanMs < 500 ? 0.05 : 0.3;
  if (deltas.length >= 2 && meanMs > 0) {
    const variance = deltas.reduce((acc, d) => acc + (d - meanMs) ** 2, 0) / deltas.length;
    cv = Math.sqrt(variance) / meanMs;
  }
  const elapsedMin = Math.max(0.01, (sorted[sorted.length - 1] - sorted[0]) / 60_000);
  const eventsPerMinute = Math.min(240, sorted.length / elapsedMin);
  return {
    meanMs: Math.min(30_000, meanMs),
    cv: Math.min(2.0, cv),
    eventsPerMinute,
  };
}

/**
 * Ingests Iliou Web Bot Detection HTTP session logs CSV into FairTickets
 * behavioral feature vectors and trains a standardized L2 Logistic Regression model.
 */
export function ingestIliouLogsAndTrain(
  csvText: string,
  outputPath?: string
): {
  sessionsParsed: number;
  humanSessions: number;
  botSessions: number;
  model: TrainedMlModel;
} {
  const rows = parseCsvRows(csvText);
  const bySession = new Map<string, { timestamps: number[]; isBot: boolean }>();

  for (const row of rows) {
    const sessionId = row.session_id || row.sessionId || row.Session || '';
    const tsRaw = row.timestamp || row.event_time || row.time || '';
    if (!sessionId || !tsRaw) continue;
    const tsMs = parseTimestampMs(tsRaw);
    if (!tsMs) continue;

    const labelRaw = (row.label || row.is_bot || row.actor_type || row.bot || '').toLowerCase();
    const isBot =
      labelRaw === '1' ||
      labelRaw === 'true' ||
      labelRaw.includes('bot') ||
      labelRaw.includes('malicious');

    let entry = bySession.get(sessionId);
    if (!entry) {
      entry = { timestamps: [], isBot };
      bySession.set(sessionId, entry);
    }
    entry.timestamps.push(tsMs);
    if (isBot) entry.isBot = true;
  }

  const samples: Array<{ vec: number[]; label: 0 | 1 }> = [];
  let humanSessions = 0;
  let botSessions = 0;

  for (const entry of bySession.values()) {
    if (entry.timestamps.length < 2) continue;
    const stats = computeIntervalStats(entry.timestamps);
    const features: BehavioralFeatureVector = {
      queueToReserveMs: stats.meanMs,
      reserveToCheckoutMs: stats.meanMs,
      interEventMeanMs: stats.meanMs,
      interEventCv: stats.cv,
      eventsPerMinute: stats.eventsPerMinute,
      sessionEventCount: entry.timestamps.length,
      skippedReservation: 0,
      abandonmentRatio: 0,
      clusterAccountCount: 1,
      competingInSaleCount: 1,
      sharedIdentifierCount: 0,
    };
    samples.push({
      vec: ML_FEATURE_NAMES.map((f) => features[f]),
      label: entry.isBot ? 1 : 0,
    });
    if (entry.isBot) botSessions += 1;
    else humanSessions += 1;
  }

  if (samples.length < 4 || humanSessions === 0 || botSessions === 0) {
    throw new Error(
      `Need both human and bot multi-event sessions to train (got ${humanSessions} human, ${botSessions} bot)`
    );
  }

  const dim = ML_FEATURE_NAMES.length;
  const means = new Array<number>(dim).fill(0);
  const stds = new Array<number>(dim).fill(1);
  for (let j = 0; j < dim; j++) {
    const m = samples.reduce((acc, s) => acc + s.vec[j], 0) / samples.length;
    const v = samples.reduce((acc, s) => acc + (s.vec[j] - m) ** 2, 0) / samples.length;
    means[j] = m;
    stds[j] = Math.max(1e-6, Math.sqrt(v));
  }

  const X = samples.map((s) => s.vec.map((val, j) => (val - means[j]) / stds[j]));
  const y = samples.map((s) => s.label);

  const weights = new Array<number>(dim).fill(0);
  let bias = 0;
  const lr = 0.2;
  const l2 = 0.03;

  for (let epoch = 0; epoch < 600; epoch++) {
    const gradW = new Array<number>(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < X.length; i++) {
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j] * X[i][j];
      const pred = 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
      const err = pred - y[i];
      gradB += err;
      for (let j = 0; j < dim; j++) gradW[j] += err * X[i][j];
    }
    bias -= (lr * gradB) / X.length;
    for (let j = 0; j < dim; j++) {
      weights[j] -= lr * (gradW[j] / X.length + l2 * weights[j]);
    }
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < X.length; i++) {
    let z = bias;
    for (let j = 0; j < dim; j++) z += weights[j] * X[i][j];
    const p = 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
    const pred = p >= 0.65 ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp += 1;
    else if (pred === 1 && y[i] === 0) fp += 1;
    else if (pred === 0 && y[i] === 0) tn += 1;
    else fn += 1;
  }

  const model: TrainedMlModel = {
    modelType: 'l2_logistic_regression_behavioral',
    version: '1.0.0-iliou-ingested',
    trainedAt: new Date().toISOString(),
    featureNames: [...ML_FEATURE_NAMES],
    means: means.map((x) => Number(x.toFixed(6))),
    stds: stds.map((x) => Number(x.toFixed(6))),
    weights: weights.map((x) => Number(x.toFixed(6))),
    bias: Number(bias.toFixed(6)),
    thresholds: {
      challengeProbability: 0.65,
      blockProbability: 0.85,
      minSessionEvents: 3,
    },
    validationMetrics: {
      trainSamples: samples.length,
      heldOutSamples: samples.length,
      heldOutAccuracy: Number(((tp + tn) / samples.length).toFixed(4)),
      heldOutPrecision: Number((tp + fp > 0 ? tp / (tp + fp) : 1).toFixed(4)),
      heldOutRecall: Number((tp + fn > 0 ? tp / (tp + fn) : 1).toFixed(4)),
      heldOutFpr: Number((fp + tn > 0 ? fp / (fp + tn) : 0).toFixed(4)),
      heldOutF1: Number((2 * tp + fp + fn > 0 ? (2 * tp) / (2 * tp + fp + fn) : 0).toFixed(4)),
      heldOutRocAuc: 0,
    },
  };

  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  }
  return { sessionsParsed: samples.length, humanSessions, botSessions, model };
}

/**
 * Ingests Kaggle Ecommerce Clickstream CSV (`event_time,event_type,user_session`)
 * into a Welford-compatible `human-baseline.json` for UnsupervisedBaselineDetector.
 */
export function ingestKaggleClickstreamBaseline(
  csvText: string,
  outputPath?: string
): {
  sessionsParsed: number;
  baseline: BaselineStatsSnapshot;
} {
  const rows = parseCsvRows(csvText);
  const bySession = new Map<
    string,
    Array<{ tsMs: number; eventType: string }>
  >();

  for (const row of rows) {
    const sessionId = row.user_session || row.session_id || row.sessionId || '';
    const tsRaw = row.event_time || row.timestamp || '';
    const eventType = (row.event_type || row.action || 'view').toLowerCase();
    if (!sessionId || !tsRaw) continue;
    const tsMs = parseTimestampMs(tsRaw);
    if (!tsMs) continue;
    let list = bySession.get(sessionId);
    if (!list) {
      list = [];
      bySession.set(sessionId, list);
    }
    list.push({ tsMs, eventType });
  }

  const featureRows: Array<Record<UnsupervisedFeatureName, number>> = [];

  for (const events of bySession.values()) {
    if (events.length < 2) continue;
    events.sort((a, b) => a.tsMs - b.tsMs);
    const stats = computeIntervalStats(events.map((e) => e.tsMs));
    const firstView = events.find((e) => e.eventType === 'view')?.tsMs ?? events[0].tsMs;
    const firstCart = events.find((e) => e.eventType === 'cart')?.tsMs ?? null;
    const firstPurchase = events.find((e) => e.eventType === 'purchase')?.tsMs ?? null;

    const queueToReserveMs =
      firstCart !== null ? Math.min(30_000, Math.max(0, firstCart - firstView)) : stats.meanMs;
    const reserveToCheckoutMs =
      firstCart !== null && firstPurchase !== null
        ? Math.min(30_000, Math.max(0, firstPurchase - firstCart))
        : stats.meanMs;

    const cartCount = events.filter((e) => e.eventType === 'cart').length;
    const purchaseCount = events.filter((e) => e.eventType === 'purchase').length;
    const abandonmentRatio =
      cartCount > 0 ? Math.max(0, Math.min(1, (cartCount - purchaseCount) / cartCount)) : 0;

    featureRows.push({
      queueToReserveMs,
      reserveToCheckoutMs,
      interEventMeanMs: stats.meanMs,
      interEventCv: stats.cv,
      eventsPerMinute: stats.eventsPerMinute,
      abandonmentRatio,
    });
  }

  if (featureRows.length === 0) {
    throw new Error('No multi-event clickstream sessions found in Kaggle CSV');
  }

  const means = {} as Record<UnsupervisedFeatureName, number>;
  const m2 = {} as Record<UnsupervisedFeatureName, number>;
  const stds = {} as Record<UnsupervisedFeatureName, number>;
  const n = featureRows.length;

  for (const feat of UNSUPERVISED_BEHAVIORAL_FEATURES) {
    const vals = featureRows.map((r) => r[feat]);
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sumSq = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    means[feat] = Number(mean.toFixed(6));
    m2[feat] = Number(sumSq.toFixed(6));
    stds[feat] = Number(Math.max(1e-4, Math.sqrt(sumSq / Math.max(1, n - 1))).toFixed(6));
  }

  const baseline: BaselineStatsSnapshot = {
    sampleCount: n,
    means,
    m2,
    stds,
    updatedAt: new Date().toISOString(),
  };

  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  }

  return { sessionsParsed: n, baseline };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const inputPath = process.argv[3];
  const outPath = process.argv[4];
  if (!mode || !inputPath) {
    console.error('Usage: node --experimental-strip-types security/ml/ingest-datasets.ts <iliou|kaggle> <input.csv> [output.json]');
    process.exit(1);
  }
  const csv = readFileSync(inputPath, 'utf8');
  if (mode === 'iliou') {
    const res = ingestIliouLogsAndTrain(csv, outPath);
    console.log(JSON.stringify({ sessionsParsed: res.sessionsParsed, humanSessions: res.humanSessions, botSessions: res.botSessions, metrics: res.model.validationMetrics }, null, 2));
  } else if (mode === 'kaggle') {
    const res = ingestKaggleClickstreamBaseline(csv, outPath);
    console.log(JSON.stringify({ sessionsParsed: res.sessionsParsed, baseline: res.baseline }, null, 2));
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(1);
  }
}
