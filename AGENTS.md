# AGENTS.md — Multi-Agent & Parallel Development Rules

This repository is developed in parallel by **two developers and their coding agents**:
- **Dev 1 (Core Agent):** Solidity contracts, Anvil toolchain, `src/cli.cjs`, benchmarks, detection, and verification scripts.
- **Dev 2 (Web Agent):** Next.js App Router frontend + API routes in `web/`.

Follow these rules **strictly** to prevent merge conflicts, broken contracts, or lost work.

---

## 1. Strict File Ownership (Do Not Cross Boundaries)

| Path / Pattern | Owner | Rule for Other Agent |
|---|---|---|
| `contracts/**` | **Dev 1** | **DO NOT EDIT.** Read-only for Dev 2. |
| `src/**` (`cli.cjs`, `anvil.cjs`, `compile.cjs`, `demo.cjs`, `benchmarks.cjs`, `verify-*.cjs`, `volume-*.cjs`) | **Dev 1** | **DO NOT EDIT.** If Dev 2 needs a new CLI flag or JSON field, adapt in `web/src/app/api/**` or ask Dev 1 to add it. |
| `scripts/start-demo.ps1` | **Dev 1** (shared review) | Dev 2 may suggest edits, do not rewrite CLI/Anvil startup logic unilaterally. |
| `web/**` | **Dev 2** | **DO NOT EDIT.** Read-only for Dev 1. |
| `TASKS.md` | **Shared** | Dev 1 edits **only** `D1` / `L*-D1-*` checkboxes; Dev 2 edits **only** `D2` / `L*-D2-*` checkboxes. Never rewrite the other dev's section. |
| `.gitignore` | **Shared** | Append-only; never reorder or duplicate lines. |

---

## 2. Integration Contract Discipline (`cli.cjs` ↔ `web/`)

1. **Additive-Only JSON Changes (Dev 1):**
   - `web/src/app/api/[...path]/route.ts` and `web/src/lib/cli-bridge.ts` depend on `src/cli.cjs --json` outputs.
   - **Never rename or remove** existing JSON keys (`ok`, `txStatus`, `txHash`, `errorCode`, `error`, `reason`, `ownerSig`, `credential`, `tickets`, `winners`, `roles`, `volumeEvidence`, `alerts`). Only add new optional fields.
   - Preserve all legacy non-`--json` flags (`--key`, `--contract`, `--sig`, `--edition-id`, `--value`) so `src/demo.cjs` and `src/benchmarks.cjs` never break.
2. **No Chain Logic in `web/` (Dev 2):**
   - `web/` must **never** import `ethers` in client components, hold private keys, or spawn/kill Anvil.
   - All chain reads/writes go through `web/src/lib/cli-bridge.ts` → `node ../src/cli.cjs ... --json`.
   - `web/src/lib/types.ts` must stay aligned with `TASKS.md` Section 2.
3. **Never Commit Local Runtime/Key Artifacts:**
   - `artifacts/demo-fixture.json`, `artifacts/demo-state.json`, `artifacts/activity-log.ndjson`, `artifacts/journal/`, and `artifacts/gate-claims/` are gitignored and **must never be force-added or committed**.

---

## 3. Git Sync & Merge Hygiene

1. **Sync Before Every Loop / Task:**
   - Run `git fetch origin` and merge/rebase `origin/master` into your branch **before** starting work and **before** pushing.
2. **Branch Naming:**
   - Dev 1 works on `master` or `core/<task>` branches.
   - Dev 2 works on `web/<task>` or `loop/<task>` branches.
   - Merge back to `master` at every loop checkpoint (every 2–3 hours) so branches never drift.
3. **Conflict Prevention:**
   - If you realize a task requires touching a file owned by the other agent, **stop and coordinate** instead of editing it directly.
   - Never force-push `master`.

---

## 4. Mandatory Verification Before Commit / Push

- **Dev 1 (Core Agent) must run:**
  - `node src/verify-loop1.cjs` (exits `0`)
  - `node src/demo.cjs` (exits `0`, `passed: true`)
  - `node src/benchmarks.cjs` whenever `contracts/**`, `src/cli.cjs` locking/recovery, or `src/anvil.cjs` changes (`7/7` pass). If `benchmarks.cjs` only refreshes timestamps in `artifacts/benchmark-report.md` / `artifacts/benchmark-results.json`, run `git restore artifacts/benchmark-report.md artifacts/benchmark-results.json` before committing.
- **Dev 2 (Web Agent) must run:**
  - `npm --prefix web run build` (or `npx --prefix web tsc --noEmit`) and verify zero TypeScript/build errors.

---

## 5. Environment Notes (Windows / PowerShell)

- Use `;` instead of `&&` in PowerShell 5.1 commands.
- Local Anvil `1.7.1` runs standalone on `http://127.0.0.1:8545` (`chainId: 31337`). Restarting Next.js must never reset or redeploy the judging chain.
