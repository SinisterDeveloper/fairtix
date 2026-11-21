const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const quais = require('quais');
const hre = require('hardhat');

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
  const networkName = hre.network.name;
  const rawRpcUrl = hre.network.config.url;
  const rpcUrl = rawRpcUrl ? rawRpcUrl.replace(/\/cyprus1\/?$/i, '') : rawRpcUrl;
  const pk = hre.network.config.accounts?.[0];

  if (networkName !== 'cyprus1') {
    throw new Error(`Refusing to deploy on "${networkName}". Only Orchard "cyprus1" (chainId 15000) is permitted.`);
  }
  if (!rpcUrl || !pk) {
    throw new Error('Missing RPC_URL or CYPRUS1_PK in .env. Run `npm run quai:wallet` first.');
  }

  const provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });
  const wallet = new quais.Wallet(pk, provider);

  const net = await provider.getNetwork();
  if (BigInt(net.chainId) !== 15000n) {
    throw new Error(`Chain ID mismatch: expected 15000 (Orchard Cyprus-1), got ${net.chainId}`);
  }

  const balance = await provider.getBalance(wallet.address);
  const artifact = await hre.artifacts.readArtifact('FairTickets');

  const nowSec = Math.floor(Date.now() / 1000);
  const organiser = process.env.ORGANISER_ADDR || wallet.address;
  const attester = process.env.ATTESTER_ADDR || wallet.address;
  const gate = process.env.GATE_ADDR || wallet.address;
  const capacity = BigInt(process.env.TICKET_CAPACITY || 100);
  const facePrice = quais.parseQuai(process.env.FACE_PRICE_QUAI || '0.01');
  const editionId = quais.keccak256(quais.toUtf8Bytes(process.env.EDITION_NAME || 'FairTickets-Orchard-Demo-1'));
  const entryDeadline = BigInt(nowSec + Number(process.env.ENTRY_WINDOW_SEC || 3600));
  const claimDuration = BigInt(process.env.CLAIM_DURATION_SEC || 3600);
  const resaleDuration = BigInt(process.env.RESALE_DURATION_SEC || 3600);
  const gateDuration = BigInt(process.env.GATE_DURATION_SEC || 3600);

  const constructorArgs = [
    organiser,
    attester,
    gate,
    capacity,
    facePrice,
    editionId,
    entryDeadline,
    claimDuration,
    resaleDuration,
    gateDuration,
  ];

  console.log('Deployment preflight:');
  console.log({
    network: 'Orchard Cyprus-1',
    chainId: Number(net.chainId),
    deployer: wallet.address,
    balanceQuai: quais.formatQuai(balance),
    contractName: 'FairTickets',
    artifactPath: 'artifacts-hardhat/contracts/FairTickets.sol/FairTickets.json',
    constructorArgs: constructorArgs.map((v) => (typeof v === 'bigint' ? v.toString() : v)),
  });

  if (balance === 0n) {
    throw new Error(`Deployer ${wallet.address} has 0 QUAI. Fund it at https://orchard.faucet.quai.network first.`);
  }

  if (dryRun) {
    console.log('DRY_RUN enabled; stopping before IPFS metadata upload and transaction broadcast.');
    return;
  }

  console.log('Pushing metadata to Quai IPFS...');
  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFS('FairTickets');
  console.log('IPFS metadata hash:', ipfsHash);

  const factory = new quais.ContractFactory(artifact.abi, artifact.bytecode, wallet, ipfsHash);
  const contract = await factory.deploy(...constructorArgs);
  const deployTx = contract.deploymentTransaction();
  console.log('Broadcasted tx:', deployTx?.hash);

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const evidence = {
    contractName: 'FairTickets',
    network: 'Orchard Cyprus-1',
    chainId: 15000,
    address,
    transactionHash: deployTx?.hash || null,
    deployer: wallet.address,
    ipfsHash,
    artifactPath: 'artifacts-hardhat/contracts/FairTickets.sol/FairTickets.json',
    explorerUrl: `https://orchard.quaiscan.io/address/${address}`,
    deployedAt: new Date().toISOString(),
  };

  mkdirSync(join(__dirname, '..', 'artifacts-hardhat'), { recursive: true });
  writeFileSync(join(__dirname, '..', 'artifacts-hardhat', 'quai-deployment.json'), JSON.stringify(evidence, null, 2));
  console.log('Deployment complete:', evidence);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
