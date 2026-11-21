# FairTickets local demo

The web app calls the repository CLI from server-side route handlers. The CLI keys and chain controls stay out of browser code.

## Start

1. Install the pinned chain toolchain from `B2-DESIGN.md` and web dependencies with `npm.cmd install --prefix web`.
2. Run `scripts/start-demo.ps1`. It starts the pinned local Anvil node on loopback port 8545, compiles the contract, creates a demo deployment if none exists, and starts Next.js.

`init-demo` refuses to overwrite existing state. `node src/cli.cjs reset-demo` removes the local fixture and state files; it does not rewind Anvil. Initialize again to deploy a new event. The app is a local hackathon demo: never use its generated keys or mock identity attestations with real funds or production identity data.

## Security evaluation

Set `FAIRTICKETS_REPLAY_ENABLED=1` and set `FAIRTICKETS_REPLAY_TOKEN` to a private operator token in the Next.js server environment. Restart Next.js after changing the settings. Open `/attack`, enter the operator token, and select a fixture to compare Observe and Enforce runs. The reported sales are security-service checkouts from isolated fixtures. The repeated-entry check on the same page uses the separate on-chain flow.

The same operator token unlocks the capacity benchmark. Use a buyer preset or enter up to 100,000 synthetic buyers, with custom limits for buyers per wave and per shared network. The benchmark measures queue, reservation, and checkout decisions in one in-memory sale. It reports event throughput, p95 and p99 evaluation times, and sampled peak process memory.

