import type { DecisionAuditRecord, DecisionOutcome } from '../src/decisions.ts';
import type { SecurityEventType } from '../src/events.ts';
import { RiskEngine } from '../src/risk-engine.ts';
import { UnsupervisedBaselineDetector, type BaselineStatsSnapshot } from '../src/unsupervised-baseline.ts';

const fixtures = ['scalping', 'inventory', 'queue'] as const;
const profiles = ['mixed', 'linked', 'independent'] as const;
const saleId = 'security-replay';
const start = Date.UTC(2026, 0, 1);
const holdTtlMs = 15_000;

interface Identity {
  id: string;
  malicious: boolean;
  link: string;
  sharedNetwork: boolean;
}

interface FixtureStep {
  identity: Identity;
  eventType: SecurityEventType;
  offset: number;
  reservation?: string;
  quantity?: number;
  withoutGrant?: boolean;
}

interface Evidence {
  decisionId: string;
  eventId: string;
  eventType: string;
  accountId: string;
  malicious: boolean;
  decision: DecisionOutcome;
  behavioralDecision: DecisionOutcome;
  riskScore: number;
  mlScore: number | null;
  unsupervisedAnomalyScore: number | null;
  mlTopContributors: NonNullable<DecisionAuditRecord['mlTopContributors']>;
  hardFailure: boolean;
  reasons: string[];
  ticketsCommitted: number;
  available: number;
}

function option<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  const selected = allowed.find((candidate) => candidate === value);
  if (selected === undefined) throw new Error(`Invalid ${name}. Choose ${allowed.join(', ')}.`);
  return selected;
}

function integer(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

export function parseReplayConfig(options: Record<string, unknown>) {
  return {
    fixture: option('fixture', options.fixture, fixtures, 'scalping'),
    seed: integer('seed', options.seed, 0, 0xffffffff, 1),
    participants: integer('participants', options.participants, 4, 50, 50),
    inventory: integer('inventory', options.inventory, 1, 100, 100),
    profile: option('profile', options.profile, profiles, 'mixed'),
  };
}

type ReplayConfig = ReturnType<typeof parseReplayConfig>;

function buildFixture(config: ReplayConfig) {
  const maliciousCount = config.fixture === 'queue' ? 1 : Math.max(2, Math.floor(config.participants * 0.4));
  const identities: Identity[] = Array.from({ length: config.participants }, (_, index) => {
    const id = `buyer-${index + 1}`;
    const malicious = index < maliciousCount;
    const linked = malicious && (config.profile === 'linked' || (
      config.profile === 'mixed' && index < Math.max(2, Math.ceil(maliciousCount / 2))
    ));
    return { id, malicious, link: linked ? 'linked-cohort' : id, sharedNetwork: index >= config.participants - 2 };
  });

  // Shuffle fixture row order with a local PRNG. The timeline and labels are fixture data.
  let state = config.seed;
  for (let index = identities.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [identities[index], identities[target]] = [identities[target], identities[index]];
  }

  const steps = identities.flatMap((identity, index): FixtureStep[] => {
    const offset = index * 50;
    const join: FixtureStep = { identity, offset, eventType: 'QUEUE_JOIN' };
    const reservation = `hold-${identity.id}`;
    const hold: FixtureStep = { identity, offset: offset + 4000, eventType: 'RESERVATION_CREATE', reservation };
    const checkout: FixtureStep = { identity, offset: offset + 9000, eventType: 'CHECKOUT_ATTEMPT', reservation };

    if (identity.malicious && config.fixture === 'queue') {
      return [{ identity, offset: offset + 9000, eventType: 'CHECKOUT_ATTEMPT', withoutGrant: true }];
    }
    if (identity.malicious && config.fixture === 'inventory') {
      return [
        join,
        hold,
        { ...hold, offset: offset + 5000, reservation: `${reservation}-second` },
        { ...hold, eventType: 'RESERVATION_EXPIRE', offset: offset + 4000 + holdTtlMs },
      ];
    }
    if (identity.malicious && config.fixture === 'scalping') {
      return [join, { ...hold, quantity: 2 }, { ...checkout, quantity: 2 }];
    }
    return [join, hold, checkout];
  });
  steps.sort((first, second) => first.offset - second.offset);
  if (steps.length > 500) throw new Error('Replay fixture exceeds the event budget.');
  return { identities, steps };
}

function replay(
  config: ReplayConfig,
  fixture: ReturnType<typeof buildFixture>,
  baseline: BaselineStatsSnapshot,
  behavioralMode: 'observe' | 'enforce'
) {
  const engine = new RiskEngine({ behavioralMode, unsupervisedOptions: { frozenSnapshot: baseline } });
  engine.configureSale(saleId, {
    capacity: config.inventory,
    holdTtlMs,
    maxTicketsPerAccount: 2,
    maxTicketsPerCluster: 4,
    requireQueueGrants: true,
  });
  const sale = engine.getSaleState(saleId);
  const grants = new Map<string, string>();
  const changes = new Map<string, { ticketsCommitted: number; available: number }>();
  let minimumAvailable = config.inventory;
  let unauthorizedCheckouts = 0;

  fixture.steps.forEach(({ identity, eventType, offset, reservation, quantity, withoutGrant }, index) => {
    const eventId = `fixture-${index + 1}`;
    const sessionId = `session-${identity.id}`;
    const timestampMs = start + offset;
    const soldBefore = sale.soldInventory;
    engine.evaluate({
      eventId,
      timestamp: new Date(timestampMs).toISOString(),
      eventIdempotencyKey: eventId,
      eventType,
      accountId: identity.id,
      sessionId,
      eventContext: {
        eventSaleId: saleId,
        deviceId: `device-${identity.link}`,
        paymentTokenHash: `payment-${identity.link}`,
        networkId: identity.sharedNetwork ? 'shared-wifi' : `network-${identity.id}`,
        reservationId: reservation,
        quantity,
        queueGrant: withoutGrant ? null : grants.get(identity.id),
      },
    });
    if (eventType === 'QUEUE_JOIN') {
      grants.set(identity.id, engine.issueQueueGrant({ eventSaleId: saleId, accountId: identity.id, sessionId, issuedAtMs: timestampMs }));
    }
    const ticketsCommitted = sale.soldInventory - soldBefore;
    if (eventType === 'CHECKOUT_ATTEMPT' && withoutGrant && ticketsCommitted > 0) unauthorizedCheckouts += 1;
    changes.set(eventId, { ticketsCommitted, available: sale.availableInventory });
    minimumAvailable = Math.min(minimumAvailable, sale.availableInventory);
  });

  const audit = engine.getAuditLog();
  const malicious = new Set(fixture.identities.filter((identity) => identity.malicious).map((identity) => identity.id));
  const genuineCount = fixture.identities.length - malicious.size;
  const flagged = new Set(audit
    .filter(({ behavioralDecision }) => behavioralDecision === 'CHALLENGE' || behavioralDecision === 'BLOCK')
    .map(({ accountId }) => accountId));
  const maliciousTicketsSold = [...malicious].reduce((sum, id) => sum + (sale.soldByAccount.get(id) ?? 0), 0);
  const entries: Evidence[] = audit.map((record) => ({
    decisionId: record.decisionId,
    eventId: record.eventId,
    eventType: record.eventType,
    accountId: record.accountId,
    malicious: malicious.has(record.accountId),
    decision: record.decision,
    behavioralDecision: record.behavioralDecision ?? 'ALLOW',
    riskScore: record.riskScore,
    mlScore: record.mlScore ?? null,
    unsupervisedAnomalyScore: record.unsupervisedAnomalyScore ?? null,
    mlTopContributors: record.mlTopContributors ?? [],
    hardFailure: record.hardFailure,
    reasons: record.reasons,
    ...changes.get(record.eventId)!,
  }));
  const sampled = new Map<string, Evidence>();
  for (const entry of entries) {
    if (entry.eventType === 'QUEUE_JOIN' && entry.behavioralDecision === 'ALLOW') continue;
    const kind = [
      entry.eventType, entry.malicious, entry.decision, entry.behavioralDecision, entry.reasons.join(','),
    ].join(':');
    if (!sampled.has(kind)) sampled.set(kind, entry);
  }
  const held = [...sale.holds.values()]
    .filter((hold) => hold.status === 'ACTIVE')
    .reduce((total, hold) => total + hold.quantity, 0);

  return {
    maliciousTicketsSold,
    legitimateTicketsSold: sale.soldInventory - maliciousTicketsSold,
    legitimateCompletion: {
      numerator: [...sale.soldByAccount.keys()].filter((id) => !malicious.has(id)).length,
      denominator: genuineCount,
    },
    detectionRecall: { numerator: [...flagged].filter((id) => malicious.has(id)).length, denominator: malicious.size },
    falsePositiveRate: { numerator: [...flagged].filter((id) => !malicious.has(id)).length, denominator: genuineCount },
    unauthorizedCheckouts,
    hardDenials: audit.filter((record) => record.hardFailure).length,
    available: sale.availableInventory,
    sold: sale.soldInventory,
    held,
    releasedHolds: sale.exactOnceReleaseCount,
    minimumAvailable,
    evidence: [...sampled.values()],
  };
}

export function runDefensiveReplay(config: ReplayConfig) {
  const fixture = buildFixture(config);
  const baseline = new UnsupervisedBaselineDetector().getBaselineSnapshot();
  return {
    ok: true,
    config,
    eventCount: fixture.steps.length,
    observe: replay(config, fixture, baseline, 'observe'),
    enforce: replay(config, fixture, baseline, 'enforce'),
  };
}
