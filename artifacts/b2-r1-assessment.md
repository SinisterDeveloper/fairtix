# B2 Assessment & R1 Comparison Status

## 1. B2 Verified Evidence Summary

| Deliverable | Status | Verified Result |
|---|---|---|
| Contract & ABI (`contracts/FairTickets.sol`) | Verified | Compiled with Solidity `0.8.30`, OpenZeppelin `5.4.0`, `shanghai` EVM, `30M` gas limit |
| Seven-benchmark suite (`src/benchmarks.cjs`) | **7/7 PASS** | All 7 benchmarks pass on local Anvil `1.7.1`, including 1,000-tx checkout burst (`100` sales, `900` rejections, `100` reconciled owners), 100-scan admission burst (`1` admitted, `99` denied), and kernel-mutex `SIGKILL` + multi-process crash/recovery tests |
| 60-second CLI demo (`src/demo.cjs`) | **PASS** | Completed in **23.24 s** (`passed: true`), covering deploy, entry, draw, claim, over-cap rejection (`250,000 > 200,000`), capped resale (`180,000`), stale-credential rejection (`v1`), buyer admission (`v2`), withdrawals, and `balanceWei: "0"` |
| 100,000-write `FairTickets` workload (`src/volume-fairtickets.cjs`) | **PASS** | Mined **100,000** distinct status-1 contract writes (`99,650` `enter` + `100` `claim` + `100` `list` + `50` `buy` + `100` `redeem`) across blocks `2..1010` in **873.05 s** (**114.54 writes/s**), reconciled all 100 final owners, proceeds (`20,000,000` organiser, `180,000` each reseller, `29,000,000` contract balance), and preserved a full `slot 1` `enter -> claim -> list -> buy -> redeem` journey; manifest SHA-256: `8673c7d9dcb4717744535809602a9a46d37687605c91886ecc0f969a4f0e2925` |

## 2. B2 Rubric Evidence (Agreed Weights)

Per `B2-DESIGN.md` and `B2-PROBLEM-STATEMENT.md` (0–5 per criterion, weighted to 100; 0 = no evidence, 3 = partial evidence, 5 = independently tested):

| Criterion | Weight | B2 Evidence Basis |
|---|---|---|
| Technical validation | 30 | 7/7 deterministic Anvil benchmarks + 100,000-write `FairTickets` acceptance run + receipt/state reconciliation |
| Differentiation | 20 | Contract-enforced one-subject/one-ticket invariant, price-capped resale, pull payouts, and independent gate verification |
| MVP progress | 20 | Immutable contract, CLI driver (`src/cli.cjs`) with kernel-scoped wallet mutex & crash recovery, demo, and volume harness |
| Remaining feasibility | 20 | 100k writes/20h target exceeded at 114.54 writes/s on local Anvil; pilot UI, real KYC integration, and public-chain deployment remain |
| Demo impact | 10 | Automated 23.24s CLI demo with verified on-chain receipts, rejected over-cap attempt, stale-credential rejection, and zero balance reconciliation |

## 3. Open External Dependencies (Cannot Be Completed Offline)

1. **Real-world identity verification:** `FairTickets` enforces one entry per EIP-712-attested opaque `subject` and wallet on-chain, using synthetic subjects in local fixtures. Preventing one human from obtaining multiple attestations in production requires an external KYC/identity provider (e.g., Aadhaar/DigiLocker) and live credentials, which are outside the local Anvil prototype scope (`B2-DESIGN.md`).
2. **R1 (*Vibe-coded and vulnerable*) comparison:** R1's repository, predefined test results, and 60-second demo are not present in this workspace. Head-to-head scoring (including the 70-point / 10-point lead rule and dependency/evidence tiebreaker) is blocked until R1's artifacts are supplied.
