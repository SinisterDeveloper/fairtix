const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { anvilPath, ethers, makeRpc } = require('./toolchain.cjs');

async function startAnvil({
  port = 8545,
  chainId = 31337,
  blockTime = null,
  noMining = false,
  accounts = 10,
  balance = '10000',
  mnemonic = null,
} = {}) {
  const phrase = mnemonic || ethers.Mnemonic.fromEntropy(ethers.randomBytes(16)).phrase;
  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', String(chainId),
    '--hardfork', 'shanghai',
    '--gas-limit', '30000000',
    '--accounts', String(accounts),
    '--balance', String(balance),
    '--mnemonic', phrase,
    '--silent',
  ];
  if (noMining) {
    args.push('--no-mining');
  } else if (blockTime !== null) {
    args.push('--block-time', String(blockTime));
  }

  const proc = spawn(anvilPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let launchError = null;
  proc.stderr.on('data', (chunk) => {
    launchError = String(chunk).trim();
  });
  proc.on('error', (err) => {
    launchError = err.message;
  });

  const endpoint = `http://127.0.0.1:${port}`;
  const { rpc, rpcBatch } = makeRpc(endpoint);

  for (let i = 0; i < 100; i++) {
    if (launchError || proc.exitCode !== null) {
      throw new Error(launchError || `Anvil exited with code ${proc.exitCode}`);
    }
    try {
      const cid = await rpc('eth_chainId');
      if (BigInt(cid) === BigInt(chainId)) {
        return {
          proc,
          endpoint,
          chainId,
          mnemonic: phrase,
          rpc,
          rpcBatch,
          stop: () => {
            if (!proc.killed) proc.kill();
          },
        };
      }
    } catch {
      await delay(100);
    }
  }
  proc.kill();
  throw new Error(`Timed out waiting for Anvil on ${endpoint}`);
}

module.exports = { startAnvil };
