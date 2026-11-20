import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RuleSignal } from '../decisions.ts';
import type { NormalizedSecurityEvent } from '../events.ts';

export interface QueueGrantPayload {
  eventSaleId: string;
  accountId: string;
  sessionId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
}

export interface IssueQueueGrantParams {
  eventSaleId: string;
  accountId: string;
  sessionId: string;
  issuedAtMs?: number;
  ttlMs?: number;
}

/**
 * Priority 2 — OAT-006: Expediting / Queue Bypass Guard.
 * Issues and cryptographically verifies HMAC-SHA256 queue grants bound to
 * (eventSaleId, accountId, sessionId). Invalid, expired, missing, or replayed
 * grants trigger a hard authorization failure that bypasses heuristic scoring.
 */
export class ExpeditingGuard {
  private readonly secret: Buffer;
  private readonly saleRequiresGrant = new Map<string, boolean>();
  private readonly joinedAccounts = new Map<string, Set<string>>();
  private readonly consumedGrantNonces = new Set<string>();
  private unauthorizedCheckoutAttempts = 0;
  private unauthorizedCheckoutsAllowed = 0;

  constructor(secret = process.env.FAIRTICKETS_SECURITY_SECRET || 'fairtickets-dev-queue-grant-secret-v1') {
    this.secret = Buffer.from(secret, 'utf8');
  }

  configureSale(eventSaleId: string, requireQueueGrants: boolean): void {
    this.saleRequiresGrant.set(eventSaleId, requireQueueGrants);
  }

  isGrantRequired(eventSaleId: string): boolean {
    return this.saleRequiresGrant.get(eventSaleId) ?? false;
  }

  recordQueueJoin(eventSaleId: string, accountId: string): void {
    let set = this.joinedAccounts.get(eventSaleId);
    if (!set) {
      set = new Set();
      this.joinedAccounts.set(eventSaleId, set);
    }
    set.add(accountId);
  }

  issueQueueGrant(params: IssueQueueGrantParams): string {
    const issuedAtMs = params.issuedAtMs ?? Date.now();
    const ttlMs = params.ttlMs ?? 300_000;
    const payload: QueueGrantPayload = {
      eventSaleId: params.eventSaleId,
      accountId: params.accountId,
      sessionId: params.sessionId,
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
      nonce: randomBytes(12).toString('hex'),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.secret).update(encodedPayload).digest('hex');
    return `${encodedPayload}.${sig}`;
  }

  verifyGrantToken(
    token: string,
    expected: { eventSaleId: string; accountId: string; sessionId: string; nowMs: number }
  ): { valid: true; payload: QueueGrantPayload } | { valid: false; reason: 'INVALID_QUEUE_GRANT' | 'EXPIRED_QUEUE_GRANT' | 'REPLAYED_QUEUE_GRANT'; detail: string } {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, reason: 'INVALID_QUEUE_GRANT', detail: 'Malformed queue grant token format' };
    }
    const [encodedPayload, providedHex] = parts;
    const expectedHex = createHmac('sha256', this.secret).update(encodedPayload).digest('hex');

    if (providedHex.length !== expectedHex.length) {
      return { valid: false, reason: 'INVALID_QUEUE_GRANT', detail: 'Queue grant signature length mismatch' };
    }
    let sigMatch = false;
    try {
      sigMatch = timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
    } catch {
      sigMatch = false;
    }
    if (!sigMatch) {
      return { valid: false, reason: 'INVALID_QUEUE_GRANT', detail: 'Invalid queue grant HMAC signature' };
    }

    let payload: QueueGrantPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as QueueGrantPayload;
    } catch {
      return { valid: false, reason: 'INVALID_QUEUE_GRANT', detail: 'Unparseable queue grant payload' };
    }

    if (payload.eventSaleId !== expected.eventSaleId) {
      return {
        valid: false,
        reason: 'INVALID_QUEUE_GRANT',
        detail: `Queue grant eventSaleId mismatch (expected ${expected.eventSaleId}, got ${payload.eventSaleId})`,
      };
    }
    if (payload.accountId !== expected.accountId) {
      return {
        valid: false,
        reason: 'INVALID_QUEUE_GRANT',
        detail: `Queue grant accountId mismatch (bound to ${payload.accountId}, presented by ${expected.accountId})`,
      };
    }
    if (payload.sessionId !== expected.sessionId) {
      return {
        valid: false,
        reason: 'INVALID_QUEUE_GRANT',
        detail: `Queue grant session mismatch (bound to ${payload.sessionId}, presented by ${expected.sessionId})`,
      };
    }
    if (expected.nowMs > payload.expiresAtMs) {
      return {
        valid: false,
        reason: 'EXPIRED_QUEUE_GRANT',
        detail: `Queue grant expired at ${new Date(payload.expiresAtMs).toISOString()}`,
      };
    }
    if (this.consumedGrantNonces.has(payload.nonce)) {
      return {
        valid: false,
        reason: 'REPLAYED_QUEUE_GRANT',
        detail: `Queue grant nonce ${payload.nonce} was already consumed on checkout`,
      };
    }

    return { valid: true, payload };
  }

  evaluate(event: NormalizedSecurityEvent, protectionsEnabled: boolean): { signals: RuleSignal[]; grantNonce?: string } {
    if (event.eventType !== 'RESERVATION_CREATE' && event.eventType !== 'CHECKOUT_ATTEMPT') {
      return { signals: [] };
    }

    const saleId = event.eventContext.eventSaleId;
    const requireGrant = this.isGrantRequired(saleId);
    const token = event.eventContext.queueGrant;

    // Even when a sale does not strictly mandate grants, presenting a bad grant is always rejected if protected.
    if (!token) {
      if (!requireGrant) {
        return { signals: [] };
      }
      const joined = this.joinedAccounts.get(saleId)?.has(event.accountId) ?? false;
      if (event.eventType === 'CHECKOUT_ATTEMPT') {
        this.unauthorizedCheckoutAttempts += 1;
        if (!protectionsEnabled) this.unauthorizedCheckoutsAllowed += 1;
      }
      if (!protectionsEnabled) return { signals: [] };

      return {
        signals: [
          {
            rule: 'OAT-006:expediting',
            reason: 'QUEUE_BYPASS_ATTEMPT',
            points: 0,
            hardFailure: true,
            detail: joined
              ? `Account ${event.accountId} attempted ${event.eventType} without presenting a signed queue grant`
              : `Account ${event.accountId} attempted ${event.eventType} without joining queue or presenting a signed queue grant`,
            supportingEventIds: [event.eventId],
          },
        ],
      };
    }

    const verification = this.verifyGrantToken(token, {
      eventSaleId: saleId,
      accountId: event.accountId,
      sessionId: event.sessionId,
      nowMs: event.timestampMs,
    });

    if (!verification.valid) {
      if (event.eventType === 'CHECKOUT_ATTEMPT') {
        this.unauthorizedCheckoutAttempts += 1;
        if (!protectionsEnabled) this.unauthorizedCheckoutsAllowed += 1;
      }
      if (!protectionsEnabled) return { signals: [] };

      return {
        signals: [
          {
            rule: 'OAT-006:expediting',
            reason: verification.reason,
            points: 0,
            hardFailure: true,
            detail: verification.detail,
            supportingEventIds: [event.eventId],
          },
        ],
      };
    }

    return { signals: [], grantNonce: verification.payload.nonce };
  }

  consumeGrant(grantNonce: string | undefined): void {
    if (grantNonce) {
      this.consumedGrantNonces.add(grantNonce);
    }
  }

  getStats(): { unauthorizedCheckoutAttempts: number; unauthorizedCheckoutsAllowed: number } {
    return {
      unauthorizedCheckoutAttempts: this.unauthorizedCheckoutAttempts,
      unauthorizedCheckoutsAllowed: this.unauthorizedCheckoutsAllowed,
    };
  }
}
