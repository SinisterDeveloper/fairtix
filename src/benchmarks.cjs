const { join, resolve } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { ethers, signAttestation, signGateCredential } = require('./toolchain.cjs');
const { startAnvil } = require('./anvil.cjs');

const root = resolve(__dirname, '..');
const fairTicketsArtifact = JSON.parse(readFileSync(join(root, 'artifacts', 'FairTickets.json'), 'utf8'));
const rejectingArtifact = JSON.parse(readFileSync(join(root, 'artifacts', 'RejectingReceiver.json'), 'utf8'));
const iface = new ethers.Interface(fairTicketsArtifact.abi);
const rejectingIface = new ethers.Interface(rejectingArtifact.abi);

const CHAIN_ID = 31337;
const FACE_PRICE = 200_000n;
const FUND_AMOUNT_HEX = '0x' + (10n * 10n ** 18n).toString(16);

function makeWallet(seedIndex) {
  const pk = ethers.keccak256(ethers.solidityPacked(['string', 'uint256'], ['b2-benchmark-wallet', seedIndex]));
  return new ethers.Wallet(pk);
}

async function fundWallets(rpcBatch, addresses) {
  const chunkSize = 200;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    await rpcBatch(chunk.map((addr) => ['anvil_setBalance', [addr, FUND_AMOUNT_HEX]]));
  }
}

async function signTx(wallet, nonce, to, data, value = 0n, gasLimit = 300_000n) {
  return wallet.signTransaction({
    chainId: CHAIN_ID,
    type: 2,
    nonce,
    to: to || undefined,
    data,
    value,
    gasLimit,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
}

async function sendAndMineWaves(rpc, rpcBatch, signedTxs, waveSize = 80) {
  const hashes = [];
  for (let i = 0; i < signedTxs.length; i += waveSize) {
    const wave = signedTxs.slice(i, i + waveSize);
    const waveHashes = await rpcBatch(wave.map((raw) => ['eth_sendRawTransaction', [raw]]));
    await rpc('evm_mine');
    hashes.push(...waveHashes);
  }
  const receipts = [];
  const chunkSize = 200;
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const chunk = hashes.slice(i, i + chunkSize);
    const res = await rpcBatch(chunk.map((h) => ['eth_getTransactionReceipt', [h]]));
    receipts.push(...res);
  }
  return receipts;
}

async function sendOne(rpc, rpcBatch, wallet, nonce, to, data, value = 0n, gasLimit = 500_000n) {
  const raw = await signTx(wallet, nonce, to, data, value, gasLimit);
  const [receipt] = await sendAndMineWaves(rpc, rpcBatch, [raw], 1);
  return receipt;
}

async function deployFairTickets(rpc, rpcBatch, deployer, nonce, {
  organiser,
  attester,
  gate,
  capacity = 100n,
  facePrice = FACE_PRICE,
  editionId = ethers.hexlify(ethers.randomBytes(32)),
  entryWindow = 3600,
  claimDuration = 3600,
  resaleDuration = 3600,
  gateDuration = 3600,
}) {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const now = Number(BigInt(block.timestamp));
  const factory = new ethers.ContractFactory(fairTicketsArtifact.abi, fairTicketsArtifact.bytecode);
  const deployTx = await factory.getDeployTransaction(
    organiser,
    attester,
    gate,
    capacity,
    facePrice,
    editionId,
    BigInt(now + entryWindow),
    BigInt(claimDuration),
    BigInt(resaleDuration),
    BigInt(gateDuration)
  );
  const receipt = await sendOne(rpc, rpcBatch, deployer, nonce, null, deployTx.data, 0n, 4_000_000n);
  if (receipt.status !== '0x1') throw new Error('FairTickets deploy failed');
  return { address: receipt.contractAddress, editionId, entryDeadline: now + entryWindow };
}

function computeExpectedWinners(entrants, targetHash, contractAddress, capacity) {
  const n = entrants.length;
  const count = Math.min(n, capacity);
  const seed = ethers.solidityPackedKeccak256(
    ['bytes32', 'address', 'uint256'],
    [targetHash, contractAddress, BigInt(n)]
  );
  const fy = new Map();
  const winners = [];
  for (let i = 0; i < count; i++) {
    const r = BigInt(ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [seed, BigInt(i)]));
    const j = i + Number(r % BigInt(n - i));
    const idxI = fy.has(i) ? fy.get(i) : i;
    const idxJ = fy.has(j) ? fy.get(j) : j;
    fy.set(j, idxI);
    winners.push(entrants[idxJ]);
  }
  return winners;
}

async function advanceTime(rpc, seconds) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine');
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ============================================================================
// Benchmark 1: Fair allocation
// ============================================================================
async function benchmark1(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const dupWallet = makeWallet(5);
    const entrants = Array.from({ length: 1000 }, (_, i) => makeWallet(1000 + i));

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address, dupWallet.address,
      ...entrants.map((w) => w.address),
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 100n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);
    const expiry = 9999999999n;

    // 1000 unique entrants enter
    const enterTxs = await Promise.all(
      entrants.map(async (w, i) => {
        const subject = ethers.id(`subject-${i}`);
        const sig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subject, w.address, expiry);
        const data = iface.encodeFunctionData('enter', [subject, expiry, sig]);
        return signTx(w, 0, contractAddr, data, 0n, 250_000n);
      })
    );
    const enterReceipts = await sendAndMineWaves(rpc, rpcBatch, enterTxs, 80);
    assert(enterReceipts.every((r) => r.status === '0x1'), 'All 1000 unique entries must succeed');

    // Second wallet with attestation for same subject-0 must revert
    const dupSubject = ethers.id('subject-0');
    const dupSig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, dupSubject, dupWallet.address, expiry);
    const dupReceipt = await sendOne(
      rpc, rpcBatch, dupWallet, 0, contractAddr,
      iface.encodeFunctionData('enter', [dupSubject, expiry, dupSig]), 0n, 250_000n
    );
    assert(dupReceipt.status === '0x0', 'Second wallet with same subject must revert');
    assert(Number(await contract.entrantsCount()) === 1000, 'Entrants count must remain 1000');

    // Advance past entry deadline, test late entry fails
    await advanceTime(rpc, 3700);
    const lateWallet = makeWallet(6);
    await fundWallets(rpcBatch, [lateWallet.address]);
    const lateSubj = ethers.id('late-subject');
    const lateSig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, lateSubj, lateWallet.address, expiry);
    const lateReceipt = await sendOne(
      rpc, rpcBatch, lateWallet, 0, contractAddr,
      iface.encodeFunctionData('enter', [lateSubj, expiry, lateSig]), 0n, 250_000n
    );
    assert(lateReceipt.status === '0x0', 'Late entry after deadline must revert');

    // Lock draw, mine 3 blocks, draw
    const lockReceipt = await sendOne(rpc, rpcBatch, deployer, 1, contractAddr, iface.encodeFunctionData('lockDraw', []));
    assert(lockReceipt.status === '0x1', 'lockDraw must succeed');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');

    const drawReceipt = await sendOne(rpc, rpcBatch, deployer, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 12_000_000n);
    assert(drawReceipt.status === '0x1', 'draw must succeed');

    // No draw rerun
    const relockReceipt = await sendOne(rpc, rpcBatch, deployer, 3, contractAddr, iface.encodeFunctionData('lockDraw', []));
    const redrawReceipt = await sendOne(rpc, rpcBatch, deployer, 4, contractAddr, iface.encodeFunctionData('draw', []), 0n, 500_000n);
    assert(relockReceipt.status === '0x0' && redrawReceipt.status === '0x0', 'Draw rerun must revert');

    // Verify 100 distinct winners and independent Fisher-Yates verification
    const onChainWinners = await contract.getWinners();
    const targetHash = await contract.drawTargetHash();
    const uniqueWinners = new Set(onChainWinners.map((a) => a.toLowerCase()));
    assert(onChainWinners.length === 100 && uniqueWinners.size === 100, 'Must have 100 distinct winners');

    // Reconstruct frozen entrants list in mined on-chain order from Entered events
    const enteredLogs = [];
    for (const r of enterReceipts) {
      for (const l of r.logs) {
        if (l.address.toLowerCase() === contractAddr.toLowerCase()) {
          try {
            const parsed = iface.parseLog(l);
            if (parsed && parsed.name === 'Entered') {
              enteredLogs.push({ index: Number(parsed.args.index), wallet: parsed.args.wallet });
            }
          } catch {}
        }
      }
    }
    enteredLogs.sort((a, b) => a.index - b.index);
    const frozenEntrants = enteredLogs.map((e) => e.wallet);
    assert(frozenEntrants.length === 1000, 'Must have 1000 Entered events');

    const expectedWinners = computeExpectedWinners(
      frozenEntrants,
      targetHash,
      contractAddr,
      100
    );
    for (let i = 0; i < 100; i++) {
      assert(onChainWinners[i].toLowerCase() === expectedWinners[i].toLowerCase(), `Winner mismatch at index ${i}`);
    }

    // Losing wallet cannot claim
    const loser = entrants.find((w) => !uniqueWinners.has(w.address.toLowerCase()));
    const loserClaimReceipt = await sendOne(
      rpc, rpcBatch, loser, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE, 250_000n
    );
    assert(loserClaimReceipt.status === '0x0', 'Losing wallet claim must revert');

    return {
      pass: true,
      metrics: {
        entrants: 1000,
        winners: 100,
        uniqueWinners: uniqueWinners.size,
        drawGasUsed: Number(BigInt(drawReceipt.gasUsed)),
        independentDrawVerified: true,
      },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 2: Duplicate-entry resistance
// ============================================================================
async function benchmark2(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const wallets = Array.from({ length: 1000 }, (_, i) => makeWallet(2000 + i));

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address,
      ...wallets.map((w) => w.address),
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);
    const subject = ethers.id('single-verified-subject');
    const expiry = 9999999999n;

    // 1000 repeat requests for the SAME subject across 1000 distinct wallets
    const txs = await Promise.all(
      wallets.map(async (w) => {
        const sig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subject, w.address, expiry);
        return signTx(w, 0, contractAddr, iface.encodeFunctionData('enter', [subject, expiry, sig]), 0n, 250_000n);
      })
    );
    const receipts = await sendAndMineWaves(rpc, rpcBatch, txs, 100);
    const succeeded = receipts.filter((r) => r.status === '0x1').length;
    const failed = receipts.filter((r) => r.status === '0x0').length;
    const count = Number(await contract.entrantsCount());

    assert(succeeded === 1, `Expected 1 succeeded entry, got ${succeeded}`);
    assert(failed === 999, `Expected 999 rejected entries, got ${failed}`);
    assert(count === 1, `Expected on-chain entrantsCount == 1, got ${count}`);

    return {
      pass: true,
      metrics: { attempts: 1000, succeeded, rejected: failed, onChainEntrantsCount: count },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 3: No overselling
// ============================================================================
async function benchmark3(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const entrants = Array.from({ length: 1000 }, (_, i) => makeWallet(3000 + i));

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address,
      ...entrants.map((w) => w.address),
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 100n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);
    const expiry = 9999999999n;

    const enterTxs = await Promise.all(
      entrants.map(async (w, i) => {
        const subject = ethers.id(`b3-subj-${i}`);
        const sig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subject, w.address, expiry);
        return signTx(w, 0, contractAddr, iface.encodeFunctionData('enter', [subject, expiry, sig]), 0n, 250_000n);
      })
    );
    await sendAndMineWaves(rpc, rpcBatch, enterTxs, 100);
    await advanceTime(rpc, 3700);
    await sendOne(rpc, rpcBatch, deployer, 1, contractAddr, iface.encodeFunctionData('lockDraw', []));
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await sendOne(rpc, rpcBatch, deployer, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 12_000_000n);

    // Burst 1,000 concurrent claim() transactions (one from each registered wallet)
    const claimData = iface.encodeFunctionData('claim', []);
    const claimTxs = await Promise.all(
      entrants.map((w) => signTx(w, 1, contractAddr, claimData, FACE_PRICE, 250_000n))
    );
    const claimReceipts = await sendAndMineWaves(rpc, rpcBatch, claimTxs, 100);
    const sales = claimReceipts.filter((r) => r.status === '0x1');
    const losses = claimReceipts.filter((r) => r.status === '0x0');

    assert(sales.length === 100, `Expected 100 sales, got ${sales.length}`);
    assert(losses.length === 900, `Expected 900 losing claims, got ${losses.length}`);
    assert(Number(await contract.issuedCount()) === 100, 'issuedCount must be 100');
    assert((await contract.proceeds(organiser.address)) === 100n * FACE_PRICE, 'Organiser proceeds must equal 100 * facePrice');

    // Burst 10 retry attempts from each of the 100 winners (1,000 txs)
    const winnerAddrs = new Set((await contract.getWinners()).map((a) => a.toLowerCase()));
    const winners = entrants.filter((w) => winnerAddrs.has(w.address.toLowerCase()));
    const retryTxs = [];
    for (const w of winners) {
      for (let k = 0; k < 10; k++) {
        retryTxs.push(await signTx(w, 2 + k, contractAddr, claimData, FACE_PRICE, 250_000n));
      }
    }
    const retryReceipts = await sendAndMineWaves(rpc, rpcBatch, retryTxs, 100);
    const retrySuccess = retryReceipts.filter((r) => r.status === '0x1').length;
    assert(retrySuccess === 0, `Expected 0 retry sales, got ${retrySuccess}`);
    assert(Number(await contract.issuedCount()) === 100, 'issuedCount must remain 100 after retries');
    assert((await contract.proceeds(organiser.address)) === 100n * FACE_PRICE, 'Proceeds must remain 100 * facePrice');

    return {
      pass: true,
      metrics: {
        burstRequests: 1000,
        committedSales: sales.length,
        rejectedClaims: losses.length,
        winnerRetryAttempts: retryTxs.length,
        winnerRetrySales: retrySuccess,
        organiserProceedsWei: (await contract.proceeds(organiser.address)).toString(),
      },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 4: Resale price cap & atomic transfer + failed payout isolation
// ============================================================================
async function benchmark4(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const fanA = makeWallet(4001);
    const fanB = makeWallet(4002);
    const fanC = makeWallet(4003);
    const fanD = makeWallet(4004);
    const fanE = makeWallet(4005);

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address,
      fanA.address, fanB.address, fanC.address, fanD.address, fanE.address,
    ]);

    // Deploy RejectingReceiver as a contract entrant
    const rejFactory = new ethers.ContractFactory(rejectingArtifact.abi, rejectingArtifact.bytecode);
    const rejDeploy = await sendOne(rpc, rpcBatch, deployer, 0, null, (await rejFactory.getDeployTransaction()).data, 0n, 2_000_000n);
    const rejAddr = rejDeploy.contractAddress;

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 1, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 10n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);
    const expiry = 9999999999n;

    // Enter fanA..fanE and RejectingReceiver (6 entrants, capacity 10 => all 6 win)
    const allEntrants = [fanA, fanB, fanC, fanD];
    for (let i = 0; i < allEntrants.length; i++) {
      const w = allEntrants[i];
      const subj = ethers.id(`b4-${i}`);
      const sig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subj, w.address, expiry);
      await sendOne(rpc, rpcBatch, w, 0, contractAddr, iface.encodeFunctionData('enter', [subj, expiry, sig]));
    }
    // fanE is registered but we'll use fanE as buyer without claiming, wait: if capacity=10, all entrants win,
    // so fanE can still buy if fanE doesn't claim!
    {
      const subjE = ethers.id('b4-fanE');
      const sigE = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subjE, fanE.address, expiry);
      await sendOne(rpc, rpcBatch, fanE, 0, contractAddr, iface.encodeFunctionData('enter', [subjE, expiry, sigE]));
    }
    // Enter RejectingReceiver via deployer
    {
      const subjRej = ethers.id('b4-rej');
      const sigRej = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subjRej, rejAddr, expiry);
      await sendOne(
        rpc, rpcBatch, deployer, 2, rejAddr,
        rejectingIface.encodeFunctionData('callEnter', [contractAddr, subjRej, expiry, sigRej])
      );
    }

    await advanceTime(rpc, 3700);
    await sendOne(rpc, rpcBatch, deployer, 3, contractAddr, iface.encodeFunctionData('lockDraw', []));
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await sendOne(rpc, rpcBatch, deployer, 4, contractAddr, iface.encodeFunctionData('draw', []), 0n, 3_000_000n);

    // fanA, fanD, and RejectingReceiver claim their slots; fanB, fanC, fanE do NOT claim (stay ticketless buyers)
    const slotA = Number(await contract.winnerSlot(fanA.address));
    const slotD = Number(await contract.winnerSlot(fanD.address));
    const slotRej = Number(await contract.winnerSlot(rejAddr));
    await sendOne(rpc, rpcBatch, fanA, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);
    await sendOne(rpc, rpcBatch, fanD, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);
    await sendOne(rpc, rpcBatch, deployer, 5, rejAddr, rejectingIface.encodeFunctionData('callClaim', [contractAddr]), FACE_PRICE);

    // Move to RESALE window
    await advanceTime(rpc, 3700);

    // 1. Reject listing above face price
    const overCapReceipt = await sendOne(
      rpc, rpcBatch, fanA, 2, contractAddr, iface.encodeFunctionData('list', [BigInt(slotA), 1n, FACE_PRICE + 1n])
    );
    assert(overCapReceipt.status === '0x0', 'Listing above face price must revert');

    // 2. Discounted listing at 100,000 wei, reject mismatched buyer price, then buy as fanB
    const discPrice = 100_000n;
    assert(
      (await sendOne(rpc, rpcBatch, fanA, 3, contractAddr, iface.encodeFunctionData('list', [BigInt(slotA), 1n, discPrice]))).status === '0x1',
      'Discounted list must succeed'
    );
    const badPriceBuy = await sendOne(
      rpc, rpcBatch, fanB, 1, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotA), 1n, discPrice - 1n]), discPrice - 1n
    );
    assert(badPriceBuy.status === '0x0', 'Mismatched buyer price must revert');

    // Race: two buyers (fanB, fanC) for one listing -> one wins, one loses
    const buyTxB = await signTx(fanB, 2, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotA), 1n, discPrice]), discPrice);
    const buyTxC = await signTx(fanC, 1, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotA), 1n, discPrice]), discPrice);
    const raceReceipts = await sendAndMineWaves(rpc, rpcBatch, [buyTxB, buyTxC], 10);
    assert(raceReceipts.filter((r) => r.status === '0x1').length === 1, 'Only 1 buyer can win listing race');
    assert(raceReceipts.filter((r) => r.status === '0x0').length === 1, 'Second buyer in race must revert');

    // fanB now owns slotA at version 2 with paidPrice = 100,000
    const [ownerAfter1, verAfter1, paidAfter1] = await contract.getTicket(BigInt(slotA));
    assert(ownerAfter1.toLowerCase() === fanB.address.toLowerCase() && verAfter1 === 2n && paidAfter1 === discPrice, 'Ownership/version/paidPrice mismatch after 1st resale');

    // 3. fanB tries to relist at 150,000 (above paidPrice 100,000, below facePrice 200,000) -> MUST REVERT
    const abovePaidList = await sendOne(
      rpc, rpcBatch, fanB, 3, contractAddr, iface.encodeFunctionData('list', [BigInt(slotA), 2n, 150_000n])
    );
    assert(abovePaidList.status === '0x0', 'Relist above most recent paidPrice must revert');

    // 4. Lower-price onward resale: fanB lists at 50,000, fanC buys
    const onwardPrice = 50_000n;
    assert(
      (await sendOne(rpc, rpcBatch, fanB, 4, contractAddr, iface.encodeFunctionData('list', [BigInt(slotA), 2n, onwardPrice]))).status === '0x1',
      'Onward list at 50,000 must succeed'
    );
    assert(
      (await sendOne(rpc, rpcBatch, fanC, 2, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotA), 2n, onwardPrice]), onwardPrice)).status === '0x1',
      'Onward buy by fanC must succeed'
    );

    // 5. One buyer (fanC) trying to buy a second ticket (slotD) -> MUST REVERT
    await sendOne(rpc, rpcBatch, fanD, 2, contractAddr, iface.encodeFunctionData('list', [BigInt(slotD), 1n, FACE_PRICE]));
    const secondTicketBuy = await sendOne(
      rpc, rpcBatch, fanC, 3, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotD), 1n, FACE_PRICE]), FACE_PRICE
    );
    assert(secondTicketBuy.status === '0x0', 'Buyer already holding a ticket must not be able to buy another');

    // 6. Failed payout attempt cannot block settlement or change ownership
    await sendOne(
      rpc, rpcBatch, deployer, 6, rejAddr,
      rejectingIface.encodeFunctionData('callList', [contractAddr, BigInt(slotRej), 1n, FACE_PRICE])
    );
    const buyFromRej = await sendOne(
      rpc, rpcBatch, fanE, 1, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotRej), 1n, FACE_PRICE]), FACE_PRICE
    );
    assert(buyFromRej.status === '0x1', 'Buy from rejecting seller must succeed via pull-payment');
    const failedWithdraw = await sendOne(
      rpc, rpcBatch, deployer, 7, rejAddr, rejectingIface.encodeFunctionData('callWithdraw', [contractAddr])
    );
    assert(failedWithdraw.status === '0x0', 'RejectingReceiver withdraw must revert');
    const [rejSlotOwnerAfter] = await contract.getTicket(BigInt(slotRej));
    assert(rejSlotOwnerAfter.toLowerCase() === fanE.address.toLowerCase(), 'Failed payout must not change buyer ownership');

    return {
      pass: true,
      metrics: {
        aboveFaceRejected: true,
        aboveLastPaidRejected: true,
        mismatchedPriceRejected: true,
        twoBuyersOneListingRaceResolved: true,
        oneBuyerTwoTicketsRejected: true,
        failedPayoutIsolated: true,
      },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 5: Credential invalidation (A -> B and A -> B -> A)
// ============================================================================
async function benchmark5(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const fanA = makeWallet(5001);
    const fanB = makeWallet(5002);
    const fanC = makeWallet(5003);
    const fanD = makeWallet(5004);

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address,
      fanA.address, fanB.address, fanC.address, fanD.address,
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 10n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);
    const attExpiry = 9999999999n;

    for (const [i, w] of [fanA, fanB, fanC, fanD].entries()) {
      const subj = ethers.id(`b5-${i}`);
      const sig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subj, w.address, attExpiry);
      await sendOne(rpc, rpcBatch, w, 0, contractAddr, iface.encodeFunctionData('enter', [subj, attExpiry, sig]));
    }

    await advanceTime(rpc, 3700);
    await sendOne(rpc, rpcBatch, deployer, 1, contractAddr, iface.encodeFunctionData('lockDraw', []));
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await sendOne(rpc, rpcBatch, deployer, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 3_000_000n);

    // fanA claims slotA, fanC claims slotC; fanB and fanD stay ticketless
    const slotA = Number(await contract.winnerSlot(fanA.address));
    const slotC = Number(await contract.winnerSlot(fanC.address));
    await sendOne(rpc, rpcBatch, fanA, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);
    await sendOne(rpc, rpcBatch, fanC, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);

    // Compute future gate timestamp so signatures are valid in GATE window
    const resaleCutoff = Number(await contract.resaleCutoff());
    const gateExpiry = BigInt(resaleCutoff + 60);

    // Sign as A (v1) and C (v1) BEFORE transfers
    const staleSigA = await signGateCredential(fanA, CHAIN_ID, contractAddr, editionId, BigInt(slotA), 1n, gateExpiry);
    const staleSigC = await signGateCredential(fanC, CHAIN_ID, contractAddr, editionId, BigInt(slotC), 1n, gateExpiry);

    await advanceTime(rpc, 3700); // enter RESALE

    // Transfer 1: A -> B (slotA becomes v2, owner B)
    await sendOne(rpc, rpcBatch, fanA, 2, contractAddr, iface.encodeFunctionData('list', [BigInt(slotA), 1n, FACE_PRICE]));
    await sendOne(rpc, rpcBatch, fanB, 1, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotA), 1n, FACE_PRICE]), FACE_PRICE);

    // Transfer 2: C -> D -> C (slotC becomes v3, owner C again)
    await sendOne(rpc, rpcBatch, fanC, 2, contractAddr, iface.encodeFunctionData('list', [BigInt(slotC), 1n, FACE_PRICE]));
    await sendOne(rpc, rpcBatch, fanD, 1, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotC), 1n, FACE_PRICE]), FACE_PRICE);
    await sendOne(rpc, rpcBatch, fanD, 2, contractAddr, iface.encodeFunctionData('list', [BigInt(slotC), 2n, FACE_PRICE]));
    await sendOne(rpc, rpcBatch, fanC, 3, contractAddr, iface.encodeFunctionData('buy', [BigInt(slotC), 2n, FACE_PRICE]), FACE_PRICE);

    await advanceTime(rpc, 3550); // enter GATE at t0 + 7250 (within gateExpiry = resaleCutoff + 60)

    // Reject A's stale v1 credential, accept B's fresh v2 credential
    const rStaleA = await sendOne(
      rpc, rpcBatch, gate, 0, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, gateExpiry, staleSigA, ethers.id('scan-a-stale')])
    );
    assert(rStaleA.status === '0x0', 'A stale credential must be rejected');

    const freshSigB = await signGateCredential(fanB, CHAIN_ID, contractAddr, editionId, BigInt(slotA), 2n, gateExpiry);
    const rFreshB = await sendOne(
      rpc, rpcBatch, gate, 1, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 2n, gateExpiry, freshSigB, ethers.id('scan-b-fresh')])
    );
    assert(rFreshB.status === '0x1', 'B fresh credential must be admitted');

    // Reject C's original v1 credential even though C is owner again at v3; accept C's v3 credential
    const rStaleC = await sendOne(
      rpc, rpcBatch, gate, 2, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotC), 1n, gateExpiry, staleSigC, ethers.id('scan-c-stale')])
    );
    assert(rStaleC.status === '0x0', 'C original v1 credential after C->D->C must be rejected');

    const freshSigC3 = await signGateCredential(fanC, CHAIN_ID, contractAddr, editionId, BigInt(slotC), 3n, gateExpiry);
    const rFreshC3 = await sendOne(
      rpc, rpcBatch, gate, 3, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotC), 3n, gateExpiry, freshSigC3, ethers.id('scan-c-v3')])
    );
    assert(rFreshC3.status === '0x1', 'C fresh v3 credential must be admitted');

    return {
      pass: true,
      metrics: {
        aToBStaleRejected: true,
        bFreshAdmitted: true,
        aToBToAOriginalRejected: true,
        aToBToAFreshAdmitted: true,
        admittedCount: Number(await contract.admittedCount()),
      },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 6: Forgery rejection
// ============================================================================
async function benchmark6(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const fanA = makeWallet(6001);
    const rogue = makeWallet(6002);

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address, fanA.address, rogue.address,
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 10n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);

    const subj = ethers.id('b6-fanA');
    const attSig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subj, fanA.address, 9999999999n);
    await sendOne(rpc, rpcBatch, fanA, 0, contractAddr, iface.encodeFunctionData('enter', [subj, 9999999999n, attSig]));

    await advanceTime(rpc, 3700);
    await sendOne(rpc, rpcBatch, deployer, 1, contractAddr, iface.encodeFunctionData('lockDraw', []));
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await sendOne(rpc, rpcBatch, deployer, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 3_000_000n);

    const slotA = Number(await contract.winnerSlot(fanA.address));
    await sendOne(rpc, rpcBatch, fanA, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);

    await advanceTime(rpc, 7400); // enter GATE
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const validExpiry = BigInt(Number(BigInt(block.timestamp)) + 60);
    const validSig = await signGateCredential(fanA, CHAIN_ID, contractAddr, editionId, BigInt(slotA), 1n, validExpiry);

    // 1. Unknown slot (999)
    const rUnknownSlot = await sendOne(
      rpc, rpcBatch, gate, 0, contractAddr,
      iface.encodeFunctionData('redeem', [999n, 1n, validExpiry, validSig, ethers.id('f1')])
    );
    // 2. Tampered signature
    const badSig = validSig.slice(0, -2) + (validSig.endsWith('00') ? '01' : '00');
    const rBadSig = await sendOne(
      rpc, rpcBatch, gate, 1, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, validExpiry, badSig, ethers.id('f2')])
    );
    // 3. Tampered payload (different expiry with original sig)
    const rTamperedPayload = await sendOne(
      rpc, rpcBatch, gate, 2, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, validExpiry + 1n, validSig, ethers.id('f3')])
    );
    // 4. Valid signature for a DIFFERENT editionId / contract / chain
    const wrongEditionSig = await signGateCredential(
      fanA, CHAIN_ID, contractAddr, ethers.id('wrong-edition'), BigInt(slotA), 1n, validExpiry
    );
    const rWrongEdition = await sendOne(
      rpc, rpcBatch, gate, 3, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, validExpiry, wrongEditionSig, ethers.id('f4')])
    );
    const wrongChainSig = await signGateCredential(
      fanA, 99999, contractAddr, editionId, BigInt(slotA), 1n, validExpiry
    );
    const rWrongChain = await sendOne(
      rpc, rpcBatch, gate, 4, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, validExpiry, wrongChainSig, ethers.id('f5')])
    );
    // 5. Non-gate wallet attempting to redeem with valid signature
    const rNonGate = await sendOne(
      rpc, rpcBatch, rogue, 0, contractAddr,
      iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, validExpiry, validSig, ethers.id('f6')])
    );

    assert(rUnknownSlot.status === '0x0', 'Unknown slot must revert');
    assert(rBadSig.status === '0x0', 'Tampered signature must revert');
    assert(rTamperedPayload.status === '0x0', 'Tampered payload must revert');
    assert(rWrongEdition.status === '0x0', 'Wrong edition signature must revert');
    assert(rWrongChain.status === '0x0', 'Wrong chain signature must revert');
    assert(rNonGate.status === '0x0', 'Non-gate wallet must revert');
    assert(Number(await contract.admittedCount()) === 0, 'admittedCount must remain 0');

    return {
      pass: true,
      metrics: {
        forgeriesTested: 6,
        allRejected: true,
        admittedCount: 0,
      },
    };
  } finally {
    anvil.stop();
  }
}

// ============================================================================
// Benchmark 7: One-time admission (100 concurrent scans of same credential)
// ============================================================================
async function benchmark7(port) {
  const anvil = await startAnvil({ port, noMining: true });
  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const deployer = makeWallet(1);
    const organiser = makeWallet(2);
    const attester = makeWallet(3);
    const gate = makeWallet(4);
    const fanA = makeWallet(7001);

    await fundWallets(rpcBatch, [
      deployer.address, organiser.address, attester.address, gate.address, fanA.address,
    ]);

    const { address: contractAddr, editionId } = await deployFairTickets(rpc, rpcBatch, deployer, 0, {
      organiser: organiser.address,
      attester: attester.address,
      gate: gate.address,
      capacity: 10n,
    });
    const contract = new ethers.Contract(contractAddr, fairTicketsArtifact.abi, provider);

    const subj = ethers.id('b7-fanA');
    const attSig = await signAttestation(attester, CHAIN_ID, contractAddr, editionId, subj, fanA.address, 9999999999n);
    await sendOne(rpc, rpcBatch, fanA, 0, contractAddr, iface.encodeFunctionData('enter', [subj, 9999999999n, attSig]));

    await advanceTime(rpc, 3700);
    await sendOne(rpc, rpcBatch, deployer, 1, contractAddr, iface.encodeFunctionData('lockDraw', []));
    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');
    await sendOne(rpc, rpcBatch, deployer, 2, contractAddr, iface.encodeFunctionData('draw', []), 0n, 3_000_000n);

    const slotA = Number(await contract.winnerSlot(fanA.address));
    await sendOne(rpc, rpcBatch, fanA, 1, contractAddr, iface.encodeFunctionData('claim', []), FACE_PRICE);

    await advanceTime(rpc, 7400); // enter GATE
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const expiry = BigInt(Number(BigInt(block.timestamp)) + 60);
    const ownerSig = await signGateCredential(fanA, CHAIN_ID, contractAddr, editionId, BigInt(slotA), 1n, expiry);

    // 100 concurrent scan attempts with consecutive nonces 0..99 and distinct scanIds
    const scanTxs = [];
    for (let i = 0; i < 100; i++) {
      const scanId = ethers.id(`concurrent-scan-${i}`);
      const data = iface.encodeFunctionData('redeem', [BigInt(slotA), 1n, expiry, ownerSig, scanId]);
      scanTxs.push(await signTx(gate, i, contractAddr, data, 0n, 200_000n));
    }
    const receipts = await sendAndMineWaves(rpc, rpcBatch, scanTxs, 100);
    const admitted = receipts.filter((r) => r.status === '0x1');
    const denied = receipts.filter((r) => r.status === '0x0');

    assert(admitted.length === 1, `Expected 1 admission, got ${admitted.length}`);
    assert(denied.length === 99, `Expected 99 denials, got ${denied.length}`);
    assert(Number(await contract.admittedCount()) === 1, 'admittedCount must be 1');
    const [, , , isAdmitted] = await contract.getTicket(BigInt(slotA));
    assert(isAdmitted === true, 'Ticket must be marked admitted');

    const admittedGas = Number(BigInt(admitted[0].gasUsed));
    const failedGasTotal = denied.reduce((acc, r) => acc + Number(BigInt(r.gasUsed)), 0);

    return {
      pass: true,
      metrics: {
        concurrentScans: 100,
        admitted: admitted.length,
        denied: denied.length,
        admittedGas,
        failedGasTotal,
      },
    };
  } finally {
    anvil.stop();
  }
}

async function main() {
  const benchmarks = [
    { id: 1, name: 'Fair allocation', severity: 'Critical', fn: () => benchmark1(19501) },
    { id: 2, name: 'Duplicate-entry resistance', severity: 'Critical', fn: () => benchmark2(19502) },
    { id: 3, name: 'No overselling', severity: 'Critical', fn: () => benchmark3(19503) },
    { id: 4, name: 'Resale price cap', severity: 'Critical', fn: () => benchmark4(19504) },
    { id: 5, name: 'Credential invalidation', severity: 'High', fn: () => benchmark5(19505) },
    { id: 6, name: 'Forgery rejection', severity: 'High', fn: () => benchmark6(19506) },
    { id: 7, name: 'One-time admission', severity: 'Critical', fn: () => benchmark7(19507) },
  ];

  const results = [];
  for (const b of benchmarks) {
    const start = performance.now();
    try {
      const res = await b.fn();
      const durationMs = Math.round(performance.now() - start);
      results.push({ id: b.id, name: b.name, severity: b.severity, pass: res.pass, durationMs, metrics: res.metrics });
      console.log(`[PASS] #${b.id} ${b.name} (${durationMs} ms) -> ${JSON.stringify(res.metrics)}`);
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      results.push({ id: b.id, name: b.name, severity: b.severity, pass: false, durationMs, error: err.message });
      console.error(`[FAIL] #${b.id} ${b.name} (${durationMs} ms) -> ${err.message}`);
    }
  }

  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts', 'benchmark-results.json'), JSON.stringify(results, null, 2));

  const mdLines = [
    '# FairTickets — Seven-Benchmark Results',
    '',
    `Run timestamp: ${new Date().toISOString()}`,
    `Chain: Anvil 1.7.1 (chainId 31337, shanghai, 30M gas limit)`,
    `Contract codeHash: \`${fairTicketsArtifact.deployedBytecodeHash}\``,
    '',
    '| # | Benchmark | Severity | Result | Duration | Key Metrics |',
    '|---|---|---|---|---|---|',
    ...results.map((r) =>
      `| ${r.id} | ${r.name} | ${r.severity} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.durationMs} ms | \`${JSON.stringify(r.metrics || r.error)}\` |`
    ),
  ];
  writeFileSync(join(root, 'artifacts', 'benchmark-report.md'), mdLines.join('\n') + '\n');

  const allPassed = results.every((r) => r.pass);
  console.log(`\nSummary: ${results.filter((r) => r.pass).length}/${results.length} benchmarks passed.`);
  if (!allPassed) process.exit(1);
}

main();
