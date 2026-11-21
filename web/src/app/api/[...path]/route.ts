import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { shouldMineBeforeFinalize } from '@/lib/allocation';
import { httpStatus, roleArgs, runCli } from '@/lib/cli-bridge';
import { inrToWei } from '@/lib/format';
import { issueStepUpChallenge, verifyStepUpChallenge } from '@/lib/step-up-challenge';
import type { ActivityLogEntry, ApiMutationResponse, DemoStatusResponse, EventDisplayMeta, RoleId } from '@/lib/types';

export const runtime = 'nodejs';
const MAX_ENTRY_WINDOW_SECONDS = 86_400;
const BASE_FACE_PRICE_WEI = BigInt('50000000000000000');
const BASE_FACE_PRICE_INR = BigInt(3000);
const DEFAULT_EVENT_META: EventDisplayMeta = { title: 'Live Concert Event', venue: 'Main Arena', dateLabel: 'Upcoming' };

function eventMetaPath() {
  const stateTag = (process.env.FAIRTICKETS_STATE_DIR || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return nodePath.join(os.tmpdir(), `fairtickets-event-meta-${stateTag}.json`);
}

function readServerEventMeta(): EventDisplayMeta {
  try {
    const p = eventMetaPath();
    if (!fs.existsSync(p)) return DEFAULT_EVENT_META;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<EventDisplayMeta>;
    return {
      title: raw.title?.trim() || DEFAULT_EVENT_META.title,
      venue: raw.venue?.trim() || DEFAULT_EVENT_META.venue,
      dateLabel: raw.dateLabel?.trim() || DEFAULT_EVENT_META.dateLabel,
    };
  } catch {
    return DEFAULT_EVENT_META;
  }
}

function writeServerEventMeta(meta: EventDisplayMeta) {
  try {
    fs.writeFileSync(eventMetaPath(), JSON.stringify(meta, null, 2));
  } catch {}
}

function clearServerEventMeta() {
  try {
    const p = eventMetaPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function walletPath() {
  const stateTag = (process.env.FAIRTICKETS_STATE_DIR || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return nodePath.join(os.tmpdir(), `fairtickets-wallets-${stateTag}.json`);
}

function readWallets(): Record<string, number> {
  try {
    const p = walletPath();
    if (!fs.existsSync(p)) return { fanA: 0, fanB: 0 };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      fanA: Math.max(0, Number(raw.fanA ?? 0)),
      fanB: Math.max(0, Number(raw.fanB ?? 0)),
    };
  } catch {
    return { fanA: 0, fanB: 0 };
  }
}

function writeWallets(wallets: Record<string, number>) {
  try {
    fs.writeFileSync(walletPath(), JSON.stringify(wallets, null, 2));
  } catch {}
}

function seatsPath() {
  const stateTag = (process.env.FAIRTICKETS_STATE_DIR || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return nodePath.join(os.tmpdir(), `fairtickets-seats-${stateTag}.json`);
}

function readSeats(): Record<string, string> {
  try {
    const p = seatsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSeats(seats: Record<string, string>) {
  try {
    fs.writeFileSync(seatsPath(), JSON.stringify(seats, null, 2));
  } catch {}
}

function computeFacePriceInr(facePriceWei: unknown, fallback = 3000): number {
  try {
    if (!facePriceWei) return fallback;
    const wei = BigInt(String(facePriceWei));
    if (wei <= BigInt(0)) return fallback;
    return Math.max(1, Math.round(Number((wei * BASE_FACE_PRICE_INR + BASE_FACE_PRICE_WEI / BigInt(2)) / BASE_FACE_PRICE_WEI)));
  } catch {
    return fallback;
  }
}
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
  const rawResp =
    body.challengeResponse && typeof body.challengeResponse === 'object'
      ? (body.challengeResponse as Record<string, unknown>)
      : null;

  if (body.simulateSharedDevice === true && !rawResp) {
    for (let i = 1; i <= 3; i += 1) {
      const peerSuffix = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
      const peerEvent = {
        eventId: `web_sim_peer_${peerSuffix}`,
        timestamp: new Date().toISOString(),
        eventType,
        eventIdempotencyKey: `idem_sim_peer_${peerSuffix}`,
        accountId: `sim_bot_cluster_${i}`,
        sessionId: `sim_sess_${i}`,
        eventContext: {
          ...secEvent.eventContext,
          deviceId: secEvent.eventContext.deviceId || 'shared_bot_dev_demo',
          networkId: 'shared_bot_net_demo',
          paymentTokenHash: secEvent.eventContext.paymentTokenHash || 'shared_bot_pay_demo',
        },
      };
      await runCli(['security-eval', '--event', JSON.stringify(peerEvent)], 15_000);
    }
  }

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

  if (rawResp && decision !== 'BLOCK') {
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

  if (decision === 'CHALLENGE') {
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
    if (status.ok !== false && status.facePriceWei) {
      status.facePriceInr = computeFacePriceInr(status.facePriceWei, Number(status.facePriceInr || 3000));
      status.eventMeta = readServerEventMeta();
      status.walletBalancesInr = readWallets();
      status.takenSeats = readSeats();
    }
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
    case 'wallet/topup': {
      const targetRole = role(body);
      if (targetRole !== 'fanA' && targetRole !== 'fanB') {
        return NextResponse.json({ ok: false, txStatus: 'rejected', txHash: null, error: 'Select Fan A or Fan B to top up wallet.' }, { status: 400 });
      }
      const amount = Math.max(100, Math.min(100_000, Math.floor(num(body.amountInr, 3000))));
      const wallets = readWallets();
      wallets[targetRole] = (wallets[targetRole] || 0) + amount;
      writeWallets(wallets);
      return NextResponse.json({ ok: true, txStatus: 'confirmed', txHash: null, walletBalancesInr: wallets });
    }
    case 'enter': {
      const targetRole = role(body);
      if (fs.existsSync(walletPath()) && (targetRole === 'fanA' || targetRole === 'fanB')) {
        const st = await runCli(['status']);
        const requiredInr = computeFacePriceInr(st.facePriceWei, Number(st.facePriceInr || 3000));
        const wallets = readWallets();
        if ((wallets[targetRole] || 0) < requiredInr) {
          return NextResponse.json(
            {
              ok: false,
              txStatus: 'rejected',
              txHash: null,
              error: `Insufficient wallet balance (₹${wallets[targetRole] || 0}). Add at least ₹${requiredInr.toLocaleString('en-IN')} to join the queue.`,
            },
            { status: 409 },
          );
        }
      }
      const requestedSeat = body.seat ? String(Math.max(1, Math.floor(num(body.seat, 1)))) : null;
      if (requestedSeat) {
        const seats = readSeats();
        if (seats[requestedSeat] && seats[requestedSeat] !== targetRole) {
          return NextResponse.json(
            { ok: false, txStatus: 'rejected', txHash: null, error: `Seat #S${requestedSeat} is already occupied. Please select another seat.` },
            { status: 409 },
          );
        }
      }
      const subject = str(body.subject, `demo-${role(body)}`);
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('QUEUE_JOIN', body, subject);
      if (blockedResponse) return blockedResponse;
      const enterRes = (await runCli(['enter', ...roleFlags, '--subject', subject])) as ApiMutationResponse;
      if (securityDecision) {
        enterRes.securityDecision = securityDecision as ApiMutationResponse['securityDecision'];
      }
      if (enterRes.txStatus === 'confirmed' && requestedSeat && (targetRole === 'fanA' || targetRole === 'fanB')) {
        const seats = readSeats();
        seats[requestedSeat] = targetRole;
        writeSeats(seats);
      }
      return NextResponse.json(enterRes, { status: httpStatus(enterRes) });
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
      if (initRes.ok !== false && initRes.txStatus === 'confirmed') {
        writeServerEventMeta({
          title: str(body.title, DEFAULT_EVENT_META.title).trim() || DEFAULT_EVENT_META.title,
          venue: str(body.venue, DEFAULT_EVENT_META.venue).trim() || DEFAULT_EVENT_META.venue,
          dateLabel: str(body.dateLabel, DEFAULT_EVENT_META.dateLabel).trim() || DEFAULT_EVENT_META.dateLabel,
        });
        writeWallets({ fanA: 0, fanB: 0 });
      writeSeats({});
      }
      return NextResponse.json(initRes, { status: httpStatus(initRes) });
    }
    case 'organiser/save-meta': {
      const meta: EventDisplayMeta = {
        title: str(body.title, DEFAULT_EVENT_META.title).trim() || DEFAULT_EVENT_META.title,
        venue: str(body.venue, DEFAULT_EVENT_META.venue).trim() || DEFAULT_EVENT_META.venue,
        dateLabel: str(body.dateLabel, DEFAULT_EVENT_META.dateLabel).trim() || DEFAULT_EVENT_META.dateLabel,
      };
      writeServerEventMeta(meta);
      return NextResponse.json({ ok: true, txStatus: 'confirmed', txHash: null, eventMeta: meta });
    }
    case 'organiser/reset-event': {
      const resetRes = await runCli(['reset-demo'], 15_000);
      clearServerEventMeta();
      writeWallets({ fanA: 0, fanB: 0 });
      writeSeats({});
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
    case 'claim': {
      const targetRole = role(body);
      const accountId = str(body.subject, `demo-${targetRole}-subject`);
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('CHECKOUT_ATTEMPT', body, accountId);
      if (blockedResponse) return blockedResponse;
      const claimRes = (await runCli(['claim', ...roleFlags])) as ApiMutationResponse;
      if (claimRes.txStatus === 'confirmed' && (targetRole === 'fanA' || targetRole === 'fanB') && fs.existsSync(walletPath())) {
        const st = await runCli(['status']);
        const priceInr = computeFacePriceInr(st.facePriceWei, Number(st.facePriceInr || 3000));
        const wallets = readWallets();
        wallets[targetRole] = Math.max(0, (wallets[targetRole] || 0) - priceInr);
        writeWallets(wallets);
      }
      if (securityDecision) {
        claimRes.securityDecision = securityDecision as ApiMutationResponse['securityDecision'];
      }
      return NextResponse.json(claimRes, { status: httpStatus(claimRes) });
    }
    case 'list': return invoke(['list', ...roleFlags, '--slot', str(body.slot), '--version', str(body.version), '--price', str(body.priceWei), ...json]);
    case 'buy': {
      const targetRole = role(body);
      const buyPriceInr = computeFacePriceInr(body.priceWei, 3000);
      if (fs.existsSync(walletPath()) && (targetRole === 'fanA' || targetRole === 'fanB')) {
        const wallets = readWallets();
        if ((wallets[targetRole] || 0) < buyPriceInr) {
          return NextResponse.json(
            {
              ok: false,
              txStatus: 'rejected',
              txHash: null,
              error: `Insufficient wallet balance (₹${wallets[targetRole] || 0}). Add at least ₹${buyPriceInr.toLocaleString('en-IN')} to buy this listing.`,
            },
            { status: 409 },
          );
        }
      }
      const accountId = str(body.subject, `demo-${targetRole}-subject`);
      const { blockedResponse, securityDecision } = await evaluateLiveSecurityGate('CHECKOUT_ATTEMPT', body, accountId);
      if (blockedResponse) return blockedResponse;
      const buyRes = (await runCli([
        'buy',
        ...roleFlags,
        '--slot',
        str(body.slot),
        '--version',
        str(body.version),
        '--price',
        str(body.priceWei),
      ])) as ApiMutationResponse;
      if (buyRes.txStatus === 'confirmed' && (targetRole === 'fanA' || targetRole === 'fanB') && fs.existsSync(walletPath())) {
        const sellerRole = targetRole === 'fanA' ? 'fanB' : 'fanA';
        const wallets = readWallets();
        wallets[targetRole] = Math.max(0, (wallets[targetRole] || 0) - buyPriceInr);
        wallets[sellerRole] = (wallets[sellerRole] || 0) + buyPriceInr;
        writeWallets(wallets);
      }
      if (securityDecision) {
        buyRes.securityDecision = securityDecision as ApiMutationResponse['securityDecision'];
      }
      return NextResponse.json(buyRes, { status: httpStatus(buyRes) });
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
