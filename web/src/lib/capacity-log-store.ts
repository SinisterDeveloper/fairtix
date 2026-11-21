import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapacityConfig, CapacityReport } from '@/lib/security-capacity';
import type { ActivityLogEntry } from '@/lib/types';

function capacityLogPath() {
  const stateTag = (process.env.FAIRTICKETS_STATE_DIR || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `fairtickets-capacity-logs-${stateTag}.ndjson`);
}

export function appendCapacityBenchmarkLogs(config: CapacityConfig, report: CapacityReport) {
  const ts = new Date().toISOString();
  const runId = `cap-${Date.now()}`;
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      timestamp: ts,
      action: 'security-capacity',
      role: 'operator',
      subjectLabel: `${report.buyers} buyers · ${report.events.toLocaleString()} events`,
      success: report.ok,
      txHash: null,
      error: report.ok ? null : 'Capacity benchmark failed',
      runId,
      scope: report.scope,
      buyers: report.buyers,
      waveSize: report.waveSize,
      buyersPerNetwork: report.buyersPerNetwork,
      events: report.events,
      sold: report.sold,
      challenged: report.challenged,
      blocked: report.blocked,
      elapsedMs: report.elapsedMs,
      eventsPerSecond: report.eventsPerSecond,
      evaluationLatencyMs: report.evaluationLatencyMs,
    } satisfies ActivityLogEntry),
  );

  // Record per-buyer synthetic evaluation entries from the run (up to 10,000 rows per run for fast pagination)
  const sampleCount = Math.min(config.buyers, 10_000);
  const blockRatio = report.events > 0 ? report.blocked / report.events : 0;
  const challengeRatio = report.events > 0 ? report.challenged / report.events : 0;
  for (let i = 0; i < sampleCount; i++) {
    const wave = Math.floor(i / config.waveSize) + 1;
    const net = Math.floor(i / config.buyersPerNetwork) + 1;
    const frac = (i % 1000) / 1000;
    const outcome =
      frac < blockRatio ? 'BLOCK' : frac < blockRatio + challengeRatio ? 'CHALLENGE' : 'ALLOW';
    lines.push(
      JSON.stringify({
        timestamp: ts,
        action: 'capacity-buyer-eval',
        role: `wave-${wave}`,
        subjectLabel: `buyer-${i + 1} (net-${net}) · ${outcome}`,
        success: outcome === 'ALLOW',
        txHash: null,
        error: outcome === 'ALLOW' ? null : `Decision: ${outcome}`,
        runId,
        wave,
        network: `net-${net}`,
        decision: outcome,
      } satisfies ActivityLogEntry),
    );
  }

  try {
    fs.writeFileSync(capacityLogPath(), lines.join('\n') + '\n', { flag: 'a' });
  } catch {}
}

export function readCapacityBenchmarkLogs(): ActivityLogEntry[] {
  try {
    const p = capacityLogPath();
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line) as ActivityLogEntry;
        } catch {
          return { timestamp: '', action: 'parse_error', error: line };
        }
      });
  } catch {
    return [];
  }
}
