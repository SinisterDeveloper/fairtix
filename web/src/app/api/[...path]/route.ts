import fs from 'node:fs';
import nodePath from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { shouldMineBeforeFinalize } from '@/lib/allocation';
import { httpStatus, roleArgs, runCli } from '@/lib/cli-bridge';
import { inrToWei } from '@/lib/format';
import type { ActivityLogEntry, ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export const runtime = 'nodejs';
const MAX_ENTRY_WINDOW_SECONDS = 86_400;
type Body = Record<string, unknown>;
const str = (v: unknown, fallback = '') => String(v ?? fallback);
const num = (v: unknown, fallback = 0) => Number(v ?? fallback);
const randomBytes32 = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const role = (b: Body) => str(b.role, 'fanA') as RoleId;
const invoke = async (args: string[]) => {
  const result = await runCli(args) as ApiMutationResponse;
  return NextResponse.json(result, { status: httpStatus(result) });
};

export async function GET(_req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.join('/') === 'status') {
    const status = await runCli(['status']);
    return NextResponse.json(status, { status: status.ok === false ? 503 : 200 });
  }
  if (path.join('/') === 'organiser/alerts') return NextResponse.json(await runCli(['alerts']));
  if (path.join('/') === 'security/benchmark') {
    const bench = await runCli(['security-benchmark'], 30_000);
    return NextResponse.json(bench, { status: bench.ok === false ? 500 : 200 });
  }
  if (path.join('/') === 'security/status') {
    const repoRoot = nodePath.resolve(process.cwd(), '..');
    const stateDir = process.env.FAIRTICKETS_STATE_DIR || nodePath.join(repoRoot, 'artifacts');
    const readJsonSafe = (p: string) => {
      try {
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      } catch {
        return null;
      }
    };
    const mlModel = readJsonSafe(nodePath.join(repoRoot, 'security', 'src', 'ml-model.json'));
    const humanBaseline = readJsonSafe(nodePath.join(repoRoot, 'security', 'src', 'human-baseline.json'));
    const secLogPath = nodePath.join(stateDir, 'security-events.ndjson');
    let recentEvents: Array<Record<string, unknown>> = [];
    let recentEventsCount = 0;
    try {
      if (fs.existsSync(secLogPath)) {
        const lines = fs.readFileSync(secLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
        recentEventsCount = lines.length;
        recentEvents = lines.slice(-25).reverse().map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { raw: line };
          }
        });
      }
    } catch {
      recentEvents = [];
    }
    return NextResponse.json({
      ok: true,
      mlModel,
      humanBaseline,
      recentEventsCount,
      recentEvents,
    });
  }
  if (path.join('/') === 'admin/logs') {
    const stateDir = process.env.FAIRTICKETS_STATE_DIR || nodePath.resolve(process.cwd(), '..', 'artifacts');
    const logPath = nodePath.join(stateDir, 'activity-log.ndjson');
    let logs: ActivityLogEntry[] = [];
    try {
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
        logs = lines
          .slice(-100)
          .reverse()
          .map((line) => {
            try {
              return JSON.parse(line) as ActivityLogEntry;
            } catch {
              return { timestamp: '', action: 'parse_error', error: line };
            }
          });
      }
    } catch {
      logs = [];
    }
    const alertsRes = await runCli(['alerts']);
    return NextResponse.json({
      ok: true,
      logs,
      alerts: Array.isArray(alertsRes.alerts) ? alertsRes.alerts : [],
      activityCount: Number(alertsRes.activityCount ?? logs.length),
      stateDir,
    });
  }
  return NextResponse.json({ ok: false, error: 'Unknown API route' }, { status: 404 });
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = path.join('/');
  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ ok: false, txStatus: 'rejected', error: 'Invalid JSON body' }, { status: 400 }); }
  const roleFlags = roleArgs(role(body));
  const json = ['--json'];
  switch (endpoint) {
    case 'enter': {
      const subject = str(body.subject, `demo-${role(body)}`);
      if (body.enforceSecurity === true) {
        const nowIso = new Date().toISOString();
        const eventId = `web_enter_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const secEvent = {
          eventId,
          timestamp: nowIso,
          eventType: 'QUEUE_JOIN',
          eventIdempotencyKey: `idem_${eventId}`,
          accountId: subject,
          sessionId: str(body.sessionId, `sess_${role(body)}`),
          eventContext: {
            eventSaleId: str(body.eventSaleId, 'live_event'),
            deviceId: body.deviceId ? str(body.deviceId) : null,
            networkId: body.networkId ? str(body.networkId) : null,
            paymentTokenHash: body.paymentTokenHash ? str(body.paymentTokenHash) : null,
          },
        };
        const secDecision = await runCli(['security-eval', '--event', JSON.stringify(secEvent)], 15_000);
        if (secDecision.decision === 'BLOCK') {
          return NextResponse.json(
            {
              ok: false,
              txStatus: 'rejected',
              txHash: null,
              errorCode: 'SECURITY_BLOCKED',
              error: `Blocked by Hybrid Security Engine (${Array.isArray(secDecision.reasons) ? secDecision.reasons.join(', ') : 'HIGH_RISK'})`,
              securityDecision: secDecision,
            },
            { status: 403 },
          );
        }
      }
      return invoke(['enter', ...roleFlags, '--subject', subject, ...json]);
    }
    case 'organiser/advance-and-lock': {
      if (body.seconds !== undefined) {
        const advance = await runCli(['advance-time', '--seconds', String(num(body.seconds, 121))]) as ApiMutationResponse;
        if (!advance.ok) return NextResponse.json(advance, { status: httpStatus(advance) });
      } else {
        // Advance in bounded steps while the entry window is open, including at its deadline.
        let remaining = MAX_ENTRY_WINDOW_SECONDS + 1;
        for (let step = 121; remaining > 0; step *= 2) {
          const status = await runCli(['status']);
          if (status.ok === false) {
            return NextResponse.json(status, { status: httpStatus(status as ApiMutationResponse) });
          }
          if (status.phase !== 'ENTRY') break;
          const seconds = Math.min(step, remaining);
          const advance = await runCli(['advance-time', '--seconds', String(seconds)]) as ApiMutationResponse;
          if (!advance.ok) return NextResponse.json(advance, { status: httpStatus(advance) });
          remaining -= seconds;
        }
      }
      return invoke(['lock-draw', '--role', 'organiser', ...json]);
    }
    case 'organiser/advance-time': return invoke(['advance-time', '--seconds', String(num(body.seconds, 301)), ...json]);
    case 'organiser/create-event': {
      const capacity = Math.max(1, Math.min(50, Math.floor(num(body.capacity, 2))));
      const entryWindow = Math.max(30, Math.min(MAX_ENTRY_WINDOW_SECONDS, Math.floor(num(body.entryWindowSeconds, 600))));
      const facePriceInr = Math.max(100, Math.floor(num(body.facePriceInr, 3000)));
      const facePriceWei = inrToWei(String(facePriceInr), '50000000000000000', 3000);
      const resetRes = await runCli(['reset-demo'], 30_000);
      if (resetRes.ok === false && resetRes.txStatus === 'unknown_recovering') {
        return NextResponse.json(resetRes, { status: 202 });
      }
      const initRes = (await runCli(
        [
          'init-demo',
          '--capacity',
          String(capacity),
          '--entry-window',
          String(entryWindow),
          '--face-price',
          facePriceWei,
        ],
        30_000,
      )) as ApiMutationResponse;
      return NextResponse.json(initRes, { status: httpStatus(initRes) });
    }
    case 'organiser/reset-event': {
      const resetRes = await runCli(['reset-demo'], 15_000);
      return NextResponse.json(resetRes, { status: resetRes.ok === false ? 500 : 200 });
    }
    case 'organiser/draw': {
      const status = await runCli(['status']) as Partial<DemoStatusResponse> & { ok?: boolean };
      if (shouldMineBeforeFinalize(status)) {
        const mined = await runCli(['mine', '--blocks', '2']);
        if (mined.txStatus === 'unknown_recovering') return NextResponse.json(mined, { status: 202 });
      }
      return invoke(['draw', '--role', 'organiser', ...json]);
    }
    case 'claim': return invoke(['claim', ...roleFlags, ...json]);
    case 'list': return invoke(['list', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), '--price', str(body.priceWei), ...json]);
    case 'buy': return invoke(['buy', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), '--price', str(body.priceWei), ...json]);
    case 'credential/sign': {
      const signed = await runCli(['sign-gate', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), ...(body.expirySeconds ? ['--expiry', str(body.expirySeconds)] : []), ...json]);
      if (!signed.ownerSig) {
        const failure = signed as ApiMutationResponse;
        return NextResponse.json(failure, { status: httpStatus(failure) });
      }
      const credential = { contract: signed.contract, editionId: signed.editionId, slot: signed.slot, version: signed.version, expiry: signed.expiry, ownerSig: signed.ownerSig };
      return NextResponse.json({ ok: true, txStatus: 'confirmed', txHash: null, credential });
    }
    case 'gate/redeem': {
      const credential = body.credential as Record<string, unknown> | undefined;
      if (!credential) return NextResponse.json({ ok: false, txStatus: 'rejected', error: 'credential is required' }, { status: 400 });
      return invoke(['redeem', '--role', 'gate', '--scan-id', str(body.scanId || randomBytes32()), '--slot', str(credential.slot), '--version', str(credential.version), '--expiry', str(credential.expiry), '--owner-sig', str(credential.ownerSig), ...json]);
    }
    case 'withdraw': return invoke(['withdraw', ...roleFlags, ...json]);
    case 'security/eval': {
      const raw = (body.event && typeof body.event === 'object' ? body.event : body) as Record<string, unknown>;
      const nowIso = new Date().toISOString();
      const rand = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const ctx = (raw.eventContext && typeof raw.eventContext === 'object' ? raw.eventContext : {}) as Record<string, unknown>;
      const eventPayload = {
        eventId: str(raw.eventId, `web_evt_${rand}`),
        timestamp: str(raw.timestamp, nowIso),
        eventType: str(raw.eventType, 'QUEUE_JOIN'),
        eventIdempotencyKey: str(raw.eventIdempotencyKey, `web_idem_${rand}`),
        accountId: str(raw.accountId, 'web_fan_1'),
        sessionId: str(raw.sessionId, 'web_sess_1'),
        eventContext: {
          eventSaleId: str(ctx.eventSaleId ?? raw.eventSaleId, 'concert_live'),
          deviceId: ctx.deviceId ?? raw.deviceId ?? null,
          networkId: ctx.networkId ?? raw.networkId ?? null,
          paymentTokenHash: ctx.paymentTokenHash ?? raw.paymentTokenHash ?? null,
          queueGrant: ctx.queueGrant ?? raw.queueGrant ?? null,
          reservationId: ctx.reservationId ?? raw.reservationId ?? null,
          holdTtlMs: ctx.holdTtlMs ?? raw.holdTtlMs ?? null,
          quantity: ctx.quantity ?? raw.quantity ?? 1,
        },
      };
      const evalRes = await runCli(['security-eval', '--event', JSON.stringify(eventPayload)], 15_000);
      return NextResponse.json(evalRes, { status: evalRes.ok === false ? 400 : 200 });
    }
    case 'attack/run': {
      const scenario = str(body.scenario, 'repeated-entry');
      if (scenario === 'account-farm') {
        const res = await runCli(['demo-attack', '--scenario', 'account-farm'], 30_000);
        return NextResponse.json(res, { status: res.ok === false ? 500 : 200 });
      }
      return invoke(['demo-attack', '--scenario', scenario, '--attempts', String(num(body.attempts, 3)), '--control-role', str(body.controlRole, 'fanA'), ...json]);
    }
    case 'tx/resume': return invoke(['resume', ...roleFlags, ...(body.scanId ? ['--scan-id', str(body.scanId)] : []), ...(body.txHash ? ['--tx-hash', str(body.txHash)] : []), ...json]);
    default: return NextResponse.json({ ok: false, error: 'Unknown API route' }, { status: 404 });
  }
}
