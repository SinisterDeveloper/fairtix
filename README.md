# FairTickets

FairTickets is an anti-scalping event ticketing platform built on a local Anvil EVM chain (`chainId: 31337`), a server-side Node.js CLI bridge, a Hybrid Security & ML Engine, and a Next.js App Router web application.

## Key Capabilities

- **Queue-First Allocation:** Entries mined in earlier blocks receive priority; only an oversubscribed batch mined in the same block enters a bounded lottery (`contracts/FairTickets.sol`).
- **One Entry per Person & Wallet:** Enforces EIP-712 attested uniqueness on-chain (`subjectEntered` and `walletEntered`).
- **Price-Capped Resale:** Resale prices are capped at face value (`<= paidPrice` / `facePrice`), and every transfer increments the ticket `version` (`v1 -> v2`), automatically invalidating prior gate passes.
- **One-Time QR Gate Admission:** Venue check-in verifies a short-lived EIP-712 pass (`GateCredential`) encoding `editionId`, `slot`, `version`, and `expiry`, preventing stale-pass reuse and duplicate scans.
- **Hybrid Security & ML Engine:** Combines deterministic anti-bot/scalping rules with an unsupervised human-baseline anomaly detector (`security/`) and live step-up challenges.

## Architecture

| Directory | Purpose |
|---|---|
| `contracts/` | `FairTickets.sol` smart contract and test helpers |
| `src/` | CLI (`cli.cjs`), Anvil toolchain (`anvil.cjs`, `compile.cjs`), verification suites, and benchmarks |
| `security/` | Risk engine, ML scorer, unsupervised baseline, and replay/capacity simulators |
| `train/` | Jupyter notebooks and training scripts for web bot & funnel baseline models |
| `web/` | Next.js App Router frontend and `/api/[...path]` server-side CLI bridge |

## Web Zones

1. **Users (`/`, `/fan`, `/bookings`)**
   - Browse live events created by organisers, top up wallet balance, select seats on an interactive stadium seating map, join the queue, claim reserved tickets, trade on capped resale, and generate scannable QR passes.
2. **Organisers (`/organiser`, `/gate`)**
   - Create and configure events (name, venue, date, capacity, queue window, INR price), lock and finalize allocations, advance event phases (`ENTRY -> DRAW -> CLAIM -> RESALE -> GATE`), withdraw proceeds, and scan QR passes at the venue gate.
3. **Admin (`/admin`, `/attack`)**
   - Inspect live backend activity logs and capacity benchmark runs (with `100` / `500` / `1000` per-page pagination and expandable entry details), contract/hash telemetry, reconciled role credits, security alerts, and run defensive replay & capacity benchmarks.

## Running Locally

### 1. Install Dependencies

```powershell
npm install
npm --prefix web install
```

### 2. Start Anvil & the Web App

Use the helper script:

```powershell
.\scripts\start-demo.ps1
```

Or start Anvil on port `8545` and launch Next.js with the security evaluation token enabled:

```powershell
$env:FAIRTICKETS_REPLAY_ENABLED="1"
$env:FAIRTICKETS_REPLAY_TOKEN="attack"
npm --prefix web run dev
```

Open `http://localhost:3000`, go to **Organisers** (`/organiser`), and create a new event to open the booking queue.

## Verification & Benchmarks

```powershell
# TypeScript check & production build
web\node_modules\.bin\tsc.cmd -p web\tsconfig.json --noEmit
npm --prefix web run build

# Core contract & CLI verification
node src/verify-loop1.cjs
node src/verify-loop2.cjs
node src/demo.cjs
node src/benchmarks.cjs
```
