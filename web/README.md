# FairTickets local demo

The web app calls the repository CLI from server-side route handlers. The CLI keys and chain controls stay out of browser code.

## Start

1. Install the pinned chain toolchain from `B2-DESIGN.md` and web dependencies with `npm.cmd install --prefix web`.
2. Run `scripts/start-demo.ps1`. It starts the pinned local Anvil node on loopback port 8545, compiles the contract, creates a demo deployment if none exists, and starts Next.js.

`init-demo` refuses to overwrite existing state. `node src/cli.cjs reset-demo` removes the local fixture and state files; it does not rewind Anvil. Initialize again to deploy a new event. The app is a local hackathon demo: never use its generated keys or mock identity attestations with real funds or production identity data.

