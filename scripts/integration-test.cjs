const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { startAnvil } = require('../src/anvil.cjs');
const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '..');
const { chromium } = require(path.join(root, 'web', 'node_modules', 'playwright'));
const cli = path.join(root, 'src', 'cli.cjs');
const nextBin = path.join(root, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
const facePrice = 50_000_000_000_000_000n;
const resalePrice = 40_000_000_000_000_000n;

function pass(label) { process.stdout.write(`[PASS] ${label}\n`); }
function check(condition, label) { assert.ok(condition, label); pass(label); }

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (err) => err ? reject(err) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function cliJson(args, stateDir) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [cli, ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FAIRTICKETS_STATE_DIR: stateDir },
      timeout: 30_000,
    }));
  } catch (error) {
    throw new Error(`CLI ${args.join(' ')} failed: ${error.message}\n${error.stderr || ''}\n${error.stdout || ''}`);
  }
  return JSON.parse(stdout);
}

function postJson(base, route, body) {
  return fetch(`${base}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

async function clickUiAction(page, label, endpoint) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/${endpoint}`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: label }).click();
  const response = await responsePromise;
  return { status: response.status(), body: await response.json() };
}

async function waitForPage(base, proc, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Next server exited (${proc.exitCode}): ${logs.join('')}`);
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch { }
    await delay(250);
  }
  throw new Error(`Next server did not start: ${logs.join('')}`);
}

function startNext(port, stateDir) {
  const proc = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'web'),
    env: { ...process.env, FAIRTICKETS_STATE_DIR: stateDir, FAIRTICKETS_CLI_TIMEOUT_MS: '10000' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.setEncoding('utf8').on('data', (chunk) => logs.push(chunk));
  proc.stderr.setEncoding('utf8').on('data', (chunk) => logs.push(chunk));
  return { proc, logs, base: `http://127.0.0.1:${port}` };
}

function makeProxy(upstreamUrl) {
  let hangNextSend = false;
  let submittedResolve;
  let submittedPromise = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString('utf8');
    let isRawSend = false;
    try {
      const message = JSON.parse(payload);
      const calls = Array.isArray(message) ? message : [message];
      isRawSend = calls.some((call) => call.method === 'eth_sendRawTransaction');
      if (process.env.FAIRTICKETS_E2E_DEBUG) process.stderr.write(`[proxy] ${calls.map((call) => call.method).join(',')} raw=${isRawSend} hang=${hangNextSend}\n`);
    } catch { }
    try {
      const upstream = await fetch(upstreamUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      const body = await upstream.text();
      if (isRawSend && hangNextSend) {
        hangNextSend = false;
        if (submittedResolve) submittedResolve(JSON.parse(body));
        return; // Simulate losing the RPC response after the node accepts the signed write.
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(body);
    } catch (error) {
      if (process.env.FAIRTICKETS_E2E_DEBUG) process.stderr.write(`[proxy error] ${error.stack || error}\n`);
      if (!res.destroyed) { res.writeHead(502); res.end(String(error)); }
    }
  });
  return {
    server,
    armLostSendResponse() {
      hangNextSend = true;
      submittedPromise = new Promise((resolve) => { submittedResolve = resolve; });
      return submittedPromise;
    },
  };
}

async function stopChild(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(3000)]);
  if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch { } }
}

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const stateDir = fs.mkdtempSync(path.join(tempRoot, 'fairtickets-e2e-'));
  if (!stateDir.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) throw new Error('Refusing to use a test state directory outside the OS temp directory.');
  let anvil;
  let proxy;
  let server;
  let browser;
  let proxyPort;
  const serverPort = await freePort();
  try {
    anvil = await startAnvil({ port: await freePort(), blockTime: 1, accounts: 10 });
    proxy = makeProxy(anvil.endpoint);
    proxyPort = await freePort();
    await new Promise((resolve, reject) => proxy.server.once('error', reject).listen(proxyPort, '127.0.0.1', resolve));
    const proxiedRpc = `http://127.0.0.1:${proxyPort}`;

    const deployed = await cliJson(['init-demo', '--rpc', anvil.endpoint, '--capacity', '1', '--entry-window', '120', '--claim-window', '300', '--resale-window', '300', '--gate-window', '600', '--face-price', facePrice.toString()], stateDir);
    const statePath = path.join(stateDir, 'demo-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.rpcUrl = proxiedRpc;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    check(deployed.ok && deployed.chainId === 31337, 'local deployment created on Anvil chain 31337');

    server = startNext(serverPort, stateDir);
    await waitForPage(server.base, server.proc, server.logs);
    const home = await fetch(server.base);
    check(home.status === 200, 'home page serves over HTTP');

    let response = await fetch(`${server.base}/api/status`, { cache: 'no-store' });
    let status = await response.json();
    check(response.status === 200 && status.contract === deployed.contract && status.capacity === 1, 'status API reports pinned contract and capacity');
    check(status.roles.fanA.address && status.roles.gate.address, 'status exposes role addresses and balances');
    for (const page of ['/fan', '/gate', '/organiser']) {
      const pageResponse = await fetch(`${server.base}${page}`);
      check(pageResponse.status === 200, `${page} page renders`);
    }

    browser = await chromium.launch({ headless: true });
    const ui = await browser.newPage();
    await ui.goto(`${server.base}/fan`);
    const rolePicker = ui.getByLabel('Active demo role');
    const enterButton = ui.getByRole('button', { name: 'Enter event' });
    check(await enterButton.isEnabled(), 'fan actions are available to the selected fan role');
    await rolePicker.selectOption('organiser');
    check(await enterButton.isDisabled() && await ui.getByText('Choose Fan A or Fan B in the role selector to use fan actions.').isVisible(), 'fan actions are disabled when an organiser role is selected');
    await ui.reload();
    check(await rolePicker.inputValue() === 'organiser' && await enterButton.isDisabled(), 'selected role survives a browser refresh');
    await rolePicker.selectOption('fanB');
    await ui.reload();
    check(await rolePicker.inputValue() === 'fanB' && await enterButton.isEnabled(), 'switching back to a fan restores actions after refresh');
    await ui.evaluate(() => localStorage.setItem('fairtickets-credentials', JSON.stringify([{ contract: '0x1234', editionId: '0x5678', slot: 1, version: 1, expiry: 2, ownerSig: '0xabcd', label: 'Fan A · v1' }])));
    await ui.goto(`${server.base}/gate`);
    await ui.getByLabel('Saved credential').selectOption('0');
    check((await ui.getByLabel('Credential JSON').inputValue()).includes('0xabcd'), 'gate loads a saved browser credential');
    await ui.reload();
    check(await ui.getByLabel('Saved credential').inputValue() === '0' && (await ui.getByLabel('Credential JSON').inputValue()).includes('Fan A · v1'), 'credential tray survives route and browser refresh');

    const a = await postJson(server.base, 'enter', { role: 'fanA', subject: 'e2e-fan-a' });
    const b = await postJson(server.base, 'enter', { role: 'fanB', subject: 'e2e-fan-b' });
    check(a.status === 200 && a.body.txStatus === 'confirmed' && b.status === 200 && b.body.txStatus === 'confirmed', 'both fans enter with role-signed attestations');
    const repeatedEntries = await Promise.all([
      postJson(server.base, 'enter', { role: 'fanA', subject: 'e2e-fan-a' }),
      postJson(server.base, 'enter', { role: 'fanA', subject: 'e2e-fan-a' }),
    ]);
    check(repeatedEntries.every((result) => result.status === 409 && result.body.txStatus === 'rejected'), 'repeated same-subject entries are rejected by the contract');

    const lock = await postJson(server.base, 'organiser/advance-and-lock', { seconds: 121 });
    check(lock.status === 200 && lock.body.txStatus === 'confirmed', 'organiser closes entry and locks draw');
    const draw = await postJson(server.base, 'organiser/draw', {});
    check(draw.status === 200 && draw.body.txStatus === 'confirmed', 'organiser draws a winner');

    response = await fetch(`${server.base}/api/status`, { cache: 'no-store' });
    status = await response.json();
    const winnerAddress = status.winners[0].toLowerCase();
    const seller = Object.entries(status.roles).find(([, account]) => account.address.toLowerCase() === winnerAddress)?.[0];
    assert.ok(seller === 'fanA' || seller === 'fanB', 'winner must resolve to a demo fan');
    const buyer = seller === 'fanA' ? 'fanB' : 'fanA';
    const loserClaim = await postJson(server.base, 'claim', { role: buyer });
    check(loserClaim.status === 409 && loserClaim.body.errorCode === 'NOT_WINNER', 'non-winner cannot claim the reserved ticket');
    const submittedPromise = proxy.armLostSendResponse();
    const claimPromise = postJson(server.base, 'claim', { role: seller });
    const submitted = await submittedPromise;
    assert.ok(submitted?.[0]?.result, 'Anvil accepted the signed claim before the proxy dropped the RPC response');
    const claimPending = await claimPromise;
    check(claimPending.status === 202 && claimPending.body.txStatus === 'unknown_recovering', 'lost broadcast response returns HTTP 202 unknown_recovering');
    const claimResponse = await postJson(server.base, 'tx/resume', { role: seller });
    check(claimResponse.status === 200 && claimResponse.body.txStatus === 'confirmed', 'journal resume resolves the lost-response claim without a second transaction');
    status = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(status.issuedCount === 1 && status.tickets[0].owner.toLowerCase() === winnerAddress, 'claim owner reconciles with on-chain ticket state');

    const expiry = status.resaleCutoff + 60;
    const oldCredentialResponse = await postJson(server.base, 'credential/sign', { role: seller, slot: 1, version: 1, expirySeconds: expiry });
    const oldCredential = oldCredentialResponse.body.credential;
    check(oldCredentialResponse.status === 200 && oldCredential.ownerSig, 'seller signs a v1 credential for the later gate window');

    await cliJson(['advance-time', '--seconds', '301'], stateDir);
    const tooHigh = await postJson(server.base, 'list', { role: seller, slot: 1, version: 1, priceWei: (facePrice + 1n).toString() });
    check(tooHigh.status === 409 && tooHigh.body.errorCode === 'RESALE_CAP_EXCEEDED', 'above-face listing is rejected with a stable error code');
    const listed = await postJson(server.base, 'list', { role: seller, slot: 1, version: 1, priceWei: resalePrice.toString() });
    check(listed.status === 200 && listed.body.txStatus === 'confirmed', 'valid capped listing commits');
    const buyRace = await Promise.all([
      postJson(server.base, 'buy', { role: buyer, slot: 1, version: 1, priceWei: resalePrice.toString() }),
      postJson(server.base, 'buy', { role: buyer, slot: 1, version: 1, priceWei: resalePrice.toString() }),
    ]);
    check(buyRace.filter((result) => result.status === 200 && result.body.txStatus === 'confirmed').length === 1 && buyRace.filter((result) => result.status === 409 && result.body.txStatus === 'rejected').length === 1, 'concurrent buyer requests produce exactly one resale');
    status = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(status.tickets[0].owner.toLowerCase() === status.roles[buyer].address.toLowerCase() && status.tickets[0].version === 2, 'resale owner and ticket version reconcile');

    await cliJson(['advance-time', '--seconds', '301'], stateDir);
    const stale = await postJson(server.base, 'gate/redeem', { scanId: `0x${'a'.repeat(64)}`, credential: oldCredential });
    check(stale.status === 409 && stale.body.errorCode === 'STALE_CREDENTIAL', `resale invalidates seller v1 gate credential (got HTTP ${stale.status}: ${JSON.stringify(stale.body)})`);
    const repeatedStale = await postJson(server.base, 'gate/redeem', { scanId: `0x${'a'.repeat(64)}`, credential: oldCredential });
    check(repeatedStale.status === 409 && repeatedStale.body.errorCode === 'ALREADY_ADMITTED', 'a scan ID cannot be submitted twice');
    const freshResponse = await postJson(server.base, 'credential/sign', { role: buyer, slot: 1, version: 2, expirySeconds: expiry });
    const fresh = freshResponse.body.credential;
    const admissionRace = await Promise.all([
      postJson(server.base, 'gate/redeem', { scanId: `0x${'b'.repeat(64)}`, credential: fresh }),
      postJson(server.base, 'gate/redeem', { scanId: `0x${'d'.repeat(64)}`, credential: fresh }),
    ]);
    check(admissionRace.filter((result) => result.status === 200 && result.body.gateDecision === 'ADMIT' && result.body.txStatus === 'confirmed').length === 1 && admissionRace.filter((result) => result.status === 409 && result.body.txStatus === 'rejected').length === 1, 'concurrent gate scans admit exactly once');
    const replay = await postJson(server.base, 'gate/redeem', { scanId: `0x${'c'.repeat(64)}`, credential: fresh });
    check(replay.status === 409 && replay.body.errorCode === 'ALREADY_ADMITTED', 'a second scan is rejected on chain');

    status = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(status.admittedCount === 1 && status.tickets[0].admitted, 'gate decision reconciles with one on-chain admission');
    check(BigInt(status.balanceWei) === facePrice + resalePrice, 'contract balance matches claim and resale credits');
    check(BigInt(status.roles.organiser.withdrawableWei) === facePrice && BigInt(status.roles[seller].withdrawableWei) === resalePrice, 'withdrawal credits reconcile with contract balance');
    const orgWithdraw = await postJson(server.base, 'withdraw', { role: 'organiser' });
    const sellerWithdraw = await postJson(server.base, 'withdraw', { role: seller });
    check(orgWithdraw.body.txStatus === 'confirmed' && sellerWithdraw.body.txStatus === 'confirmed', 'organiser and seller withdraw their own proceeds');
    status = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(status.balanceWei === '0' && BigInt(status.roles.organiser.withdrawableWei) === 0n && BigInt(status.roles[seller].withdrawableWei) === 0n, 'post-withdrawal balance and credits reconcile to zero');
    const alerts = await (await fetch(`${server.base}/api/organiser/alerts`)).json();
    check(Array.isArray(alerts.alerts) && alerts.alerts.every((item) => item.severity === 'review'), 'alerts API returns review-only signals');
    const alertRules = new Set(alerts.alerts.map((item) => item.rule));
    check(alertRules.has('REPEATED_ENTRY_SUBJECT') && alertRules.has('REPEATED_FAILED_SCAN'), 'activity alerts detect repeat-entry and repeat-failed-scan patterns');

    await stopChild(server.proc);
    server = startNext(serverPort, stateDir);
    await waitForPage(server.base, server.proc, server.logs);
    await ui.reload();
    check(await ui.getByLabel('Saved credential').inputValue() === '0', 'credential tray survives a Next.js server restart');
    const afterRestart = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(afterRestart.contract === deployed.contract && afterRestart.editionId === deployed.editionId, 'Next.js restart preserves demo contract state');

    const reset = await cliJson(['reset-demo'], stateDir);
    check(reset.reset && !fs.existsSync(statePath) && !fs.existsSync(path.join(stateDir, 'demo-fixture.json')), `explicit demo reset clears the generated local fixture and state (result ${JSON.stringify(reset)}, stateDir=${stateDir}, stateExists=${fs.existsSync(statePath)}, fixtureExists=${fs.existsSync(path.join(stateDir, 'demo-fixture.json'))})`);
    const codeAfterReset = await anvil.rpc('eth_getCode', [deployed.contract, 'latest']);
    check(codeAfterReset !== '0x', 'demo reset does not erase the live chain contract');

    const uiDeployment = await cliJson(['init-demo', '--rpc', anvil.endpoint, '--capacity', '1', '--entry-window', '120', '--claim-window', '300', '--resale-window', '300', '--gate-window', '600', '--face-price', facePrice.toString()], stateDir);
    check(uiDeployment.ok && uiDeployment.contract !== deployed.contract, 'fresh local deployment created for a full browser journey');
    const journeyContext = await browser.newContext();
    const journey = await journeyContext.newPage();
    await journey.goto(`${server.base}/fan`);

    await journey.getByLabel('Active demo role').selectOption('fanA');
    await journey.getByLabel('Demo subject').fill('ui-e2e-fan-a');
    let uiResult = await clickUiAction(journey, 'Enter event', 'enter');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'browser journey registers Fan A');
    await journey.getByLabel('Active demo role').selectOption('fanB');
    await journey.getByLabel('Demo subject').fill('ui-e2e-fan-b');
    uiResult = await clickUiAction(journey, 'Enter event', 'enter');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'browser journey registers Fan B');

    await journey.goto(`${server.base}/organiser`);
    uiResult = await clickUiAction(journey, 'Close entry and lock draw', 'organiser/advance-and-lock');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'organiser closes entry from the browser');
    uiResult = await clickUiAction(journey, 'Run draw', 'organiser/draw');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'organiser draws from the browser');
    const uiStatus = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    const uiWinner = uiStatus.winners[0].toLowerCase();
    const uiSeller = Object.entries(uiStatus.roles).find(([, account]) => account.address.toLowerCase() === uiWinner)?.[0];
    assert.ok(uiSeller === 'fanA' || uiSeller === 'fanB', 'browser journey winner must resolve to a demo fan');
    const uiBuyer = uiSeller === 'fanA' ? 'fanB' : 'fanA';
    const uiSellerLabel = uiSeller === 'fanA' ? 'Fan A' : 'Fan B';
    const uiBuyerLabel = uiBuyer === 'fanA' ? 'Fan A' : 'Fan B';

    await journey.goto(`${server.base}/fan`);
    await journey.getByLabel('Active demo role').selectOption(uiSeller);
    uiResult = await clickUiAction(journey, 'Claim reserved ticket', 'claim');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'winner claims the ticket from the browser');
    uiResult = await clickUiAction(journey, 'Sign and save credential', 'credential/sign');
    check(uiResult.status === 200 && uiResult.body.credential.version === 1, 'seller saves a browser v1 gate credential');
    await cliJson(['advance-time', '--seconds', '301'], stateDir);
    await journey.getByLabel('Price in wei').fill(resalePrice.toString());
    uiResult = await clickUiAction(journey, 'List for resale', 'list');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'seller lists the ticket from the browser');
    await journey.getByLabel('Active demo role').selectOption(uiBuyer);
    uiResult = await clickUiAction(journey, 'Buy listing', 'buy');
    check(uiResult.status === 200 && uiResult.body.txStatus === 'confirmed', 'buyer completes the resale from the browser');
    await journey.getByLabel('Ticket version').fill('2');
    uiResult = await clickUiAction(journey, 'Sign and save credential', 'credential/sign');
    check(uiResult.status === 200 && uiResult.body.credential.version === 2, 'buyer saves a browser v2 gate credential');
    await cliJson(['advance-time', '--seconds', '301'], stateDir);

    await journey.goto(`${server.base}/gate`);
    const savedCredentials = journey.getByLabel('Saved credential');
    await savedCredentials.selectOption({ label: `${uiSellerLabel} · v1` });
    uiResult = await clickUiAction(journey, 'Verify and redeem', 'gate/redeem');
    check(uiResult.status === 409 && uiResult.body.errorCode === 'STALE_CREDENTIAL', 'gate rejects the seller v1 credential in the browser');
    await savedCredentials.selectOption({ label: `${uiBuyerLabel} · v2` });
    uiResult = await clickUiAction(journey, 'Verify and redeem', 'gate/redeem');
    check(uiResult.status === 200 && uiResult.body.gateDecision === 'ADMIT' && uiResult.body.txStatus === 'confirmed', 'gate admits the buyer v2 credential in the browser');
    uiResult = await clickUiAction(journey, 'Verify and redeem', 'gate/redeem');
    check(uiResult.status === 409 && uiResult.body.txStatus === 'rejected', 'gate rejects a second browser scan');
    const uiFinalStatus = await (await fetch(`${server.base}/api/status`, { cache: 'no-store' })).json();
    check(uiFinalStatus.admittedCount === 1 && uiFinalStatus.tickets[0].owner.toLowerCase() === uiFinalStatus.roles[uiBuyer].address.toLowerCase(), 'full browser lifecycle reconciles owner and admission with chain state');
    await journeyContext.close();

    process.stdout.write('\nIntegration summary: all browser, web/API lifecycle, recovery, money, and restart checks passed.\n');
  } finally {
    if (browser) await browser.close();
    if (server) await stopChild(server.proc);
    if (proxy) {
      proxy.server.closeAllConnections?.();
      await new Promise((resolve) => proxy.server.close(() => resolve()));
    }
    if (anvil) anvil.stop();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
