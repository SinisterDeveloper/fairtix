# FairTickets local demo

The web app calls the repository CLI from server-side route handlers. The CLI keys and chain controls stay out of browser code.

## Start

1. Start the pinned local Anvil node from `B2-DESIGN.md` on loopback port 8545, chain ID 31337.
2. Compile the contract with `node src/compile.cjs`.
3. Initialize one demo deployment with `node src/cli.cjs init-demo`. This funds five generated local role wallets and writes their private keys to ignored `artifacts/demo-fixture.json`; deployment details go to ignored `artifacts/demo-state.json`.
4. Install the web dependencies with `npm.cmd install --prefix web` and start the app with `npm.cmd run dev --prefix web`.

`init-demo` refuses to overwrite existing state. `node src/cli.cjs reset-demo` removes the local fixture and state files; it does not rewind Anvil. Initialize again to deploy a new event. The app is a local hackathon demo: never use its generated keys or mock identity attestations with real funds or production identity data.

