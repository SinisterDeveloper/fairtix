const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { compileSolidity, ethers } = require('./toolchain.cjs');

const root = resolve(__dirname, '..');
const artifactsDir = join(root, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

const output = compileSolidity({
  'FairTickets.sol': join(root, 'contracts', 'FairTickets.sol'),
  'RejectingReceiver.sol': join(root, 'contracts', 'RejectingReceiver.sol'),
});

const warnings = (output.errors || []).filter((e) => e.severity !== 'error');
if (warnings.length > 0) {
  console.warn(warnings.map((w) => w.formattedMessage).join('\n'));
}

const fairTickets = output.contracts['FairTickets.sol'].FairTickets;
const fairTicketsArtifact = {
  contractName: 'FairTickets',
  solcVersion: '0.8.30',
  evmVersion: 'shanghai',
  abi: fairTickets.abi,
  bytecode: '0x' + fairTickets.evm.bytecode.object,
  deployedBytecode: '0x' + fairTickets.evm.deployedBytecode.object,
  deployedBytecodeHash: ethers.keccak256('0x' + fairTickets.evm.deployedBytecode.object),
};
writeFileSync(join(artifactsDir, 'FairTickets.json'), JSON.stringify(fairTicketsArtifact, null, 2));

const rejectingReceiver = output.contracts['RejectingReceiver.sol'].RejectingReceiver;
const rejectingArtifact = {
  contractName: 'RejectingReceiver',
  solcVersion: '0.8.30',
  evmVersion: 'shanghai',
  abi: rejectingReceiver.abi,
  bytecode: '0x' + rejectingReceiver.evm.bytecode.object,
  deployedBytecode: '0x' + rejectingReceiver.evm.deployedBytecode.object,
};
writeFileSync(join(artifactsDir, 'RejectingReceiver.json'), JSON.stringify(rejectingArtifact, null, 2));

console.log(`Compiled FairTickets.sol (${fairTicketsArtifact.bytecode.length / 2 - 1} bytes initcode, codeHash=${fairTicketsArtifact.deployedBytecodeHash})`);
console.log(`Compiled RejectingReceiver.sol`);
