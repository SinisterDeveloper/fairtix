import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAccountFarmScenario } from '../simulator/account-farm.ts';
import { renderBenchmarkMarkdown, runIbmBenchmarkSuite } from '../simulator/benchmark-ibm.ts';
import { parseCapacityConfig, runCapacityBenchmark } from '../simulator/capacity-benchmark.ts';
import { parseReplayConfig, runDefensiveReplay } from '../simulator/defensive-replay.ts';
import { validateAndNormalizeEvent } from './events.ts';
import { RiskEngine } from './risk-engine.ts';

function parseCliFlags(argv: string[]): { mode: string; opts: Record<string, string | boolean> } {
  const [mode = '', ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    }
  }
  return { mode, opts };
}

function main(): void {
  const { mode, opts } = parseCliFlags(process.argv.slice(2));
  const root = resolve(import.meta.dirname, '..', '..');
  const stateDir = resolve(String(opts['state-dir'] || process.env.FAIRTICKETS_STATE_DIR || join(root, 'artifacts')));

  if (mode === 'eval') {
    const rawJson = opts.stdin
      ? readFileSync(0, 'utf8')
      : typeof opts['event-file'] === 'string'
        ? readFileSync(opts['event-file'], 'utf8')
        : typeof opts.event === 'string'
          ? opts.event
          : '';
    if (!rawJson.trim()) {
      throw new Error('Missing event JSON (--event, --event-file, or --stdin) for security-eval');
    }
    const rawEvent = JSON.parse(rawJson) as unknown;
    const normalized = validateAndNormalizeEvent(rawEvent);

    const engine = new RiskEngine({ protectionsEnabled: true });
    const eventsLogPath = join(stateDir, 'security-events.ndjson');
    const seenKeys = new Set<string>();

    if (existsSync(eventsLogPath)) {
      const lines = readFileSync(eventsLogPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const prior = JSON.parse(line) as { eventIdempotencyKey?: string };
          if (prior && typeof prior.eventIdempotencyKey === 'string') {
            seenKeys.add(prior.eventIdempotencyKey);
          }
          engine.evaluate(prior);
        } catch {}
      }
    }

    const decision = engine.evaluate(rawEvent);
    if (!seenKeys.has(normalized.eventIdempotencyKey)) {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(eventsLogPath, JSON.stringify(rawEvent) + '\n', { mode: 0o600 });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          txStatus: 'confirmed',
          ...decision,
        },
        null,
        2
      )
    );
    return;
  }

  if (mode === 'benchmark') {
    const report = runIbmBenchmarkSuite();
    if (opts.write) {
      const artifactsDir = join(root, 'artifacts');
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(join(artifactsDir, 'security-benchmark-report.json'), JSON.stringify(report, null, 2) + '\n');
      writeFileSync(join(artifactsDir, 'security-benchmark-report.md'), renderBenchmarkMarkdown(report) + '\n');
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          txStatus: 'confirmed',
          ...report,
        },
        null,
        2
      )
    );
    return;
  }

  if (mode === 'replay') {
    if (process.env.FAIRTICKETS_REPLAY_ENABLED !== '1') {
      console.log(JSON.stringify({ ok: false, error: 'Security replay is disabled.' }));
      return;
    }
    let config;
    try {
      config = parseReplayConfig(opts);
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    console.log(JSON.stringify(runDefensiveReplay(config)));
    return;
  }

  if (mode === 'capacity') {
    let config;
    try {
      config = parseCapacityConfig(opts);
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    console.log(JSON.stringify(runCapacityBenchmark(config)));
    return;
  }

  if (mode === 'account-farm') {
    const result = runAccountFarmScenario({ protectionsEnabled: true });
    const { farmTraces, legitimateTraces, ...summary } = result;
    console.log(
      JSON.stringify(
        {
          ok: true,
          txStatus: 'confirmed',
          ...summary,
          sampleFarmDecisions: farmTraces.slice(0, 5),
          sampleLegitimateDecisions: legitimateTraces.slice(0, 5),
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(`Unknown security cli-runner mode: ${mode}`);
}

main();
