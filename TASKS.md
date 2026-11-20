# FairTickets — Looped Vertical-Slice Plan (`TASKS.md`)

> **Strategy:** Instead of building big horizontal layers, both devs work in **tight parallel loops**. Every loop ends with a **working, demoable end-to-end app** — ugly at first, then progressively safer, clearer, and judge-ready.
> **Round 1 Mentor Checkpoint:** ~Hour 5 (end of Loop 2).

---

## 1. Aligned Integration Contract (Frozen Baseline)

- **Stack & Boundary:** Next.js (App Router API routes + React UI) spawning `node src/cli.cjs <command> --json` (preserves kernel-scoped `withWalletLock`, per-wallet tx journal, atomic gate finalization, and `resume`).
- **Signing & Identities:** Role-separated local demo wallets (`organiser`, `gate`, `attester`, `fanA`, `fanB`) in `artifacts/demo-fixture.json`, selected via an explicit UI **Role Switcher** with a visible signer-disclosure banner.
- **Chain Persistence:** Standalone Anvil (`1.7.1`, chain ID `31337`). Contract & event state persisted in `artifacts/demo-state.json`. Restarting Next.js never redeploys or resets the chain; practice resets happen only via `node src/cli.cjs reset-demo`.
- **Standard Mutating API Response (`/api/*`):**
  ```json
  {
    "ok": true,
    "txStatus": "pending | confirmed | rejected | unknown_recovering",
    "txHash": "0x...",
    "scanId": "optional-gate-scan-id",
    "blockNumber": 12,
    "error": null,
    "ticket": {
      "ticketId": 1,
      "owner": "0x...",
      "version": 2,
      "listed": false,
      "resalePriceWei": "0",
      "redeemed": false
    }
  }
  ```
  - HTTP `200`: `confirmed` | HTTP `202`: `pending` or `unknown_recovering` (never shown as confirmed failure) | HTTP `400/409/422`: `rejected`.

---

## 2. Iterative Parallel Loops

### Loop 1 (Hours 0–2.5): Bare-Minimum E2E Slice ("Ugly but Working")
> **Loop 1 Exit State:** Ugly single/simple UI where `enter → draw → claim → list → buy → redeem` runs end-to-end against real Anvil + `FairTickets.sol`. You already have a working demo at Hour 2.5.

| Dev 1 (Core / Blockchain) | Dev 2 (Next.js API / UI) |
|---|---|
| **L1-D1-1:** Verify 100k artifacts (`artifacts/volume-summary.json`, `volume-manifest.ndjson.gz`) & create `artifacts/demo-fixture.json` (roles, keys, event params). | **L1-D2-1:** Scaffold Next.js App Router app (`web/`) + `src/lib/cli-bridge.ts` helper to spawn `node ../src/cli.cjs ... --json`. |
| **L1-D1-2:** Add `init-demo --json` and `status --json` to `src/cli.cjs` (deploys `FairTickets`, writes `artifacts/demo-state.json`). | **L1-D2-2:** Add `GET /api/status` + minimal API routes (`POST /api/enter`, `draw`, `claim`, `list`, `buy`, `credential/sign`, `gate/redeem`). |
| **L1-D1-3:** Expose happy-path `--json` commands in `src/cli.cjs`: `enter`, `advance-time`, `lock-draw`, `draw`, `claim`, `list`, `buy`, `sign-credential`, `redeem`. | **L1-D2-3:** Build barebones UI buttons/forms on one page (or `/fan`, `/gate`, `/organiser`) wired to those routes showing raw JSON/txHash + current ticket owner & version. |

**Loop 1 Sync (Hour 2.5):** Run full happy path once through the browser UI on Anvil.

---

### Loop 2 (Hours 2.5–5.0): Mentor Round 1 Ready ("Safe, Clear & Complete Core")
> **Loop 2 Exit State (Hour 5 Mentor Checkpoint):** Clean, understandable demo proving blockchain rules cannot be bypassed: role separation, resale cap rejection, stale-credential rejection, honest tx states (`pending` / `confirmed` / `rejected` / `unknown_recovering`), and restart-safe state.

| Dev 1 (Core / Blockchain) | Dev 2 (Next.js API / UI) |
|---|---|
| **L2-D1-1:** Add `reset-demo --json` (explicit practice reset) and ensure `init-demo` / `status` reads `artifacts/demo-state.json` safely across restarts. | **L2-D2-1:** Add explicit **Role Switcher** (`Fan A`, `Fan B`, `Organiser`, `Gate`) with active wallet address badge and demo-key disclosure banner. |
| **L2-D1-2:** Ensure `cli.cjs` returns structured `rejected` reasons (cap exceeded, stale version, already redeemed, not winner) and `unknown_recovering` (never false-fail on timeout). | **L2-D2-2:** Add `<TxStatusBanner />` (`pending`, `confirmed`, `rejected`, `unknown_recovering`) and split into clean `/fan`, `/gate`, and `/organiser` views. |
| **L2-D1-3:** Test seller old-credential rejection after `buy`, duplicate `redeem` scan rejection, and above-cap `list` failure via CLI. | **L2-D2-3:** In `/fan` & `/gate`, allow saving Fan A's pre-sale credential so you can demonstrate **stale credential → REJECT** and **buyer credential → ADMIT** live for mentors. |

**Loop 2 Sync (Hour 5 — Mentor Feedback Round):** Demo the full journey + cap failure + stale credential rejection + duplicate scan rejection live.

---

### Loop 3 (Hours 5.0–9.0): Recovery, Evidence & Detection ("Judge-Grade")
> **Loop 3 Exit State:** Resilient against disconnects/restarts, full financial/hash evidence visible, and deterministic review-only suspicious activity alerts live.

| Dev 1 (Core / Blockchain) | Dev 2 (Next.js API / UI) |
|---|---|
| **L3-D1-1:** Expose `resume --tx-hash / --scan-id --json` and `withdraw --role --json` in `src/cli.cjs`; verify balance/credit reconciliation. | **L3-D2-1:** Add `GET /api/tx/status`, `POST /api/tx/resume`, and `POST /api/withdraw`; wire "Check / Resume Transaction" button on `unknown_recovering` states. |
| **L3-D1-2:** Add append-only `artifacts/activity-log.ndjson` + `alerts --json` (repeated `subjectHash` entries, repeated failed/stale gate scans, request bursts; marked review-only). | **L3-D2-2:** Add `GET /api/organiser/alerts` and build `/organiser` Evidence & Detection dashboard (runtime bytecode hash, contract balance/credits table, 100k workload summary, and Suspicious Activity Review Panel). |
| **L3-D1-3:** Incorporate any Hour 5 mentor feedback affecting core/API contracts. | **L3-D2-3:** Incorporate any Hour 5 mentor feedback on UX clarity, loading states, and error messages. |

**Loop 3 Sync (Hour 9):** Feature-complete demo; confirm detection panel is stable to keep.

---

### Loop 4 (Hours 9.0–15.0): Adversarial Checks, Freeze & Rehearsal
> **Loop 4 Exit State:** All 7 must-pass tests verified through the real UI/API + chain, code frozen at Hour 11, clean rehearsal + backup ready.

| Dev 1 (Core / Blockchain) | Dev 2 (Next.js API / UI) |
|---|---|
| **L4-D1-1 (9–11h):** Run concurrency & crash tests through Next.js API + Anvil (2× simultaneous `buy`, 2× simultaneous `redeem`, simulated timeout + `/api/tx/resume`, Next.js restart persistence). | **L4-D2-1 (9–11h):** Test clean-start boot, disconnect/reconnect recovery in UI, and fix any UI/API integration bugs. |
| **L4-D1-2 (11–13h):** Freeze `FairTickets.sol`, ABI, `demo-fixture.json`, and `cli.cjs`; create `scripts/start-chain.ps1` and document known limitations. | **L4-D2-2 (11–13h):** Freeze UI/API features; polish presentation-critical defects only. |
| **L4-D1-3 (13–15h):** Rehearse pitch + on-chain/hash verification; capture recorded backup run. | **L4-D2-3 (13–15h):** Rehearse Fan A, Fan B, Organiser, and Gate demo flow end-to-end without resetting the judging chain. |

---

## 3. Must-Pass Gate Before Freeze (Hour 11)
- [ ] **Primary journey:** Entry, draw, claim, and visible owner match on-chain state.
- [ ] **Resale:** Above-cap listing fails; valid purchase updates owner & increments `version`.
- [ ] **Gate:** Forged or stale credential fails; buyer's current credential admits once; repeat scan fails.
- [ ] **Concurrency:** Two simultaneous `buy` calls on one listing → 1 owner; two simultaneous `redeem` calls → 1 admission.
- [ ] **Recovery:** Timeout/interrupt returns `unknown_recovering` and resolves via `resume` without double-sale or double-admission.
- [ ] **Money & evidence:** Contract balance + withdrawal credits reconcile cleanly; UI never shows `confirmed` before `status === 1` receipt.
- [ ] **Restart:** Restarting Next.js preserves contract address, event ID, and judging chain state.
