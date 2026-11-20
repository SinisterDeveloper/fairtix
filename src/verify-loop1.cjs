const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, unlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { startAnvil } = require('./anvil.cjs');

const root = resolve(__dirname, '..');
const cliPath = join(__dirname, 'cli.cjs');
const demoStatePath = join(root, 'artifacts', 'demo-state.json');

function runCli(args) {
  const out = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

async function main() {
  if (existsSync(demoStatePath)) unlinkSync(demoStatePath);

  const port = 8555;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil({
    port,
    chainId: 31337,
    accounts: 10,
    mnemonic: 'test test test test test test test test test test test junk',
  });

  try {
    const init = runCli(['init-demo', '--rpc', rpcUrl]);
    assert.equal(init.ok, true);
    assert.equal(init.phase, 'ENTRY');
    assert.equal(init.capacity, 1);
    assert.equal(existsSync(demoStatePath), true);

    const enterA = runCli(['enter', '--role', 'fanA', '--subject', 'fan-a-loop1', '--json']);
    assert.equal(enterA.ok, true);
    assert.equal(enterA.txStatus, 'confirmed');

    const enterB = runCli(['enter', '--role', 'fanB', '--subject', 'fan-b-loop1', '--json']);
    assert.equal(enterB.ok, true);
    assert.equal(enterB.txStatus, 'confirmed');

    runCli(['advance-time', '--seconds', '125', '--rpc', rpcUrl]);
    const lockRes = runCli(['lock-draw', '--role', 'organiser', '--json']);
    assert.equal(lockRes.ok, true);
    assert.equal(lockRes.txStatus, 'confirmed');

    runCli(['mine', '--blocks', '2', '--rpc', rpcUrl]);
    const drawRes = runCli(['draw', '--role', 'organiser', '--json']);
    assert.equal(drawRes.ok, true);
    assert.equal(drawRes.txStatus, 'confirmed');

    const afterDraw = runCli(['status', '--json']);
    assert.equal(afterDraw.drawn, true);
    assert.equal(afterDraw.winnersCount, 1);
    assert.equal(afterDraw.phase, 'CLAIM');

    const winnerAddr = afterDraw.winners[0].toLowerCase();
    const fanAAddr = afterDraw.roles.fanA.address.toLowerCase();
    const winnerRole = winnerAddr === fanAAddr ? 'fanA' : 'fanB';
    const buyerRole = winnerRole === 'fanA' ? 'fanB' : 'fanA';

    const claimRes = runCli(['claim', '--role', winnerRole, '--json']);
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.txStatus, 'confirmed');
    assert.equal(claimRes.ticket.slot, 1);
    assert.equal(claimRes.ticket.version, 1);

    // Advance past claimDeadline (300s) into RESALE phase
    runCli(['advance-time', '--seconds', '305', '--rpc', rpcUrl]);
    const listPrice = afterDraw.facePriceWei;
    const listRes = runCli(['list', '--role', winnerRole, '--slot', '1', '--version', '1', '--price', listPrice, '--json']);
    assert.equal(listRes.ok, true);
    assert.equal(listRes.txStatus, 'confirmed');
    assert.equal(listRes.ticket.listed, true);

    const buyRes = runCli(['buy', '--role', buyerRole, '--slot', '1', '--version', '1', '--price', listPrice, '--json']);
    assert.equal(buyRes.ok, true);
    assert.equal(buyRes.txStatus, 'confirmed');
    assert.equal(buyRes.ticket.version, 2);
    assert.equal(buyRes.ticket.owner.toLowerCase(), afterDraw.roles[buyerRole].address.toLowerCase());

    // Advance past resaleCutoff (300s) into GATE phase
    runCli(['advance-time', '--seconds', '305', '--rpc', rpcUrl]);
    const signRes = runCli(['sign-gate', '--role', buyerRole, '--slot', '1', '--json']);
    assert.equal(signRes.ok, true);
    assert.equal(signRes.credential.version, 2);

    const redeemRes = runCli([
      'redeem',
      '--role', 'gate',
      '--slot', String(signRes.credential.slot),
      '--version', String(signRes.credential.version),
      '--expiry', String(signRes.credential.expiry),
      '--owner-sig', signRes.credential.ownerSig,
      '--json',
    ]);
    assert.equal(redeemRes.ok, true);
    assert.equal(redeemRes.txStatus, 'confirmed');
    assert.equal(redeemRes.gateDecision, 'ADMIT');
    assert.equal(redeemRes.ticket.admitted, true);

    const finalStatus = runCli(['status', '--json']);
    assert.equal(finalStatus.admittedCount, 1);
    assert.equal(finalStatus.tickets[0].admitted, true);
    assert.equal(finalStatus.tickets[0].version, 2);

    console.log(JSON.stringify({ loop1CliVerified: true, winnerRole, buyerRole, slot: 1, finalVersion: 2, admittedCount: 1 }, null, 2));
  } finally {
    await anvil.stop();
    if (existsSync(demoStatePath)) unlinkSync(demoStatePath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
