import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { SecurityEvent } from '../src/events.ts';
import { RiskEngine } from '../src/risk-engine.ts';
import { UnsupervisedBaselineDetector } from '../src/unsupervised-baseline.ts';

const saleId = 'capacity-benchmark';
const start = Date.UTC(2026, 0, 1);

function parsePositiveInteger(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return number;
}

export function parseCapacityConfig(options: Record<string, unknown>) {
  return {
    buyers: parsePositiveInteger('buyers', options.buyers, 100_000, 100_000),
    waveSize: parsePositiveInteger('wave-size', options['wave-size'], 1024, 4096),
    buyersPerNetwork: parsePositiveInteger('buyers-per-network', options['buyers-per-network'], 64, 1024),
  };
}

export function runCapacityBenchmark({ buyers, waveSize, buyersPerNetwork }: ReturnType<typeof parseCapacityConfig>) {
  const frozenSnapshot = new UnsupervisedBaselineDetector().getBaselineSnapshot();
  const engine = new RiskEngine({ unsupervisedOptions: { frozenSnapshot } });
  engine.configureSale(saleId, { capacity: buyers, requireQueueGrants: true });
  const sale = engine.getSaleState(saleId);
  const latencies = new Float64Array(buyers * 3);
  let eventCount = 0;
  let peakHeld = 0;
  let sampledPeakRssBytes = process.memoryUsage.rss();

  function evaluate(event: SecurityEvent) {
    const started = performance.now();
    engine.evaluate(event);
    latencies[eventCount++] = performance.now() - started;
  }

  const started = performance.now();
  for (let offset = 0; offset < buyers; offset += waveSize) {
    const now = start + (offset / waveSize) * 12_000;
    const wave = Array.from({ length: Math.min(waveSize, buyers - offset) }, (_, index) => {
      const buyer = offset + index;
      const accountId = `buyer-${buyer}`;
      const sessionId = `session-${buyer}`;
      return {
        accountId,
        sessionId,
        context: {
          eventSaleId: saleId,
          deviceId: `device-${buyer}`,
          paymentTokenHash: `payment-${buyer}`,
          networkId: `shared-network-${Math.floor(buyer / buyersPerNetwork)}`,
          reservationId: `hold-${buyer}`,
        },
      };
    });

    const phases = [
      ['QUEUE_JOIN', 0],
      ['RESERVATION_CREATE', 4000],
      ['CHECKOUT_ATTEMPT', 9000],
    ] as const;
    const grants: string[] = [];
    for (const [eventType, delay] of phases) {
      const timestamp = new Date(now + delay).toISOString();
      for (let index = 0; index < wave.length; index++) {
        const { accountId, sessionId, context } = wave[index];
        const eventId = `${accountId}-${eventType}`;
        evaluate({
          eventId, eventIdempotencyKey: eventId, timestamp, eventType, accountId, sessionId,
          eventContext: { ...context, queueGrant: grants[index] },
        });
        if (eventType === 'QUEUE_JOIN') {
          grants.push(engine.issueQueueGrant({ eventSaleId: saleId, accountId, sessionId, issuedAtMs: now }));
        }
      }
      peakHeld = Math.max(peakHeld, sale.capacity - sale.availableInventory - sale.soldInventory);
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss());
    }
  }

  const elapsedMs = performance.now() - started;
  latencies.sort();
  const stats = engine.getStats();
  let finalHeld = 0;
  let convertedHolds = 0;
  for (const hold of sale.holds.values()) {
    if (hold.status === 'ACTIVE') finalHeld += hold.quantity;
    if (hold.status === 'CONVERTED') convertedHolds += 1;
  }
  return {
    ok: stats.allowCount === eventCount && convertedHolds === buyers && sale.soldInventory === buyers &&
      sale.soldByAccount.size === buyers && sale.availableInventory === 0 && finalHeld === 0 &&
      stats.unauthorizedCheckoutsAllowed === 0 && stats.hardFailureCount === 0,
    scope: 'Single-process in-memory risk engine, one sale, synthetic legitimate buyers, no HTTP or blockchain',
    runtime: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model },
    buyers,
    waveSize,
    buyersPerNetwork,
    events: eventCount,
    peakHeld,
    sold: sale.soldInventory,
    available: sale.availableInventory,
    finalHeld,
    convertedHolds,
    unauthorizedCheckoutAttempts: stats.unauthorizedCheckoutAttempts,
    unauthorizedCheckouts: stats.unauthorizedCheckoutsAllowed,
    challenged: stats.challengeCount,
    blocked: stats.blockCount,
    elapsedMs,
    eventsPerSecond: eventCount * 1000 / elapsedMs,
    evaluationLatencyMs: {
      p50: latencies[Math.ceil(eventCount * 0.5) - 1],
      p95: latencies[Math.ceil(eventCount * 0.95) - 1],
      p99: latencies[Math.ceil(eventCount * 0.99) - 1],
    },
    sampledPeakRssBytes,
  };
}
