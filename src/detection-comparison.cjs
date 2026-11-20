const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { startAnvil } = require('./anvil.cjs');
const { ethers, signAttestation } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const artifact = JSON.parse(readFileSync(join(root, 'artifacts', 'FairTickets.json'), 'utf8'));
const iface = new ethers.Interface(artifact.abi);

const CHAIN_ID = 31337;
const CAPACITY = 10;
const FACE_PRICE_WEI = 200_000n;
const FUND_HEX = '0x' + (10n * 10n ** 18n).toString(16);

function deterministicWallet(tag, idx) {
  const pk = ethers.keccak256(ethers.solidityPacked(['string', 'uint256'], [tag, idx]));
  return new ethers.Wallet(pk);
}

function buildScenarioInputs() {
  const arrivals = [];
  // 10 repeated-entrant bot subjects (5 distinct wallets/attempts each = 50)
  // 10 legitimate shared-Wi-Fi fans (1 attempt each = 10, all sharing shared-wifi-campus-1)
  // 10 legitimate standard fans (1 attempt each = 10, distinct home networks)
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 10; i++) {
      arrivals.push({
        group: 'repeated_entrant_bots',
        participantId: `bot-${i}`,
        subjectLabel: `compare-bot-subject-${i}`,
        attemptNumber: round + 1,
        networkGroup: `bot-proxy-${i % 3}`,
        wallet: deterministicWallet('b2-compare-bot-wallet', i * 10 + round),
      });
      if (round === 0) {
        arrivals.push({
          group: 'shared_wifi_fans',
          participantId: `wifi-${i}`,
          subjectLabel: `compare-wifi-fan-${i}`,
          attemptNumber: 1,
          networkGroup: 'shared-wifi-campus-1',
          wallet: deterministicWallet('b2-compare-wifi-wallet', i),
        });
        arrivals.push({
          group: 'standard_fans',
          participantId: `std-${i}`,
          subjectLabel: `compare-std-fan-${i}`,
          attemptNumber: 1,
          networkGroup: `home-net-${i}`,
          wallet: deterministicWallet('b2-compare-std-wallet', i),
        });
      }
    }
  }
  return arrivals;
}

function runSeededFisherYates({ entries, targetHash, contractAddress, capacity, start, end }) {
  const n = entries.length;
  const count = Math.min(n, capacity);
  const pool = entries.slice();
  if (end !== 0 && end > count) {
    const seed = ethers.solidityPackedKeccak256(
      ['bytes32', 'address', 'uint256'],
      [targetHash, contractAddress, BigInt(n)]
    );
    for (let i = start; i < count; i++) {
      const r = BigInt(ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [seed, BigInt(i)]));
      const j = i + Number(r % BigInt(end - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  return pool.slice(0, count);
}

function summarizeGroups(arrivals, eligibleEntries, winners, flaggedSubjectSet, deniedParticipantsSet) {
  const groupNames = ['repeated_entrant_bots', 'shared_wifi_fans', 'standard_fans'];
  const summary = {};
  for (const groupName of groupNames) {
    const groupArrivals = arrivals.filter((a) => a.group === groupName);
    const participants = new Set(groupArrivals.map((a) => a.participantId));
    const eligibleForGroup = eligibleEntries.filter((e) => e.group === groupName);
    const eligibleParticipantSet = new Set(eligibleForGroup.map((e) => e.participantId));
    const winnersForGroup = winners.filter((w) => w.group === groupName);
    const flaggedParticipants = new Set(
      groupArrivals.filter((a) => flaggedSubjectSet.has(a.subjectLabel)).map((a) => a.participantId)
    );
    const deniedCount = [...participants].filter((pid) => deniedParticipantsSet.has(pid)).length;
    summary[groupName] = {
      participantsTotal: participants.size,
      attemptsTotal: groupArrivals.length,
      flaggedForReview: flaggedParticipants.size,
      eligibleParticipants: eligibleParticipantSet.size,
      eligibleQueueEntries: eligibleForGroup.length,
      deniedParticipants: deniedCount,
      ticketsAllocated: winnersForGroup.length,
    };
  }
  return summary;
}

function evaluateFairTicketsAlerts(arrivals) {
  const subjectCounts = new Map();
  for (const item of arrivals) {
    subjectCounts.set(item.subjectLabel, (subjectCounts.get(item.subjectLabel) || 0) + 1);
  }
  const flaggedSubjects = new Set();
  for (const [subjectLabel, count] of subjectCounts) {
    if (count >= 3) flaggedSubjects.add(subjectLabel);
  }
  const burstAlertTriggered = arrivals.length >= 5;
  return {
    flaggedSubjects,
    burstAlertTriggered,
    reviewSignalsNeverAutoBlock: true,
  };
}

function simulateCounterfactual({ arrivals, mode, drawTargetHash, contractAddress }) {
  const seenWallets = new Set();
  const seenSubjects = new Set();
  const networkAccepted = new Map();
  const eligibleEntries = [];
  const deniedParticipants = new Set();

  for (const item of arrivals) {
    const addr = item.wallet.address.toLowerCase();
    if (seenWallets.has(addr)) continue;

    if (mode === 'no_subject_dedup') {
      // Removes contract subjectEntered uniqueness; distinct wallets enter unchecked.
      seenWallets.add(addr);
      eligibleEntries.push(item);
      continue;
    }

    if (mode === 'naive_shared_ip_autoblock') {
      if (seenSubjects.has(item.subjectLabel)) continue;
      const netCount = networkAccepted.get(item.networkGroup) || 0;
      if (netCount >= 2) {
        deniedParticipants.add(item.participantId);
        continue;
      }
      seenSubjects.add(item.subjectLabel);
      seenWallets.add(addr);
      networkAccepted.set(item.networkGroup, netCount + 1);
      eligibleEntries.push(item);
      continue;
    }

    throw new Error(`Unknown simulation mode: ${mode}`);
  }

  const end = eligibleEntries.length > CAPACITY ? eligibleEntries.length : 0;
  const winners = runSeededFisherYates({
    entries: eligibleEntries,
    targetHash: drawTargetHash,
    contractAddress,
    capacity: CAPACITY,
    start: 0,
    end,
  });

  const { flaggedSubjects, burstAlertTriggered } = evaluateFairTicketsAlerts(arrivals);
  return {
    eligibleEntries,
    winners,
    flaggedSubjects,
    burstAlertTriggered,
    groups: summarizeGroups(arrivals, eligibleEntries, winners, flaggedSubjects, deniedParticipants),
  };
}

async function signTx(wallet, nonce, to, data, gasLimit = 250_000n) {
  return wallet.signTransaction({
    chainId: CHAIN_ID,
    type: 2,
    nonce,
    to: to || undefined,
    data,
    value: 0n,
    gasLimit,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
}

function renderMarkdown(report) {
  const rows = [];
  const order = [
    ['fairtickets_enforced', 'FairTickets (Contract Enforced + Review Alerts)'],
    ['baseline_no_subject_dedup', 'Baseline: No On-Chain Subject Uniqueness'],
    ['baseline_naive_shared_ip_autoblock', 'Baseline: Naive Shared-IP Cap (max 2 / network)'],
  ];
  for (const [key, title] of order) {
    const run = report.runs[key];
    rows.push(`### ${title}`);
    rows.push('');
    rows.push(`- **Execution:** ${run.executionMode}`);
    rows.push(`- **Differing rule:** ${run.differingRule}`);
    rows.push(`- **Queue entries / Allocated slots:** ${run.totalQueueEntries} / ${run.totalTicketsAllocated}`);
    rows.push('');
    rows.push('| Group | Flagged (Review) | Eligible Participants | Queue Entries | Denied | Tickets Allocated |');
    rows.push('|---|---|---|---|---|---|');
    for (const [groupKey, label] of [
      ['repeated_entrant_bots', 'Repeated Entrant Bots (10 subj, 50 attempts)'],
      ['shared_wifi_fans', 'Shared-Wi-Fi Controls (10 fans, 10 attempts)'],
      ['standard_fans', 'Standard Fans (10 fans, 10 attempts)'],
    ]) {
      const g = run.groups[groupKey];
      rows.push(
        `| ${label} | ${g.flaggedForReview}/${g.participantsTotal} | ${g.eligibleParticipants}/${g.participantsTotal} | ${g.eligibleQueueEntries} | ${g.deniedParticipants}/${g.participantsTotal} | ${g.ticketsAllocated}/${run.totalTicketsAllocated} |`
      );
    }
    rows.push('');
  }

  return [
    '# FairTickets — Seeded Detection & Allocation Comparison (D1-DEMO-5)',
    '',
    `> **Label:** ${report.label}  `,
    `> **Capacity:** ${report.capacity} slots · **Draw target hash:** \`${report.drawTargetHash}\` · **Contract codeHash:** \`${report.runtimeCodeHash}\``,
    '',
    rows.join('\n'),
  ].join('\n');
}

async function main() {
  const writeArtifacts = process.argv.includes('--write');
  const tempStateDir = mkdtempSync(join(tmpdir(), 'fairtickets-compare-'));
  const port = Number(process.env.FAIRTICKETS_COMPARE_PORT || 8558);
  const anvil = await startAnvil({ port, chainId: CHAIN_ID, noMining: true });

  try {
    const { rpc, rpcBatch, endpoint } = anvil;
    const provider = new ethers.JsonRpcProvider(endpoint);
    const arrivals = buildScenarioInputs();
    const organiser = deterministicWallet('b2-compare-role', 1);
    const attester = deterministicWallet('b2-compare-role', 2);
    const gate = deterministicWallet('b2-compare-role', 3);

    const addresses = [organiser.address, attester.address, gate.address, ...arrivals.map((a) => a.wallet.address)];
    for (let i = 0; i < addresses.length; i += 200) {
      await rpcBatch(addresses.slice(i, i + 200).map((addr) => ['anvil_setBalance', [addr, FUND_HEX]]));
    }

    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const now = Number(BigInt(block.timestamp));
    const editionId = ethers.id('fairtickets-d1-demo-5-comparison-seed-v1');
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
    const deployTx = await factory.getDeployTransaction(
      organiser.address,
      attester.address,
      gate.address,
      BigInt(CAPACITY),
      FACE_PRICE_WEI,
      editionId,
      BigInt(now + 3600),
      3600n,
      3600n,
      3600n
    );
    const rawDeploy = await signTx(organiser, 0, null, deployTx.data, 4_000_000n);
    const [deployHash] = await rpcBatch([['eth_sendRawTransaction', [rawDeploy]]]);
    await rpc('evm_mine');
    const deployReceipt = await rpc('eth_getTransactionReceipt', [deployHash]);
    assert.equal(deployReceipt.status, '0x1', 'Comparison contract deploy must succeed');

    const contractAddress = deployReceipt.contractAddress;
    const runtimeCode = await rpc('eth_getCode', [contractAddress, 'latest']);
    const runtimeCodeHash = ethers.keccak256(runtimeCode);
    const contract = new ethers.Contract(contractAddress, artifact.abi, provider);
    const expiry = 9999999999n;

    // Sign and submit all 70 arrivals in one single block so allocation enters a single boundary lottery batch
    const signedEntries = await Promise.all(
      arrivals.map(async (item) => {
        const subject = ethers.id(item.subjectLabel);
        const sig = await signAttestation(attester, CHAIN_ID, contractAddress, editionId, subject, item.wallet.address, expiry);
        const data = iface.encodeFunctionData('enter', [subject, expiry, sig]);
        return signTx(item.wallet, 0, contractAddress, data, 250_000n);
      })
    );
    const txHashes = await rpcBatch(signedEntries.map((raw) => ['eth_sendRawTransaction', [raw]]));
    await rpc('evm_mine');
    const receipts = await rpcBatch(txHashes.map((h) => ['eth_getTransactionReceipt', [h]]));

    const arrivalByWallet = new Map(arrivals.map((a) => [a.wallet.address.toLowerCase(), a]));
    const onChainEntries = [];
    const entryBlockNumbers = new Set();
    for (const receipt of receipts) {
      assert.ok(receipt, 'Missing comparison receipt');
      if (receipt.status === '0x1') {
        entryBlockNumbers.add(receipt.blockNumber);
        for (const l of receipt.logs) {
          if (l.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(l);
            if (parsed && parsed.name === 'Entered') {
              const matched = arrivalByWallet.get(parsed.args.wallet.toLowerCase());
              onChainEntries.push({ index: Number(parsed.args.index), item: matched });
            }
          } catch {}
        }
      }
    }
    onChainEntries.sort((a, b) => a.index - b.index);
    const orderedOnChainItems = onChainEntries.map((x) => x.item);

    assert.equal(entryBlockNumbers.size, 1, 'All 30 valid entries must mine into one shared launch block');
    assert.equal(orderedOnChainItems.length, 30, 'Contract must admit exactly 30 unique subjects across 70 attempts');

    // Close entry, lock draw, mine target window, draw
    await rpc('evm_increaseTime', [3700]);
    await rpc('evm_mine');
    const rawLock = await signTx(organiser, 1, contractAddress, iface.encodeFunctionData('lockDraw', []));
    const [lockHash] = await rpcBatch([['eth_sendRawTransaction', [rawLock]]]);
    await rpc('evm_mine');
    const lockReceipt = await rpc('eth_getTransactionReceipt', [lockHash]);
    assert.equal(lockReceipt.status, '0x1', 'lockDraw must succeed');
    assert.equal(Number(await contract.lotteryStart()), 0, 'lotteryStart should be 0');
    assert.equal(Number(await contract.lotteryEnd()), 30, 'lotteryEnd should be 30');

    await rpc('evm_mine');
    await rpc('evm_mine');
    await rpc('evm_mine');

    const rawDraw = await signTx(organiser, 2, contractAddress, iface.encodeFunctionData('draw', []), 12_000_000n);
    const [drawHash] = await rpcBatch([['eth_sendRawTransaction', [rawDraw]]]);
    await rpc('evm_mine');
    const drawReceipt = await rpc('eth_getTransactionReceipt', [drawHash]);
    assert.equal(drawReceipt.status, '0x1', 'draw must succeed');

    const drawTargetHash = await contract.drawTargetHash();
    const onChainWinners = await contract.getWinners();
    const expectedOnChainWinners = runSeededFisherYates({
      entries: orderedOnChainItems,
      targetHash: drawTargetHash,
      contractAddress,
      capacity: CAPACITY,
      start: 0,
      end: 30,
    });
    assert.equal(onChainWinners.length, CAPACITY, 'Must allocate exact capacity winners');
    for (let i = 0; i < CAPACITY; i++) {
      assert.equal(
        onChainWinners[i].toLowerCase(),
        expectedOnChainWinners[i].wallet.address.toLowerCase(),
        `Independent Fisher-Yates mismatch at slot ${i + 1}`
      );
    }

    const alertsEval = evaluateFairTicketsAlerts(arrivals);
    const fairTicketsGroups = summarizeGroups(
      arrivals,
      orderedOnChainItems,
      expectedOnChainWinners,
      alertsEval.flaggedSubjects,
      new Set()
    );

    const noDedupSim = simulateCounterfactual({
      arrivals,
      mode: 'no_subject_dedup',
      drawTargetHash,
      contractAddress,
    });

    const naiveIpSim = simulateCounterfactual({
      arrivals,
      mode: 'naive_shared_ip_autoblock',
      drawTargetHash,
      contractAddress,
    });

    // Core assertions comparing FairTickets vs Baselines
    assert.equal(fairTicketsGroups.repeated_entrant_bots.eligibleQueueEntries, 10, 'FairTickets limits bots to 1 entry per subject');
    assert.equal(fairTicketsGroups.repeated_entrant_bots.flaggedForReview, 10, 'All 10 repeated bots flagged for review');
    assert.equal(fairTicketsGroups.shared_wifi_fans.eligibleParticipants, 10, 'FairTickets admits all 10 shared-Wi-Fi fans');
    assert.equal(fairTicketsGroups.shared_wifi_fans.deniedParticipants, 0, 'FairTickets denies 0 shared-Wi-Fi fans');

    assert.equal(noDedupSim.groups.repeated_entrant_bots.eligibleQueueEntries, 50, 'No-dedup baseline lets all 50 bot wallets into queue');
    assert.equal(naiveIpSim.groups.shared_wifi_fans.deniedParticipants, 8, 'Naive shared-IP autoblock denies 8/10 shared-Wi-Fi fans');
    assert.equal(naiveIpSim.groups.shared_wifi_fans.eligibleParticipants, 2, 'Naive shared-IP autoblock caps shared-Wi-Fi group at 2');

    const report = {
      simulation: true,
      label: 'Seeded isolated simulation — separate from live judging edition',
      chainId: CHAIN_ID,
      editionId,
      contractAddress,
      runtimeCodeHash,
      drawTargetHash,
      capacity: CAPACITY,
      facePriceWei: FACE_PRICE_WEI.toString(),
      inputsSummary: {
        participantsTotal: 30,
        attemptsTotal: arrivals.length,
        sharedWifiNetworkGroup: 'shared-wifi-campus-1',
        inputsSeedSha256: createHash('sha256')
          .update(JSON.stringify(arrivals.map((a) => ({ group: a.group, subjectLabel: a.subjectLabel, wallet: a.wallet.address, networkGroup: a.networkGroup }))))
          .digest('hex'),
      },
      runs: {
        fairtickets_enforced: {
          executionMode: 'real_on_chain_anvil_contract',
          differingRule: 'Enforces on-chain EIP-712 subjectEntered + walletEntered uniqueness; REPEATED_ENTRY_SUBJECT & REQUEST_BURST alerts are review-only and never auto-block.',
          totalQueueEntries: orderedOnChainItems.length,
          totalTicketsAllocated: expectedOnChainWinners.length,
          eventBurstReviewAlert: alertsEval.burstAlertTriggered,
          groups: fairTicketsGroups,
        },
        baseline_no_subject_dedup: {
          executionMode: 'seeded_counterfactual_simulation',
          differingRule: 'Removes on-chain subjectEntered[subject] uniqueness check (only walletEntered checked), keeping identical inputs and Fisher-Yates seed.',
          totalQueueEntries: noDedupSim.eligibleEntries.length,
          totalTicketsAllocated: noDedupSim.winners.length,
          eventBurstReviewAlert: noDedupSim.burstAlertTriggered,
          groups: noDedupSim.groups,
        },
        baseline_naive_shared_ip_autoblock: {
          executionMode: 'seeded_counterfactual_simulation',
          differingRule: 'Replaces review-only REQUEST_BURST alerting with a hard auto-block cap of 2 unique entrants per shared network group.',
          totalQueueEntries: naiveIpSim.eligibleEntries.length,
          totalTicketsAllocated: naiveIpSim.winners.length,
          eventBurstReviewAlert: naiveIpSim.burstAlertTriggered,
          groups: naiveIpSim.groups,
        },
      },
      deltas: {
        extraBotQueueEntriesPrevented:
          noDedupSim.groups.repeated_entrant_bots.eligibleQueueEntries -
          fairTicketsGroups.repeated_entrant_bots.eligibleQueueEntries,
        sharedWifiFalseDenialsAvoided:
          naiveIpSim.groups.shared_wifi_fans.deniedParticipants -
          fairTicketsGroups.shared_wifi_fans.deniedParticipants,
      },
    };

    if (writeArtifacts) {
      writeFileSync(join(root, 'artifacts', 'detection-comparison.json'), JSON.stringify(report, null, 2) + '\n');
      writeFileSync(join(root, 'artifacts', 'detection-comparison.md'), renderMarkdown(report) + '\n');
    }

    console.log(JSON.stringify({ detectionComparisonVerified: true, writeArtifacts, ...report }, null, 2));
  } finally {
    await anvil.stop();
    rmSync(tempStateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
