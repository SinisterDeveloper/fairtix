import { NextRequest, NextResponse } from 'next/server';
import { runCli } from '@/lib/cli-bridge';
import { authorizeSecurityEvaluation } from '@/lib/security-evaluation-auth';
import {
  replayDefaults,
  replayFixtures,
  replayProfiles,
  replayRanges,
  type ReplayConfig,
} from '@/lib/security-replay';

export const runtime = 'nodejs';

function parseConfig(value: unknown): ReplayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !Object.hasOwn(replayDefaults, key))) {
    throw new Error('Use only fixture, seed, participants, inventory, and profile.');
  }
  const fixture = fields.fixture === undefined ? replayDefaults.fixture : fields.fixture;
  const profile = fields.profile === undefined ? replayDefaults.profile : fields.profile;
  if (typeof fixture !== 'string' || !Object.hasOwn(replayFixtures, fixture)) {
    throw new Error('Select a supported replay fixture.');
  }
  if (typeof profile !== 'string' || !Object.hasOwn(replayProfiles, profile)) {
    throw new Error('Select a supported identity profile.');
  }

  function readInteger(field: keyof typeof replayRanges) {
    const input = fields[field] === undefined ? replayDefaults[field] : fields[field];
    const { min, max } = replayRanges[field];
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
      throw new Error(`${field} must be an integer from ${min} to ${max}.`);
    }
    return input;
  }

  return {
    fixture: fixture as ReplayConfig['fixture'],
    seed: readInteger('seed'),
    participants: readInteger('participants'),
    inventory: readInteger('inventory'),
    profile: profile as ReplayConfig['profile'],
  };
}

export async function POST(req: NextRequest) {
  const unauthorized = authorizeSecurityEvaluation(req, 'replay');
  if (unauthorized) return unauthorized;

  let config: ReplayConfig;
  try {
    config = parseConfig(await req.json());
  } catch (err) {
    const error = err instanceof SyntaxError ? 'Expected a valid JSON object.' : (err as Error).message;
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  const result = await runCli([
    'security-replay',
    '--fixture', config.fixture,
    '--seed', String(config.seed),
    '--participants', String(config.participants),
    '--inventory', String(config.inventory),
    '--profile', config.profile,
  ], 30_000);

  if (result.ok !== true || !result.config || !result.observe || !result.enforce) {
    const timedOut = result.errorCode === 'RPC_TIMEOUT';
    const error = timedOut ? 'Security replay timed out.' : 'Security replay did not return a complete report.';
    return NextResponse.json({ ok: false, error }, { status: timedOut ? 504 : 502 });
  }

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
