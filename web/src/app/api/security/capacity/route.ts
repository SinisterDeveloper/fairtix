import { NextRequest, NextResponse } from 'next/server';
import { runCli } from '@/lib/cli-bridge';
import { capacityInputs, type CapacityConfig } from '@/lib/security-capacity';
import { authorizeSecurityEvaluation } from '@/lib/security-evaluation-auth';

export const runtime = 'nodejs';

let capacityRunning = false;

function parseConfig(value: unknown): CapacityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !Object.hasOwn(capacityInputs, key))) {
    throw new Error('Use only buyers, waveSize, and buyersPerNetwork.');
  }

  function readInteger(key: keyof CapacityConfig) {
    const { min, max, defaultValue } = capacityInputs[key];
    const input = fields[key] === undefined ? defaultValue : fields[key];
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    }
    return input;
  }

  return {
    buyers: readInteger('buyers'),
    waveSize: readInteger('waveSize'),
    buyersPerNetwork: readInteger('buyersPerNetwork'),
  };
}

export async function POST(req: NextRequest) {
  const unauthorized = authorizeSecurityEvaluation(req, 'capacity benchmark');
  if (unauthorized) return unauthorized;

  let config: CapacityConfig;
  try {
    config = parseConfig(await req.json());
  } catch (err) {
    const error = err instanceof SyntaxError ? 'Expected a valid JSON object.' : (err as Error).message;
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  if (capacityRunning) {
    return NextResponse.json({ ok: false, error: 'A capacity benchmark is already running.' }, { status: 409 });
  }
  capacityRunning = true;

  try {
    const result = await runCli([
      'security-capacity',
      '--buyers', String(config.buyers),
      '--wave-size', String(config.waveSize),
      '--buyers-per-network', String(config.buyersPerNetwork),
    ], 90_000);

    if (
      typeof result.ok !== 'boolean' || result.buyers !== config.buyers || result.waveSize !== config.waveSize ||
      result.buyersPerNetwork !== config.buyersPerNetwork || !result.evaluationLatencyMs
    ) {
      const timedOut = result.errorCode === 'CAPACITY_TIMEOUT' || result.errorCode === 'RPC_TIMEOUT';
      const error = timedOut ? 'Capacity benchmark timed out.' : 'The capacity benchmark did not return a complete report.';
      return NextResponse.json({ ok: false, error }, { status: timedOut ? 504 : 502 });
    }

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } finally {
    capacityRunning = false;
  }
}
