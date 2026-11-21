import fs from 'node:fs';
import nodePath from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { shouldMineBeforeFinalize } from '@/lib/allocation';
import { httpStatus, roleArgs, runCli } from '@/lib/cli-bridge';
import { inrToWei } from '@/lib/format';
import { issueStepUpChallenge, verifyStepUpChallenge } from '@/lib/step-up-challenge';
import type { ActivityLogEntry, ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export const runtime = 'nodejs';
const MAX_ENTRY_WINDOW_SECONDS = 86_400;
type Body = Record<string, unknown>;
const str = (v: unknown, fallback = '') => String(v ?? fallback);
const num = (v: unknown, fallback = 0) => Number(v ?? fallback);
const randomBytes32 = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const role = (b: Body) => str(b.role, 'fanA') as RoleId;
const invoke = async (args: string[], securityDecision?: Record<string, unknown> | null) => {
  const result = (await runCli(args)) as ApiMutationResponse;
  if (securityDecision) {
    result.securityDecision = securityDecision as ApiMutationResponse['securityDecision'];
  }
  return NextResponse.json(result, { status: httpStatus(result) });
};

async function evaluateLiveSecurityGate(
  eventType: 'QUEUE_JOIN' | 'CHECKOUT_ATTEMPT',
  body: Body,
  accountId: string,
): Promise<{ blockedResponse: NextResponse | null; securityDecision: Record<string, unknown> | null }> {
  if (body.enforceSecurity === false) {
    return { blockedResponse: null, securityDecision: null };
  }
  const activeRole = role(body);
  const nowIso = new Date().toISOString();
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const eventId = `web_${eventType.toLowerCase()}_${suffix}`;
  const secEvent = {
    eventId,
    timestamp: str(body.timestamp, nowIso),
    eventType,
    eventIdempotencyKey: str(body.eventIdempotencyKey, `idem_${eventId}`),
    accountId,
    sessionId: str(body.sessionId, `live_sess_${activeRole}`),
    eventContext: {
      eventSaleId: str(body.eventSaleId, 'fairtickets_live_sale'),
      deviceId: body.deviceId ? str(body.deviceId) : `live_dev_${activeRole}`,
      networkId: body.networkId ? str(body.networkId) : 'live_net_local',
      paymentTokenHash: body.paymentTokenHash ? str(body.paymentTokenHash) : `live_pay_${activeRole}`,
    },
  };
  const secDecision = await runCli(['security-eval', '--event', JSON.stringify(secEvent)], 15_000);
  const decision = str(secDecision.decision, 'ALLOW');
  const reasonsList = Array.isArray(secDecision.reasons) && secDecision.reasons.length > 0
    ? secDecision.reasons.join(', ')
    : 'HIGH_RISK';

  if (decision === 'BLOCK') {
    return {
      blockedResponse: NextResponse.json(
        {
          ok: false,
          txStatus: 'rejected',
          txHash: null,
          errorCode: 'SECURITY_BLOCKED',
          error: `Blocked by Hybrid Security Engine (${reasonsList})`,
          securityDecision: secDecision,
        },
        { status: 403 },
      ),
      securityDecision: secDecision,
    };
  }

  if (decision === 'CHALLENGE') {
    const rawResp =
      body.challengeResponse && typeof body.challengeResponse === 'object'
        ? (body.challengeResponse as Record<string, unknown>)
        : null;
    if (rawResp) {
      const verified = verifyStepUpChallenge({
        challengeId: str(rawResp.challengeId),
        token: str(rawResp.token),
        answer: str(rawResp.answer),
        accountId,
        action: eventType,
      });
      if (verified.ok) {
        return { blockedResponse: null, securityDecision: secDecision };
      }
      // Record failed verification into RiskEngine (+20 PREVIOUSLY_FAILED_VERIFICATION)
      const failId = `web_vfail_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const failEvent = {
        ...secEvent,
        eventId: failId,
        timestamp: new Date().toISOString(),
        eventType: 'VERIFICATION_FAILED',
        eventIdempotencyKey: `idem_${failId}`,
      };
      const updatedDecision = await runCli(['security-eval', '--event', JSON.stringify(failEvent)], 15_000);
      const freshChallenge = issueStepUpChallenge(accountId, eventType);
      return {
        blockedResponse: NextResponse.json(
          {
            ok: false,
            txStatus: 'rejected',
            txHash: null,
            errorCode: 'SECURITY_CHALLENGE_FAILED',
            error: `Step-up verification failed (${verified.reason || 'Invalid answer'}). Complete the new verification prompt.`,
            securityDecision: updatedDecision,
            stepUpChallenge: freshChallenge,
          },
          { status: 403 },
        ),
        securityDecision: updatedDecision,
      };
    }

    const stepUpChallenge = issueStepUpChallenge(accountId, eventType);
    return {
      blockedResponse: NextResponse.json(
        {
          ok: false,
          txStatus: 'rejected',
          txHash: null,
          errorCode: 'SECURITY_CHALLENGE_REQUIRED',
          error: `Step-up verification required by Hybrid Security Engine (${reasonsList})`,
          securityDecision: secDecision,
          stepUpChallenge,
        },
        { status: 403 },
      ),
      securityDecision: secDecision,
    };
  }

  return { blockedResponse: null, securityDecision: secDecision };
}

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
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('QUEUE_JOIN', body, subject);
      if (blockedResponse) return blockedResponse;
      return invoke(['enter', ...roleFlags, '--subject', subject, ...json], securityDecision);
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
    case 'organiser/draw': {
      const status = await runCli(['status']) as Partial<DemoStatusResponse> & { ok?: boolean };
      if (shouldMineBeforeFinalize(status)) {
        const mined = await runCli(['mine', '--blocks', '2']);
        if (mined.txStatus === 'unknown_recovering') return NextResponse.json(mined, { status: 202 });
      }
      return invoke(['draw', '--role', 'organiser', ...json]);
    }
    case 'claim': {
      const accountId = str(body.subject, `demo-${role(body)}-subject`);
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('CHECKOUT_ATTEMPT', body, accountId);
      if (blockedResponse) return blockedResponse;
      return invoke(['claim', ...roleFlags, ...json], securityDecision);
    }
    case 'list': return invoke(['list', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), '--price', str(body.priceWei), ...json]);
    case 'buy': {
      const accountId = str(body.subject, `demo-${role(body)}-subject`);
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('CHECKOUT_ATTEMPT', body, accountId);
      if (blockedResponse) return blockedResponse;
      return invoke(['buy', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), '--price', str(body.priceWei), ...json], securityDecision);
    }
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
