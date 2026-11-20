import { NextRequest, NextResponse } from 'next/server';
import { httpStatus, roleArgs, runCli } from '@/lib/cli-bridge';
import type { ApiMutationResponse, RoleId } from '@/lib/types';

export const runtime = 'nodejs';
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
    case 'enter': return invoke(['enter', ...roleFlags, '--subject', str(body.subject, `demo-${role(body)}`), ...json]);
    case 'organiser/advance-and-lock': {
      const advance = await runCli(['advance-time', '--seconds', String(num(body.seconds, 121))]);
      if (advance.txStatus === 'unknown_recovering') return NextResponse.json(advance, { status: 202 });
      return invoke(['lock-draw', '--role', 'organiser', ...json]);
    }
    case 'organiser/draw': {
      const mined = await runCli(['mine', '--blocks', '2']);
      if (mined.txStatus === 'unknown_recovering') return NextResponse.json(mined, { status: 202 });
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
    case 'tx/resume': return invoke(['resume', ...roleFlags, ...(body.scanId ? ['--scan-id', str(body.scanId)] : []), ...(body.txHash ? ['--tx-hash', str(body.txHash)] : []), ...json]);
    default: return NextResponse.json({ ok: false, error: 'Unknown API route' }, { status: 404 });
  }
}
