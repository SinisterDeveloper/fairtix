# FairTickets — Godspeed Parallel Execution Plan & Full Contracts (`TASKS.md`)

> **Workflow:** Tight **4-loop vertical slices**. Every loop ends with a **working, demoable end-to-end app** — ugly at first, then progressively safer, clearer, and judge-ready.
> **Round 1 Mentor Checkpoint:** ~Hour 5 (end of Loop 2).

---

## 1. Existing Repo Reality (What Already Works Today)

`src/cli.cjs` **already exists** and already outputs JSON for:
- `deploy`, `status`, `attest`, `enter`, `lock-draw`, `draw`, `claim`, `list`, `buy`, `sign-gate`, `redeem`, `resume`, `withdraw`, `ticket`, `advance-time`, `mine`.
- `src/cli.cjs` already includes kernel-scoped `withWalletLock`, per-wallet tx journaling, and atomic `claimGateScanAtomic` / `tryFinalizeGateDecision`.

**What Dev 1 adds on top of `src/cli.cjs`:**
1. `artifacts/demo-fixture.json` (fixed roles, keys, event params) + `artifacts/demo-state.json` (persisted contract address & `editionId`).
2. `init-demo` / `reset-demo` + `--role <role>` + `--json` envelope normalization (`txStatus`, `errorCode`, `reason`).
3. `snapshot` (or extended `status --json`) returning all tickets, winners, listings, role balances, and withdrawable credits in one call.
4. `activity-log.ndjson` + `alerts` command (Loop 3).

---

## 2. Shared TypeScript & JSON Contracts (Freeze at Hour 1)

Dev 2 should copy these exact types into `web/src/lib/types.ts`.

```ts
export type RoleId = 'organiser' | 'gate' | 'attester' | 'fanA' | 'fanB';

export type TxStatus = 'pending' | 'confirmed' | 'rejected' | 'unknown_recovering';

export type EventPhase =
  | 'ENTRY_OPEN'
  | 'DRAW_LOCKED'
  | 'DRAWN'
  | 'CLAIM_OPEN'
  | 'RESALE_OPEN'
  | 'GATE_OPEN'
  | 'CLOSED'
  | string;

export interface TicketState {
  slot: number;               // 0-indexed contract slot
  owner: string;              // 0x... address (0x000... if unclaimed)
  version: number;            // increments on every resale; invalidates old credentials
  paidPriceWei: string;
  admitted: boolean;
  listed: boolean;
  resalePriceWei: string;     // "0" if not listed
}

export interface GateCredential {
  contract: string;
  editionId: string;
  slot: number;
  version: number;
  expiry: number;             // unix seconds
  ownerSig: string;           // 0x... EIP-712 / signed gate credential
  label?: string;             // UI-only e.g. "Fan A (v1 - pre-sale)"
}

export interface RoleAccountView {
  role: RoleId;
  label: string;              // e.g. "Fan A", "Fan B", "Organiser", "Gate"
  address: string;
  ethBalanceWei: string;
  withdrawableWei: string;
}

export interface DemoStatusResponse {
  ok: true;
  chainId: number;            // 31337
  rpcUrl: string;             // http://127.0.0.1:8545
  contract: string;           // 0x...
  codeHash: string;           // keccak256 of deployed runtime bytecode
  editionId: string;          // bytes32 hex
  phase: EventPhase;
  drawLocked: boolean;
  drawn: boolean;
  capacity: number;
  facePriceWei: string;
  maxResalePriceWei: string;  // e.g. 110% of facePriceWei
  entrantsCount: number;
  winnersCount: number;
  issuedCount: number;
  admittedCount: number;
  claimDeadline: number;
  resaleCutoff: number;
  gateClose: number;
  contractBalanceWei: string;
  winners: string[];          // 0x... addresses
  tickets: TicketState[];
  roles: Record<RoleId, RoleAccountView>;
  volumeEvidence?: {
    totalWrites: number;      // 100000
    writesPerSecond: number;
    manifestSha256: string;
  };
}

export interface ApiMutationResponse {
  ok: boolean;
  txStatus: TxStatus;
  txHash: string | null;
  scanId?: string | null;
  blockNumber?: number | null;
  gateDecision?: 'ADMIT' | 'REJECT' | 'ABORTED_BEFORE_SEND' | 'ALREADY_FINALIZED' | null;
  errorCode?:
    | 'RESALE_CAP_EXCEEDED'
    | 'STALE_CREDENTIAL'
    | 'ALREADY_ADMITTED'
    | 'FORGED_CREDENTIAL'
    | 'NOT_WINNER'
    | 'ALREADY_CLAIMED'
    | 'WRONG_PHASE'
    | 'LISTING_NOT_ACTIVE'
    | 'INSUFFICIENT_PAYMENT'
    | 'RPC_TIMEOUT'
    | 'INTERNAL_ERROR'
    | null;
  error: string | null;       // Human-readable message for UI
  ticket?: TicketState | null;
  credential?: GateCredential | null; // Returned by /api/credential/sign
}

export interface AlertItem {
  id: string;
  severity: 'review';         // Never auto-blocks
  rule: 'REPEATED_ENTRY_SUBJECT' | 'REPEATED_FAILED_SCAN' | 'REQUEST_BURST';
  count: number;
  reason: string;
  subjectOrSlot: string;
  timestamp: string;          // ISO-8601
  note: string;               // "Review signal only; does not auto-block"
}
```

---

## 3. Exact Next.js API Route Contracts (`web/src/app/api/...`)

All routes run server-side in Next.js App Router (`export const runtime = 'nodejs'`).
**Rule:** Never import `ethers` or hold private keys in React client components. Client passes `role: 'fanA' | 'fanB' | 'organiser' | 'gate'`; Next.js invokes `cli-bridge.ts` → `node ../src/cli.cjs ... --json`.

| Route | Method | Request JSON Body | CLI Command Invoked | Response |
|---|---|---|---|---|
| `/api/status` | `GET` | — | `cli.cjs status --json` | `200` `DemoStatusResponse` |
| `/api/enter` | `POST` | `{ role: 'fanA'\|'fanB', subject: string }` | `cli.cjs enter --role <role> --subject <subject> --json` (auto-attests via `attester` demo key in `cli.cjs` or chains `attest` + `enter`) | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/organiser/advance-and-lock` | `POST` | `{ seconds?: number }` | `cli.cjs advance-time` + `cli.cjs lock-draw --role organiser --json` | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/organiser/draw` | `POST` | `{}` | `cli.cjs mine --blocks 2` + `cli.cjs draw --role organiser --json` | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/claim` | `POST` | `{ role: 'fanA'\|'fanB' }` | `cli.cjs claim --role <role> --json` | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/list` | `POST` | `{ role: 'fanA'\|'fanB', slot: number, version: number, priceWei: string }` | `cli.cjs list --role <role> --slot <slot> --version <v> --price <wei> --json` | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/buy` | `POST` | `{ role: 'fanA'\|'fanB', slot: number, version: number, priceWei: string }` | `cli.cjs buy --role <role> --slot <slot> --version <v> --price <wei> --json` | `200`/`202`/`409` `ApiMutationResponse` |
| `/api/credential/sign` | `POST` | `{ role: 'fanA'\|'fanB', slot: number, expirySeconds?: number }` | `cli.cjs sign-gate --role <role> --slot <slot> --json` | `200` `ApiMutationResponse` (with `credential`) |
| `/api/gate/redeem` | `POST` | `{ scanId?: string, credential: GateCredential }` | `cli.cjs redeem --role gate --scan-id <id> --slot <slot> --version <v> --expiry <exp> --owner-sig <sig> --json` | `200` (`ADMIT`) / `409` (`REJECT`) / `202` (`unknown_recovering`) |
| `/api/withdraw` | `POST` | `{ role: 'fanA'\|'fanB'\|'organiser' }` | `cli.cjs withdraw --role <role> --json` | `200`/`202`/`400` `ApiMutationResponse` |
| `/api/tx/resume` | `POST` | `{ role?: RoleId, scanId?: string, txHash?: string }` | `cli.cjs resume --role <role> --scan-id <id> --json` | `200`/`202` `ApiMutationResponse` |
| `/api/organiser/alerts` | `GET` | — | `cli.cjs alerts --json` | `200` `{ ok: true, alerts: AlertItem[] }` |

### HTTP Status Mapping (Mandatory in `cli-bridge.ts`)
- **`200 OK`**: `txStatus === 'confirmed'` (on-chain receipt `status === '0x1'`) or `gateDecision === 'ADMIT'`.
- **`202 Accepted`**: `txStatus === 'pending'` or `txStatus === 'unknown_recovering'` (child process timed out, RPC dropped, or receipt still pending — **UI must show "Pending / Recovering" with a Resume button, NEVER "Failed"**).
- **`400 / 409 / 422`**: `txStatus === 'rejected'` (contract revert, cap exceeded, stale credential, duplicate scan, wrong phase).

---

## 4. Next.js Directory & Component Spec (Dev 2 Blueprint)

```text
web/
├── package.json
├── next.config.ts              # serverExternalPackages if needed; zero client secrets
└── src/
    ├── lib/
    │   ├── types.ts            # Exact TypeScript interfaces from Section 2
    │   ├── cli-bridge.ts       # spawn('node', ['../src/cli.cjs', ...args], { cwd: repoRoot, timeout: 15000 })
    │   └── format.ts           # wei <-> ETH formatting, shortAddress(0x1234...abcd)
    ├── components/
    │   ├── RoleSwitcher.tsx    # Active role selector (Fan A / Fan B / Organiser / Gate) + demo-key banner
    │   ├── TxStatusBanner.tsx  # Renders pending / confirmed / rejected / unknown_recovering + Resume button
    │   └── CredentialCard.tsx  # Displays signed GateCredential JSON + "Save for Stale Test" button
    └── app/
        ├── layout.tsx          # Top nav: /fan | /gate | /organiser + RoleSwitcher + Chain status pill
        ├── page.tsx            # Redirects or links to /fan, /gate, /organiser + quick demo guide
        ├── fan/page.tsx        # Enter event, see draw result, claim ticket, list/buy resale, sign credential, withdraw
        ├── gate/page.tsx       # Paste/select credential, generate/override scanId, Redeem -> ADMIT/REJECT/RECOVERING
        ├── organiser/page.tsx  # Phase controls, contract balance/credits table, codeHash + 100k evidence, Alerts panel
        └── api/...             # Route handlers from Section 3
```

### Key UX Rules for Dev 2
1. **Source of truth:** Poll `GET /api/status` every `3s` (and immediately after any mutation). Never compute ticket ownership, resale eligibility, or admission locally in React state.
2. **Stale credential demo flow:** When Fan A signs a credential (`v1`) in `/fan`, allow clicking **"Save Credential to Demo Tray"** (stored in `localStorage` / React state). After Fan B buys the ticket (`v2`), `/gate` lets the presenter pick **"Fan A's Old Credential (v1)"** vs **"Fan B's Current Credential (v2)"** in one click!
3. **Resale cap helper:** In `/fan`, show `Max allowed resale price: <maxResalePriceWei in ETH>` right under the price input, and allow submitting a higher price so the presenter can demonstrate the **on-chain cap rejection** live.
4. **Honest demo banner:** Persistent subtle banner: *"Hackathon Demo Mode: Roles use separated local Anvil keys (`artifacts/demo-fixture.json`). In production, fans sign from their own wallets."*

---

## 5. Parallel Looped Execution Plan

### Loop 1 (Hours 0–2.5): Bare-Minimum E2E Slice ("Ugly but Working")
> **Exit State:** Ugly UI where `enter → draw → claim → list → buy → redeem` works end-to-end on Anvil. Working demo exists at Hour 2.5.

- **Dev 1 (Core / Blockchain):**
  - [x] **L1-D1-1:** `init-demo` generates local Anvil role wallets (`organiser`, `gate`, `attester`, `fanA`, `fanB`) and writes them to ignored `artifacts/demo-fixture.json` (never committed).
  - [x] **L1-D1-2:** `init-demo` deploys `FairTickets` and writes address, edition, code hash, chain ID, and RPC URL to ignored `artifacts/demo-state.json` (plus `reset-demo` for explicit practice resets).
  - [x] **L1-D1-3:** Added `--role <role>`, automatic `demo-state.json` loading, and `--json` normalized responses across lifecycle commands (`enter` auto-attests, `lock-draw`, `draw`, `claim`, `list`, `buy`, `sign-gate`, `redeem`, `withdraw`, `resume`, `advance-time`, `mine`).
  - [x] **L1-D1-4:** Extended `status --json` to report `tickets[]`, `winners[]`, `facePriceWei`, `maxResalePriceWei`, `roles` (balances + `proceeds`), and `volumeEvidence`.

- **Dev 2 (Next.js Backend & Frontend):**
- [x] **L1-D2-1:** Added a Next.js App Router scaffold and shared TypeScript types.
- [x] **L1-D2-2:** Added a server-side CLI bridge with a 15-second timeout and `unknown_recovering` response.
- [x] **L1-D2-3:** Added the status, lifecycle, credential, gate, withdrawal, resume, and alerts API routes.
- [x] **L1-D2-4:** Added fan, gate, and organiser pages connected to the API and local chain state.

**Loop 1 Sync (Hour 2.5):** Click through `enter → lock/draw → claim → list → buy → sign → redeem` on local Anvil.

---

### Loop 2 (Hours 2.5–5.0): Mentor Round 1 Ready ("Safe, Clear & Complete Core")
> **Exit State (Hour 5 Mentor Checkpoint):** Clean, demo-ready UI proving contract enforcement: role separation, resale cap failure, stale-credential rejection, duplicate scan rejection, honest tx states, and restart-safe chain state.

- **Dev 1 (Core / Blockchain):**
  - [x] **L2-D1-1:** Added explicit `reset-demo`; `init-demo` refuses an existing state (and clears activity log on reset), `status` validates bytecode & is strictly read-only, and demo state persists across fresh process spawns (verified in `src/verify-loop2.cjs`).
  - [x] **L2-D1-2:** Hardened normalized JSON transaction states, ABI revert reason decoding, strict error-code classification, UUID `scanId` normalization, honest `pending`/`unknown_recovering` handling, and mempool timeout recovery via `resume` (verified in `src/verify-loop2.cjs`).
  - [x] **L2-D1-3:** Verified via CLI (`src/verify-loop2.cjs` — 127 checks, `src/verify-loop1.cjs`, `src/demo.cjs`, and `src/benchmarks.cjs` 7/7): above-cap `list` fails (`RESALE_CAP_EXCEEDED`), seller `v1` credential rejected after `buy` (`STALE_CREDENTIAL`), forged/expired/wrong-phase credentials rejected, and duplicate/concurrent `redeem` calls admit at most once (`ALREADY_ADMITTED`).

- **Dev 2 (Next.js Backend & Frontend):**
- [x] **L2-D2-1:** Added a shared role switcher, address badge, and demo-key disclosure in the app layout.
- [x] **L2-D2-2:** Added transaction state banners and a resume action for pending/recovering gate operations.
- [x] **L2-D2-3:** Added a persistent local credential tray so old and current credentials can be selected at the gate.

**Loop 2 Sync (Hour 5 — Mentor Feedback Round):** Live 2-minute demo of full lifecycle + cap rejection + stale credential rejection + duplicate scan rejection.

---

### Loop 3 (Hours 5.0–9.0): Recovery, Evidence & Detection ("Judge-Grade")
> **Exit State:** Resilient to disconnects/restarts, full financial/hash evidence dashboard, and deterministic review-only alerts live.

- **Dev 1 (Core / Blockchain):**
- [ ] **L3-D1-1:** Resume and withdrawal now return normalized JSON states; status exposes contract balance and per-role credits. A live chain reconciliation remains to be recorded.
- [x] **L3-D1-2:** Added an append-only activity log and review-only repeated-entry, failed-scan, and request-burst alerts.
- [x] **L3-D1-3:** Status includes volume summary evidence when present.

- **Dev 2 (Next.js Backend & Frontend):**
- [x] **L3-D2-1:** Added resume, withdrawal, and alerts endpoints; banners offer **Check / Resume** for uncertain gate operations.
- [x] **L3-D2-2:** Added contract/hash, balances/credits, volume evidence, and a review-only alerts panel to `/organiser`.
  - [ ] **L3-D2-3:** Apply any Hour 5 mentor feedback on UX clarity and error messaging.

**Loop 3 Sync (Hour 9):** Feature-complete demo; decide whether detection panel is stable for final judging.

---

### Loop 4 (Hours 9.0–15.0): Adversarial Verification, Freeze & Rehearsal
> **Exit State:** All 7 must-pass tests verified through the real UI/API + chain, frozen at Hour 11, clean rehearsal + backup ready.

- **Dev 1 (Core / Blockchain):**
  - [ ] **L4-D1-1 (9–11h):** Run UI/API + Anvil adversarial tests: 2× concurrent `buy`, 2× concurrent `redeem`, simulated timeout + `/api/tx/resume`, Next.js restart without losing `demo-state.json`.
  - [ ] **L4-D1-2 (11–13h):** Freeze `FairTickets.sol`, ABI, `demo-fixture.json`, and `cli.cjs`; add `scripts/start-demo.ps1` (starts Anvil + Next.js cleanly) and document limitations.
  - [ ] **L4-D1-3 (13–15h):** Rehearse pitch + on-chain hash/balance verification; record backup video.

- **Dev 2 (Next.js Backend & Frontend):**
  - [ ] **L4-D2-1 (9–11h):** Test clean-start boot, browser refresh/Next.js restart persistence, and disconnect/resume recovery in UI; fix integration bugs.
  - [ ] **L4-D2-2 (11–13h):** Freeze UI/API features at Hour 11; polish presentation-critical defects only.
  - [ ] **L4-D2-3 (13–15h):** Rehearse Fan A, Fan B, Organiser, and Gate demo click-path without resetting the judging chain.

---

## 6. Must-Pass Gate Before Freeze (Hour 11)
- [ ] **Primary journey:** Entry, draw, claim, and visible owner match on-chain state.
- [ ] **Resale:** Above-cap listing fails with `RESALE_CAP_EXCEEDED`; valid purchase updates owner & increments `version`.
- [ ] **Gate:** Forged or stale (`v1`) credential fails; buyer's current (`v2`) credential admits once; repeat scan fails.
- [ ] **Concurrency:** Two simultaneous `buy` calls → 1 owner; two simultaneous `redeem` calls → 1 admission.
- [ ] **Recovery:** Timeout/interrupt returns HTTP `202` (`unknown_recovering`) and resolves via `/api/tx/resume` without double-sale or double-admission.
- [ ] **Money & evidence:** Contract balance + withdrawal credits reconcile cleanly; UI never shows `confirmed` before `status === '0x1'` receipt.
- [ ] **Restart:** Restarting Next.js preserves contract address, `editionId`, and judging chain state.

## 7. Live Judge Demo Scope

Follow the [three-minute judge runbook](B2-JUDGE-DEMO.md). The required path is a live bot-detection exercise on a split screen, followed by one ticket’s draw, claim, controlled resale, and admission. Use a prepared live edition if a phase stalls. The optional tasks come after the required path passes rehearsal.

### Dev 1 (Core / Blockchain)

- [ ] **D1-DEMO-1 — Fixture and live entry proof.** Prepare a fixed local fixture with a labeled repeated-entry participant, a distinct legitimate control, and an eligible resale buyer who holds no ticket. Provide a bounded scenario through the CLI that runs against the actual demo backend. Verify that repeated attempts trigger the existing review signal, add zero extra eligible entries, and leave the legitimate control eligible. Provide a live terminal invocation for rehearsal and as a fallback if the Attacker Console is unavailable.
- [ ] **D1-DEMO-2 — Evidence contract for Web.** Agree with Dev 2 on the scenario names, result fields, and demo phase controls before wiring the UI. Expose additive optional JSON fields as needed for per-attempt decisions and reasons, related alert evidence, and before/after eligible and inventory counts. Use a run or attempt ID where supported, and expose the actual subject or event grouping for aggregate alerts. Keep review signals distinct from enforcement decisions.
- [ ] **D1-DEMO-3 — Transfer and gate evidence.** Verify the featured slot’s above-cap rejection, permitted sale, owner/version change, stale seller credential, accepted buyer credential, and rejected repeat scan. Provide a demo credential whose time window lets the gate show the stale-version reason, and prepare an unused slot for live concurrency Q&A. Verify that two independent scans produce one confirmed admission.
- [ ] **D1-DEMO-4 — Live setup and recovery.** Rehearse phase timing on the local judging chain, including draw readiness, resale opening, and credential expiry. Prepare an isolated backup edition at the resale or gate phase. Confirm the event contract, slot, and receipts can be shown on request. Run the Core verification checks required by `AGENTS.md` before commit or push.
- [ ] **D1-DEMO-5 — Optional detection comparison.** Validate a labeled shared-Wi-Fi control and any additional linked-account or automation fixture before including them in the pitch. If a baseline is ready, compare isolated runs with the same inputs and seed. Report who was flagged, who stayed eligible, and who received tickets, and identify the specific enforcement rule that differs.

### Dev 2 (Next.js Backend & Frontend)

- [ ] **D2-DEMO-1 — Attacker Console at `/attack`.** Build a **Launch Attack** action for the agreed local fixture. Call the CLI through the server-side bridge and render actual per-attempt results, reasons, and the legitimate control. Show the run in progress and guard against duplicate launches while it is active.
- [ ] **D2-DEMO-2 — Security Command Center at `/organiser`.** Put phase, capacity, eligible entries, allocations, and claims in the first view. Refresh the real activity feed and highlight the corresponding review alert or decision while the Attacker Console is visible beside it. Label grouped alerts and pending outcomes accurately. Keep contract and receipt details accessible during judge questions.
- [ ] **D2-DEMO-3 — Fan and resale handoff.** In `/fan`, surface verified entry, draw outcome, confirmed claim, and the featured slot. Give controlled resale a focused view there or at `/resale` using the existing API. Show the configured cap, allow submission of the above-cap price for backend validation, and show the permitted purchase with current owner and version. Keep the seller’s version 1 credential selectable after switching roles.
- [ ] **D2-DEMO-4 — Gate proof at `/gate`.** Make the saved seller and buyer credentials easy to identify and select. Present distinct results for stale credential, confirmed admission, already used, and recovering. Verify that scanning again creates a separate scan operation, and that recovery checks the original operation. Keep paste-to-scan as the live path.
- [ ] **D2-DEMO-5 — Live presenter workflow.** Check the side-by-side layout at presentation zoom and pre-open the Fan, Resale, and Gate tabs. Rehearse keeping the event and slot visible through role switches and showing the final counts. Run `npm --prefix web run build` before commit or push.
- [ ] **D2-DEMO-6 — Optional comparison view.** If Core supplies verified comparison results, show the isolated runs side by side with denominators for review, eligibility, and tickets allocated by group. Label the runs as simulations.

**Integration order.** Agree on the output sample and fixture roles first (`D1-DEMO-2`). Build the Attacker Console and Command Center against that contract in parallel with the Core fixture. Then rehearse the ticket journey with the real CLI, API, and chain. The live checkpoint passes when the team can launch the scenario, connect the response to the organiser evidence, show the control remain eligible, and carry one slot through claim, capped transfer, and one admission followed by rejected reuse in three minutes.
