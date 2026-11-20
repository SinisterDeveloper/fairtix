# FairTickets Anti-Bot & Risk Engine — IBM Benchmark Report

> **Simulation Mode:** Seeded deterministic workload (80 concert capacity · 130 adversarial accounts + 80 legitimate fans)
> **Generated At:** 2026-11-20T23:02:19.070Z

## 1. IBM Benchmark Targets (Protected Run)

| Test | Target | Observed Result | Status |
|---|---|---|---|
| Queue bypass attempt | 0 unauthorized checkouts | 0 / 20 unauthorized checkouts (Baseline: 20) | PASS |
| Inventory abuse | Every expired hold releases inventory exactly once | 30/30 restored once (30 duplicate release events ignored) | PASS |
| Known linked-account farm | Detect the 50-account seeded cluster | 50/50 farm accounts flagged, 0 tickets acquired | PASS |
| Legitimate shared-network users | No blanket rejection by IP | 0/15 flagged (15/15 tickets acquired) | PASS |
| Concurrent purchases | 0 oversold tickets | 0 oversold (80/80 capacity sold) | PASS |
| Risk decisions | Every action has recorded reasons and supporting events | 847/847 decisions fully audited | PASS |
| Distributed automation | Report prevented malicious allocations and remaining successful attacks | 130 prevented; 0 independent stealth attacks succeeded (Baseline malicious allocations: 80) | PASS |

## 2. Baseline vs. Protected Comparison (Identical Seeded Workload)

| Metric | Baseline (Protections Off) | Protected (Risk Engine On) | Delta |
|---|---:|---:|---:|
| Completed Legitimate Purchases | 0/80 | 80/80 | +80 |
| Malicious Ticket Allocations | 80 | 0 | -80 |
| Unauthorized Queue-Bypass Checkouts | 20 | 0 | -20 |
| Shared-Wi-Fi Fan Disruptions (FPR) | 0/15 | 0/15 | 0 |
| Oversold Tickets | 0 | 0 | 0 |

## 3. Detection Metrics (Ground-Truth Labeled Simulation)

- **Precision:** 100.00% (`TP=130, FP=0`)
- **Recall (All Malicious incl. Independent Stealth Bots):** 100.00% (`FN=0`)
- **Recall (Linkable & Policy-Violating Threats):** 100.00%
- **False-Positive Rate (Legitimate Users):** 0.00%
- **Shared-Wi-Fi False-Positive Rate:** 0.00%

## 4. Per-Cohort Breakdown (Protected Run)

| Cohort | Malicious | Flagged | Challenged | Blocked / Hard Fail | Tickets Acquired |
|---|---:|---:|---:|---:|---:|
| `inventory_hoarder_bot` | Yes | 15/15 | 15 | 15 (15 hard) | 0 |
| `queue_bypass_bot` | Yes | 20/20 | 0 | 20 (20 hard) | 0 |
| `account_farm` | Yes | 50/50 | 5 | 50 (45 hard) | 0 |
| `distributed_linked_bot` | Yes | 30/30 | 5 | 30 (25 hard) | 0 |
| `behavioral_stealth_bot` | Yes | 10/10 | 0 | 10 (0 hard) | 0 |
| `stealth_independent_bot` | Yes | 5/5 | 5 | 0 (0 hard) | 0 |
| `shared_wifi_fan` | No | 0/15 | 0 | 0 (0 hard) | 15 |
| `family_household` | No | 0/2 | 0 | 0 (0 hard) | 2 |
| `solo_fan` | No | 0/63 | 0 | 0 (0 hard) | 63 |

## 5. Known Limitations (Openly Documented)

- Genuinely independent-looking identities without shared device, payment, session, or timing/grant anomalies cannot be linked as one person by the relationship graph.
- Heuristic rule weights and thresholds (0-39 ALLOW, 40-69 CHALLENGE, 70-100 BLOCK) are starting prototype configurations rather than empirically calibrated production probabilities.
- In this controlled simulation, deviceId, networkId, and paymentTokenHash are server/environment-supplied pseudonymous identifiers.

