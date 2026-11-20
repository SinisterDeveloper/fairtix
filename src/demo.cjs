const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { ethers } = require('./toolchain.cjs');
const { startAnvil } = require('./anvil.cjs');

const root = resolve(__dirname, '..');
const cliPath = join(root, 'src', 'cli.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(`Demo assertion failed: ${msg}`);
}

function cli(args) {
  const out = execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

async function main() {
  const demoStartMs = performance.now();
  const port = Number(process.env.FAIRTICKETS_DEMO_PORT || 18545);
  const anvil = await startAnvil({ port, blockTime: 1 });
  const rpc = anvil.endpoint;

  try {
    // 5 independent wallets (not Anvil's unlocked stock accounts)
    const organiser = ethers.Wallet.createRandom();
    const attester = ethers.Wallet.createRandom();
    const gate = ethers.Wallet.createRandom();
    const fanA = ethers.Wallet.createRandom();
    const fanB = ethers.Wallet.createRandom();

    const fundHex = '0x' + (10n * 10n ** 18n).toString(16);
    await anvil.rpcBatch(
      [organiser, attester, gate, fanA, fanB].map((w) => ['anvil_setBalance', [w.address, fundHex]])
    );

    console.log('=== 1. DEPLOY FairTickets (Chain ID 31337, Shanghai, 30M gas) ===');
    const deployed = cli([
      'deploy',
      '--rpc', rpc,
      '--key', organiser.privateKey,
      '--organiser', organiser.address,
      '--attester', attester.address,
      '--gate', gate.address,
      '--capacity', '10',
      '--face-price', '200000',
      '--entry-window', '30',
      '--claim-window', '30',
      '--resale-window', '30',
      '--gate-window', '60',
    ]);
    console.log(deployed);

    const { contractAddress, editionId, codeHash: deployedRuntimeCodeHash } = deployed;
    assert(ethers.isAddress(contractAddress), 'Deployed contractAddress must be valid');
    assert(deployedRuntimeCodeHash && deployedRuntimeCodeHash.startsWith('0x'), 'Deployed runtime codeHash missing');

    console.log('\n=== 2. ATTESTED ENTRY (Fan A & Fan B) ===');
    const attA = cli([
      'attest', '--rpc', rpc, '--key', attester.privateKey,
      '--contract', contractAddress, '--edition-id', editionId,
      '--subject', 'fan-a-subject', '--wallet', fanA.address, '--expiry', '9999999999',
    ]);
    const attB = cli([
      'attest', '--rpc', rpc, '--key', attester.privateKey,
      '--contract', contractAddress, '--edition-id', editionId,
      '--subject', 'fan-b-subject', '--wallet', fanB.address, '--expiry', '9999999999',
    ]);
    const enterA = cli([
      'enter', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress,
      '--subject', attA.subject, '--expiry', '9999999999', '--attestation', attA.attestation,
    ]);
    const enterB = cli([
      'enter', '--rpc', rpc, '--key', fanB.privateKey, '--contract', contractAddress,
      '--subject', attB.subject, '--expiry', '9999999999', '--attestation', attB.attestation,
    ]);
    assert(enterA.status === '0x1', `enterA failed: ${JSON.stringify(enterA)}`);
    assert(enterB.status === '0x1', `enterB failed: ${JSON.stringify(enterB)}`);
    console.log({ enterA, enterB });

    console.log('\n=== 3. LOCK DRAW & DRAW ===');
    cli(['advance-time', '--rpc', rpc, '--seconds', '35']);
    const lockRes = cli(['lock-draw', '--rpc', rpc, '--key', organiser.privateKey, '--contract', contractAddress]);
    cli(['mine', '--rpc', rpc, '--blocks', '3']);
    const drawRes = cli(['draw', '--rpc', rpc, '--key', organiser.privateKey, '--contract', contractAddress]);
    assert(lockRes.status === '0x1', `lockDraw failed: ${JSON.stringify(lockRes)}`);
    assert(drawRes.status === '0x1', `draw failed: ${JSON.stringify(drawRes)}`);
    console.log({ lockRes, drawRes });

    console.log('\n=== 4. PRIMARY CLAIM (Fan A) ===');
    const claimA = cli([
      'claim', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress, '--value', '200000',
    ]);
    assert(claimA.status === '0x1', `claimA failed: ${JSON.stringify(claimA)}`);
    const provider = new ethers.JsonRpcProvider(rpc);
    const artifact = require(join(root, 'artifacts', 'FairTickets.json'));
    const c = new ethers.Contract(contractAddress, artifact.abi, provider);
    const slotA = Number(await c.winnerSlot(fanA.address));
    assert(slotA > 0, `slotA must be > 0, got ${slotA}`);
    console.log({ slotA, claimA });

    // Fan A signs a gate credential for v1 before reselling
    const resaleCutoff = Number(await c.resaleCutoff());
    const gateExpiry = String(resaleCutoff + 40);
    const staleGateSigA = cli([
      'sign-gate', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress,
      '--edition-id', editionId, '--slot', String(slotA), '--version', '1', '--expiry', gateExpiry,
    ]);

    console.log('\n=== 5. REJECTED ATTEMPT: RESALE ABOVE FACE PRICE (250,000 > 200,000) ===');
    cli(['advance-time', '--rpc', rpc, '--seconds', '35']);
    const overCapList = cli([
      'list', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress,
      '--slot', String(slotA), '--version', '1', '--price', '250000',
    ]);
    assert(overCapList.status === '0x0', `overCapList must revert (0x0), got ${overCapList.status}`);
    console.log({ overCapList, expected: '0x0 (REVERTED)' });

    console.log('\n=== 6. LEGITIMATE CAPPED RESALE (Fan A -> Fan B at 180,000 wei) ===');
    const validList = cli([
      'list', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress,
      '--slot', String(slotA), '--version', '1', '--price', '180000',
    ]);
    assert(validList.status === '0x1', `validList failed: ${JSON.stringify(validList)}`);
    const buyB = cli([
      'buy', '--rpc', rpc, '--key', fanB.privateKey, '--contract', contractAddress,
      '--slot', String(slotA), '--version', '1', '--price', '180000',
    ]);
    assert(buyB.status === '0x1', `buyB failed: ${JSON.stringify(buyB)}`);
    const ticketAfterResale = cli(['ticket', '--rpc', rpc, '--contract', contractAddress, '--slot', String(slotA)]);
    assert(ticketAfterResale.owner.toLowerCase() === fanB.address.toLowerCase(), 'Ticket owner must be Fan B');
    assert(ticketAfterResale.version === 2, `Ticket version must be 2, got ${ticketAfterResale.version}`);
    assert(ticketAfterResale.paidPrice === '180000', `Ticket paidPrice must be 180000, got ${ticketAfterResale.paidPrice}`);
    console.log({ validList, buyB, ticketAfterResale });

    console.log('\n=== 7. GATE: REJECT STALE SELLER CREDENTIAL (v1) & ADMIT BUYER CREDENTIAL (v2) ===');
    cli(['advance-time', '--rpc', rpc, '--seconds', '35']);
    const rejectStale = cli([
      'redeem', '--rpc', rpc, '--key', gate.privateKey, '--contract', contractAddress,
      '--slot', String(slotA), '--version', '1', '--expiry', gateExpiry, '--sig', staleGateSigA.ownerSig,
    ]);
    assert(rejectStale.decision === 'REJECT' && rejectStale.status === '0x0', `Stale v1 must be REJECT, got ${JSON.stringify(rejectStale)}`);
    const freshGateSigB = cli([
      'sign-gate', '--rpc', rpc, '--key', fanB.privateKey, '--contract', contractAddress,
      '--edition-id', editionId, '--slot', String(slotA), '--version', '2', '--expiry', gateExpiry,
    ]);
    const admitB = cli([
      'redeem', '--rpc', rpc, '--key', gate.privateKey, '--contract', contractAddress,
      '--slot', String(slotA), '--version', '2', '--expiry', gateExpiry, '--sig', freshGateSigB.ownerSig,
    ]);
    assert(admitB.decision === 'ADMIT' && admitB.version === '2', `Fresh v2 must be ADMIT, got ${JSON.stringify(admitB)}`);
    console.log({ rejectStale, admitB });

    console.log('\n=== 8. WITHDRAW PROCEEDS & RECONCILE FINAL STATE ===');
    const withdrawOrg = cli(['withdraw', '--rpc', rpc, '--key', organiser.privateKey, '--contract', contractAddress]);
    const withdrawFanA = cli(['withdraw', '--rpc', rpc, '--key', fanA.privateKey, '--contract', contractAddress]);
    assert(withdrawOrg.status === '0x1', `withdrawOrg failed: ${JSON.stringify(withdrawOrg)}`);
    assert(withdrawFanA.status === '0x1', `withdrawFanA failed: ${JSON.stringify(withdrawFanA)}`);
    const finalStatus = cli(['status', '--rpc', rpc, '--contract', contractAddress]);
    assert(finalStatus.balanceWei === '0', `Final balanceWei must be 0, got ${finalStatus.balanceWei}`);
    assert(finalStatus.issuedCount === 1, `issuedCount must be 1, got ${finalStatus.issuedCount}`);
    assert(finalStatus.admittedCount === 1, `admittedCount must be 1, got ${finalStatus.admittedCount}`);
    assert(finalStatus.codeHash === deployedRuntimeCodeHash, 'status codeHash must match deploy runtime codeHash');

    const durationMs = Math.round(performance.now() - demoStartMs);
    assert(durationMs <= 60_000, `Demo exceeded 60-second budget (${durationMs} ms)`);
    console.log({ withdrawOrg, withdrawFanA, finalStatus, durationMs, passed: true });
  } finally {
    anvil.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
