import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { StepUpChallenge } from './types';

const STEP_UP_SECRET =
  process.env.FAIRTICKETS_SECURITY_SECRET || 'fairtickets-dev-step-up-secret-v1';
const CHALLENGE_TTL_MS = 120_000;
const consumedChallenges = new Set<string>();

function signChallengePayload(
  challengeId: string,
  accountId: string,
  action: string,
  answer: string,
  expiresAt: number,
): string {
  const canonical = `${challengeId}|${accountId}|${action}|${answer.trim()}|${expiresAt}`;
  return createHmac('sha256', STEP_UP_SECRET).update(canonical).digest('hex');
}

export function issueStepUpChallenge(accountId: string, action: string): StepUpChallenge {
  const challengeId = `chl_${randomBytes(8).toString('hex')}`;
  const a = randomInt(3, 13);
  const b = randomInt(3, 13);
  const answer = String(a + b);
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const mac = signChallengePayload(challengeId, accountId, action, answer, expiresAt);
  const token = `${expiresAt}.${mac}`;

  return {
    challengeId,
    prompt: `Human verification required: what is ${a} + ${b}?`,
    token,
    expiresAt,
  };
}

export function verifyStepUpChallenge(params: {
  challengeId: string;
  token: string;
  answer: string;
  accountId: string;
  action: string;
}): { ok: boolean; reason?: string } {
  const { challengeId, token, answer, accountId, action } = params;
  if (!challengeId || !token || !answer.trim()) {
    return { ok: false, reason: 'Missing challengeId, token, or answer' };
  }
  if (consumedChallenges.has(challengeId)) {
    return { ok: false, reason: 'Challenge token already consumed' };
  }

  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) {
    return { ok: false, reason: 'Malformed challenge token' };
  }
  const expiresAt = Number(token.slice(0, dotIdx));
  const providedMac = token.slice(dotIdx + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return { ok: false, reason: 'Step-up challenge expired' };
  }

  const expectedMac = signChallengePayload(
    challengeId,
    accountId,
    action,
    answer,
    expiresAt,
  );
  const providedBuf = Buffer.from(providedMac, 'utf8');
  const expectedBuf = Buffer.from(expectedMac, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'Incorrect verification answer' };
  }

  consumedChallenges.add(challengeId);
  return { ok: true };
}
