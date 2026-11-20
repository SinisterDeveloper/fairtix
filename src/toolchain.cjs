const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');

const toolsRoot = process.env.B2_CHAIN_TOOLS || join(tmpdir(), 'b2-anvil-win-171');
if (!existsSync(toolsRoot)) {
  throw new Error(`Toolchain directory not found at ${toolsRoot}. Set B2_CHAIN_TOOLS.`);
}

const toolRequire = createRequire(join(toolsRoot, 'package.json'));
const ethers = toolRequire('ethers');
const solc = toolRequire('solc');
const anvilPath = join(toolsRoot, 'node_modules', '@foundry-rs', 'anvil-win32-amd64', 'bin', 'anvil.exe');

if (!existsSync(anvilPath)) {
  throw new Error(`Anvil binary not found at ${anvilPath}`);
}

const ozRoot = join(toolsRoot, 'node_modules', '@openzeppelin', 'contracts');

function compileSolidity(contractFiles) {
  const sources = {};
  for (const [name, filePath] of Object.entries(contractFiles)) {
    sources[name] = { content: readFileSync(filePath, 'utf8') };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  };

  function findImports(importPath) {
    if (importPath.startsWith('@openzeppelin/contracts/')) {
      const rel = importPath.slice('@openzeppelin/contracts/'.length);
      const full = join(ozRoot, rel);
      if (existsSync(full)) {
        return { contents: readFileSync(full, 'utf8') };
      }
    }
    return { error: `File not found: ${importPath}` };
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Solidity compilation failed:\n${errors.map((e) => e.formattedMessage).join('\n')}`);
  }
  return output;
}

function makeRpc(endpoint) {
  let nextId = 0;

  async function rpcBatch(calls) {
    const body = calls.map(([method, params = []]) => ({
      jsonrpc: '2.0',
      id: ++nextId,
      method,
      params,
    }));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }
    const items = await response.json();
    const byId = new Map(items.map((item) => [item.id, item]));
    return body.map(({ id, method }) => {
      const item = byId.get(id);
      if (!item) throw new Error(`${method}: missing RPC response`);
      if (item.error) {
        const err = new Error(`${method}: ${item.error.message || JSON.stringify(item.error)}`);
        err.rpcError = item.error;
        throw err;
      }
      return item.result;
    });
  }

  async function rpc(method, params = []) {
    return (await rpcBatch([[method, params]]))[0];
  }

  return { rpc, rpcBatch };
}

function eip712Domain(chainId, verifyingContract) {
  return {
    name: 'FairTickets',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract,
  };
}

const ATTESTATION_TYPES = {
  EntryAttestation: [
    { name: 'editionId', type: 'bytes32' },
    { name: 'subject', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'expiry', type: 'uint256' },
  ],
};

const GATE_TYPES = {
  GateCredential: [
    { name: 'editionId', type: 'bytes32' },
    { name: 'slot', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

async function signAttestation(attesterWallet, chainId, contractAddress, editionId, subject, walletAddress, expiry) {
  return attesterWallet.signTypedData(
    eip712Domain(chainId, contractAddress),
    ATTESTATION_TYPES,
    {
      editionId,
      subject,
      wallet: walletAddress,
      expiry: BigInt(expiry),
    }
  );
}

async function signGateCredential(ownerWallet, chainId, contractAddress, editionId, slot, version, expiry) {
  return ownerWallet.signTypedData(
    eip712Domain(chainId, contractAddress),
    GATE_TYPES,
    {
      editionId,
      slot: BigInt(slot),
      version: BigInt(version),
      expiry: BigInt(expiry),
    }
  );
}

module.exports = {
  toolsRoot,
  ethers,
  solc,
  anvilPath,
  compileSolidity,
  makeRpc,
  eip712Domain,
  ATTESTATION_TYPES,
  GATE_TYPES,
  signAttestation,
  signGateCredential,
};
