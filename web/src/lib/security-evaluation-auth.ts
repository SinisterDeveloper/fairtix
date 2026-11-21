import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export function authorizeSecurityEvaluation(req: NextRequest, operation: 'replay' | 'capacity benchmark') {
  const token = process.env.FAIRTICKETS_REPLAY_TOKEN?.trim();
  if (process.env.FAIRTICKETS_REPLAY_ENABLED !== '1' || !token) {
    return NextResponse.json({ ok: false, error: `Security ${operation} is disabled.` }, { status: 404 });
  }

  const authorization = req.headers.get('authorization') ?? '';
  const provided = /^Bearer (\S+)$/i.exec(authorization)?.[1];
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(token))) {
    return NextResponse.json(
      { ok: false, error: `Enter a valid operator token to run the ${operation}.` },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  return null;
}
