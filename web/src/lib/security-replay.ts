export const replayFixtures = {
  scalping: 'Coordinated scalping (OAT-005)',
  inventory: 'Inventory holds (OAT-021)',
  queue: 'Queue authorization (OAT-006)',
} as const;

export const replayProfiles = {
  mixed: 'Mixed linked and independent identities',
  linked: 'Linked identities',
  independent: 'Independent identities',
} as const;

export type ReplayConfig = {
  fixture: keyof typeof replayFixtures;
  seed: number;
  participants: number;
  inventory: number;
  profile: keyof typeof replayProfiles;
};

export const replayDefaults: ReplayConfig = {
  fixture: 'scalping',
  seed: 1,
  participants: 50,
  inventory: 100,
  profile: 'mixed',
};

export const replayRanges = {
  seed: { min: 0, max: 4_294_967_295 },
  participants: { min: 4, max: 50 },
  inventory: { min: 1, max: 100 },
} as const;

export type ReplayRate = { numerator: number; denominator: number };

type ReplayDecision = 'ALLOW' | 'CHALLENGE' | 'BLOCK';

export type ReplayEvidence = {
  decisionId: string;
  eventId: string;
  eventType: string;
  accountId: string;
  malicious: boolean;
  decision: ReplayDecision;
  behavioralDecision: ReplayDecision;
  hardFailure: boolean;
  riskScore: number;
  mlScore: number | null;
  unsupervisedAnomalyScore: number | null;
  mlTopContributors: Array<{ feature: string; value: number; contribution: number }>;
  reasons: string[];
  ticketsCommitted: number;
  available: number;
};

export type ReplayRun = {
  maliciousTicketsSold: number;
  legitimateTicketsSold: number;
  legitimateCompletion: ReplayRate;
  detectionRecall: ReplayRate;
  falsePositiveRate: ReplayRate;
  unauthorizedCheckouts: number;
  hardDenials: number;
  available: number;
  sold: number;
  held: number;
  releasedHolds: number;
  minimumAvailable: number;
  evidence: ReplayEvidence[];
};

export type ReplayResponse = {
  ok: true;
  config: ReplayConfig;
  eventCount: number;
  observe: ReplayRun;
  enforce: ReplayRun;
};
