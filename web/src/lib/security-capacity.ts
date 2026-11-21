export const capacityInputs = {
  buyers: { label: 'Synthetic buyers', min: 1, max: 100_000, defaultValue: 10_000 },
  waveSize: { label: 'Buyers per wave', min: 1, max: 4_096, defaultValue: 1_024 },
  buyersPerNetwork: { label: 'Buyers per shared network', min: 1, max: 1_024, defaultValue: 64 },
} as const;

export type CapacityConfig = Record<keyof typeof capacityInputs, number>;

export type CapacityReport = CapacityConfig & {
  ok: boolean;
  scope: string;
  runtime: { node: string; platform: string; cpu?: string };
  events: number;
  peakHeld: number;
  sold: number;
  available: number;
  finalHeld: number;
  convertedHolds: number;
  unauthorizedCheckoutAttempts: number;
  unauthorizedCheckouts: number;
  challenged: number;
  blocked: number;
  elapsedMs: number;
  eventsPerSecond: number;
  evaluationLatencyMs: { p50: number; p95: number; p99: number };
  sampledPeakRssBytes: number;
};
