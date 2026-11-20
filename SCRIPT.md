# FairTickets Technical Process Guide (ASD-STE100)

This document explains how FairTickets works from end to end. It is written in Simplified Technical English (ASD-STE100) for mentor presentations and technical questions.

---

## 1. System Architecture

FairTickets has three layers. Each layer has one clear responsibility:

1. **Blockchain Contract (`contracts/FairTickets.sol`)**:
   - The smart contract is the single source of truth.
   - It enforces entry rules, queue priority, the lottery for a batch that exceeds remaining capacity, ticket ownership, the resale price cap, pull payouts, and one-time gate admission.
2. **Core CLI (`src/cli.cjs`)**:
   - The CLI signs and sends transactions to the local Anvil chain (`chainId` `31337`).
   - It prevents nonce collisions with a kernel wallet lock (`withWalletLock`).
   - It records signed transactions in a local journal (`journal/<address>.json`) for crash recovery.
   - It records activity events in `activity-log.ndjson` for review alerts.
3. **Web App (`web/`)**:
   - The Next.js frontend provides pages for **Fan** (`/fan`), **Gate** (`/gate`), and **Organiser** (`/organiser`).
   - The frontend never holds private keys and never decides if a ticket is valid.
   - Server-side API routes (`web/src/app/api/[...path]/route.ts`) call `src/cli.cjs --json` through `web/src/lib/cli-bridge.ts`.

---

## 2. Separated Demo Identities

In production, each user signs transactions from a personal wallet. In this local prototype, `init-demo` creates five separate Anvil wallets in `artifacts/demo-fixture.json`:

- `organiser`: Deploys the event, finalizes reservations in the demo, and withdraws primary sale funds.
- `attester`: Signs entry eligibility proofs (`EntryAttestation`).
- `gate`: Submits `redeem` transactions at the venue gate.
- `fanA` and `fanB`: Join the ticket queue, claim reservations, list or buy on resale, and sign gate credentials.

The `status` command reads the chain and does not change state. The `reset-demo` command clears only the local demo files so you can deploy a fresh event.

---

## 3. End-to-End Ticket Lifecycle

The smart contract moves through `ENTRY`, `DRAW` (allocation), `CLAIM`, `RESALE`, and `GATE`, then returns `CLOSED`. The contract and CLI keep the existing `DRAW`, `lock-draw`, and `draw` names for compatibility.

### Step 1: Attested Entry (`ENTRY` Phase)

1. A fan selects `fanA` or `fanB` on `/fan` and clicks **Enter event**.
2. The `attester` wallet signs an EIP-712 `EntryAttestation` with four fields: `editionId`, `subject`, `wallet`, and `expiry`.
3. The fan wallet sends `enter(subject, expiry, attestation)` to `FairTickets.sol`.
4. The contract checks these conditions:
   - `block.timestamp <= entryDeadline` (entry is still open).
   - Allocation has not started.
   - The subject is nonzero.
   - `block.timestamp <= expiry` (the attestation is not expired).
   - `subjectEntered[subject]` is `false` (one entry per attested person/subject).
   - `walletEntered[msg.sender]` is `false` (one entry per wallet).
5. The contract recovers the signer from the EIP-712 digest and checks that it equals `attester`.
6. If valid, the contract adds `msg.sender` to the `entrants` array. Eligible entries mined in the same block form one batch. At this step the fan has joined the queue. Reservations are finalized after entry closes.

### Step 2: Queue Allocation (`DRAW` Phase)

1. After the entry deadline, call `lockDraw()`. The contract uses the recorded batch start indices to find the block that contains the last available slot in queue order.
2. Earlier batches keep priority. If every entrant fits, or if a batch exactly fills the remaining slots, the contract can finalize without waiting for randomness. Any later batches receive no slots.
3. If a batch has more eligible fans than remaining slots, the contract records its range as `[lotteryStart, lotteryEnd)` and sets `drawTargetBlock = block.number + 2`.
4. Call `draw()` to finalize reservations. If a lottery is required, the transaction must execute after the target block and within 256 blocks of it. The contract mixes the target block hash, the contract address, and the entrant count into a seed. A partial Fisher–Yates shuffle selects only the applicants needed from that batch.
5. The contract assigns slots starting at `1` and starts the claim window. The demo uses the organiser role for these calls. Anyone can submit the calls when the contract's conditions are met.

**Example:** With 100 tickets, the first block of 80 eligible fans gets 80 reservations. If the next block contains 80 eligible fans, those 80 enter a lottery for the remaining 20. Fans in later blocks get no reservations.

**What the batch measures:** Entries mined in the same block compete as a batch. Network delay and block capacity can put simultaneous browser clicks into different blocks. The Anvil block hash is demo randomness and can be influenced by the local chain operator.

**Demo setup:** Use a fresh deployment of the queue-first contract. If the organiser screen still says **Close entry and lock draw** and **Run draw**, these buttons lock and finalize allocation. A normal click-through can show queue priority. Use the controlled benchmark to show entries competing in the same block.

### Step 3: Primary Claim (`CLAIM` Phase)

1. Before `claimDeadline`, a selected winner clicks **Claim reserved ticket** on `/fan`.
2. The fan sends `claim()` with exact `msg.value == facePrice`.
3. The contract checks that `msg.sender` is a winner, has not claimed yet, and sent the exact face price.
4. The contract creates `tickets[slot]` with `owner = msg.sender`, `version = 1`, `paidPrice = facePrice`, and `admitted = false`.
5. The contract adds `facePrice` to `proceeds[organiser]`.

### Step 4: Price-Capped Resale (`RESALE` Phase)

1. Between `claimDeadline` and `resaleCutoff`, the ticket owner calls `list(slot, expectedVersion, price)`.
2. The contract calculates `maxPrice = min(ticket.paidPrice, facePrice)`.
3. If `price > maxPrice`, the contract reverts with `"Price exceeds cap"` (`RESALE_CAP_EXCEEDED`).
4. To buy a listed ticket, another registered fan (`walletEntered[msg.sender] == true`) who holds no ticket (`heldSlot[msg.sender] == 0`) calls `buy(slot, listedVersion, expectedPrice)` with exact `msg.value == expectedPrice`.
5. The contract transfers ownership to the buyer, **increments `version` from `1` to `2`**, sets `paidPrice = expectedPrice`, and credits `proceeds[seller]`.
6. Because `version` increments to `2`, any gate credential signed for `version = 1` becomes invalid.

### Step 5: One-Time Gate Admission (`GATE` Phase)

1. The ticket owner signs an EIP-712 `GateCredential` (`editionId`, `slot`, `version`, `expiry`) using `sign-gate`.
2. Between `resaleCutoff` and `gateClose`, the gate scanner calls `redeem(slot, version, expiry, ownerSig, scanId)`.
3. Only the `gate` address can call `redeem`.
4. The contract checks:
   - `tickets[slot].version == version` (rejects stale `v1` credentials with `"Version mismatch"` / `STALE_CREDENTIAL`).
   - `!tickets[slot].admitted` (rejects repeat scans with `"Already admitted"` / `ALREADY_ADMITTED`).
   - `block.timestamp <= expiry` and `expiry <= block.timestamp + 120` (short-lived credential window).
   - ECDSA signature recovery equals `tickets[slot].owner` (rejects forged credentials with `FORGED_CREDENTIAL`).
5. On success, the contract sets `tickets[slot].admitted = true`, increments `admittedCount`, and emits `Admitted(slot, version, scanId)`.

### Step 6: Pull Withdrawals (`withdraw`)

1. The `organiser` and `seller` each call `withdraw()` to pull their own `proceeds` balance from the contract.
2. Pull payments isolate failed transfers: one failing receiver cannot block payouts for other users.

---

## 4. Concurrency, Crash Recovery, and Honest UI States

The CLI and API protect users from race conditions and network drops:

1. **Kernel-Scoped Wallet Mutex (`withWalletLock`)**:
   - Before signing a transaction, `src/cli.cjs` acquires an OS kernel lock (named pipe on Windows, abstract socket on Linux) for the wallet address.
   - This prevents two processes that share one wallet from picking the same nonce.
   - If a process crashes or receives `SIGKILL`, the OS releases the lock immediately.
2. **Atomic Scan Claim (`claimGateScanAtomic` / `tryFinalizeGateDecision`)**:
   - Before broadcasting `redeem`, the CLI atomically creates `<scanId>.json` using `linkSync`.
   - If two gate workers race on the same `scanId`, only one worker can claim and broadcast.
3. **Transaction Journal (`journal/<address>.json`)**:
   - Before `eth_sendRawTransaction`, the CLI writes the signed raw bytes, nonce, and `txHash` with status `PENDING`.
   - After receipt confirmation, it updates the entry to `CONFIRMED` or `REVERTED` (with decoded revert reason).
4. **Honest Transaction States in the UI**:
   - `confirmed` (HTTP `200`): On-chain receipt has `status === '0x1'` (plus `Admitted` event for gate scans).
   - `rejected` (HTTP `409`): Contract reverted or duplicate scan was blocked.
   - `unknown_recovering` or `pending` (HTTP `202`): Timeout, dropped RPC response, or active worker.
   - The UI **never** marks a timeout as a confirmed failure. The user clicks **Check / Resume** (`/api/tx/resume`), which checks the chain receipt or safely re-submits the exact same signed transaction.

---

## 5. Review-Only Suspicious Activity Alerts

The CLI writes lifecycle events to `activity-log.ndjson`. The `alerts` command (`GET /api/organiser/alerts`) applies three deterministic rules:

- `REPEATED_ENTRY_SUBJECT`: 3 or more entry attempts for the same subject.
- `REPEATED_FAILED_SCAN`: 2 or more failed admission attempts for the same `scanId`.
- `REQUEST_BURST`: 5 or more requests within 10 seconds.

Every alert is marked `severity: "review"` with the note `"Review signal only; does not auto-block"`. Alerts help the organiser inspect suspicious patterns, while the smart contract enforces all hard rules on-chain.

---

## 6. Verification and Volume Evidence

The repository includes these verification suites and recorded results:

- **`node src/benchmarks.cjs` (7/7 pass)**: With 1,000 entrants and 100 slots, verifies 80 queue reservations, 20 reservations selected from the next 80-person batch, and zero reservations from later blocks. Also verifies that an exact-fit batch skips the lottery, a 1,000-transaction claim burst does not oversell, and the duplicate-entry, resale, credential, and gate protections work.
- **`artifacts/volume-summary.json` (historical)**: Records 100,000 successful writes at 114.54 writes per second on local Anvil. This run used the earlier allocation policy.
- **`node src/verify-loop1.cjs` and `node src/verify-loop2.cjs`**: Both passed against the updated contract. Loop 2 passed 126 checks, including queue priority, revert decoding, UUID `scanId` normalization, concurrent gate races, and timeout recovery.
- **`node src/demo.cjs`**: Runs the standalone CLI end-to-end demonstration in under 60 seconds.
- **`node scripts/integration-test.cjs`**: The browser and API verification suite covers RPC recovery, concurrency, money reconciliation, and server restarts. The core migration was verified through the CLI and contract tests above.

---

## 7. Quick 2-Minute Mentor Explanation Script

Use this short script when a mentor asks how the system works:

> "In FairTickets, the Solidity smart contract on Anvil is the single source of truth. The Next.js UI and server API never decide if a ticket is valid. Every action calls our Node CLI, which uses an OS kernel wallet lock and a pre-broadcast transaction journal.
>
> First, an attester signs an EIP-712 proof. The contract allows one entry per attested subject and one per wallet. Earlier entry blocks get first priority. Say we have 100 tickets and the first block has 80 eligible fans. All 80 get reservations. If the next block also has 80 fans, only that group enters a lottery for the 20 remaining slots. If the next block has exactly 20, they all get reservations without a lottery. After allocation, fans claim their reserved slots at face value.
>
> On resale, the contract enforces `price <= min(paidPrice, facePrice)` and rejects higher prices on-chain. When a fan buys a ticket, ownership moves to the buyer and the ticket `version` increments from `1` to `2`. At the gate, any `v1` credential signed by the seller is rejected as `STALE_CREDENTIAL`, the buyer's `v2` credential admits once, and any second scan fails as `ALREADY_ADMITTED`.
>
> If an RPC call times out, the API returns HTTP `202` (`unknown_recovering`) instead of a false failure, and `resume` settles the exact journaled transaction without double-spending or double-admitting. We also surface deterministic, review-only alerts on `/organiser` without auto-blocking users."
