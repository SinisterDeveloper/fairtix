export type SecurityEventType =
  | 'ACCOUNT_REGISTER'
  | 'QUEUE_JOIN'
  | 'RESERVATION_CREATE'
  | 'RESERVATION_ABANDON'
  | 'RESERVATION_EXPIRE'
  | 'CHECKOUT_ATTEMPT'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_PASSED';

export const VALID_EVENT_TYPES: ReadonlySet<SecurityEventType> = new Set([
  'ACCOUNT_REGISTER',
  'QUEUE_JOIN',
  'RESERVATION_CREATE',
  'RESERVATION_ABANDON',
  'RESERVATION_EXPIRE',
  'CHECKOUT_ATTEMPT',
  'VERIFICATION_FAILED',
  'VERIFICATION_PASSED',
]);

export interface SecurityEventContext {
  eventSaleId: string;
  deviceId: string | null;
  networkId: string | null;
  paymentTokenHash: string | null;
  queueGrant?: string | null;
  reservationId?: string | null;
  holdTtlMs?: number | null;
  quantity?: number | null;
  walletAddress?: string | null;
}

export interface SecurityEvent {
  eventId: string;
  timestamp: string;
  eventType: SecurityEventType;
  eventIdempotencyKey: string;
  accountId: string;
  sessionId: string;
  eventContext: SecurityEventContext;
}

export interface NormalizedSecurityEvent extends SecurityEvent {
  timestampMs: number;
  quantity: number;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid SecurityEvent: "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('Invalid SecurityEventContext: optional identifier must be a string or null');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalPositiveInteger(value: unknown, fallback: number, fieldName: string): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid SecurityEventContext: "${fieldName}" must be a positive integer`);
  }
  return value;
}

/**
 * Validates and normalizes an incoming SecurityEvent, stripping any untrusted
 * client-supplied override fields (e.g., riskScore, decision, isEligible).
 */
export function validateAndNormalizeEvent(raw: unknown): NormalizedSecurityEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid SecurityEvent: payload must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  const eventId = requireNonEmptyString(record.eventId, 'eventId');
  const timestamp = requireNonEmptyString(record.timestamp, 'timestamp');
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`Invalid SecurityEvent: "timestamp" is not a valid ISO-8601 date (${timestamp})`);
  }

  const eventTypeRaw = requireNonEmptyString(record.eventType, 'eventType') as SecurityEventType;
  if (!VALID_EVENT_TYPES.has(eventTypeRaw)) {
    throw new Error(`Invalid SecurityEvent: unsupported "eventType" (${eventTypeRaw})`);
  }

  const eventIdempotencyKey = requireNonEmptyString(record.eventIdempotencyKey, 'eventIdempotencyKey');
  const accountId = requireNonEmptyString(record.accountId, 'accountId');
  const sessionId = requireNonEmptyString(record.sessionId, 'sessionId');

  if (!record.eventContext || typeof record.eventContext !== 'object' || Array.isArray(record.eventContext)) {
    throw new Error('Invalid SecurityEvent: "eventContext" must be an object');
  }
  const ctx = record.eventContext as Record<string, unknown>;

  const eventSaleId = requireNonEmptyString(ctx.eventSaleId, 'eventContext.eventSaleId');
  const deviceId = optionalNullableString(ctx.deviceId);
  const networkId = optionalNullableString(ctx.networkId);
  const paymentTokenHash = optionalNullableString(ctx.paymentTokenHash);
  const queueGrant = optionalNullableString(ctx.queueGrant);
  const reservationId = optionalNullableString(ctx.reservationId);
  const walletAddress = optionalNullableString(ctx.walletAddress);
  const quantity = optionalPositiveInteger(ctx.quantity, 1, 'eventContext.quantity');
  const holdTtlMs =
    ctx.holdTtlMs === null || ctx.holdTtlMs === undefined
      ? null
      : optionalPositiveInteger(ctx.holdTtlMs, 60_000, 'eventContext.holdTtlMs');

  return {
    eventId,
    timestamp,
    timestampMs,
    eventType: eventTypeRaw,
    eventIdempotencyKey,
    accountId,
    sessionId,
    quantity,
    eventContext: {
      eventSaleId,
      deviceId,
      networkId,
      paymentTokenHash,
      queueGrant,
      reservationId,
      holdTtlMs,
      quantity,
      walletAddress,
    },
  };
}
