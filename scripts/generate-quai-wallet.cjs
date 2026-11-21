const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const quais = require('quais');

const root = resolve(__dirname, '..');
const envPath = join(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(envPath) && !force) {
  const existing = readFileSync(envPath, 'utf8');
  const match = existing.match(/^CYPRUS1_PK=(.+)$/m);
  if (match && match[1].trim()) {
    const wallet = new quais.Wallet(match[1].trim());
    console.log(JSON.stringify({
      created: false,
      message: '.env already has CYPRUS1_PK (pass --force to replace)',
      address: wallet.address,
      zone: quais.getZoneForAddress(wallet.address),
    }, null, 2));
    process.exit(0);
  }
}

const hdWallet = quais.QuaiHDWallet.createRandom();
const addrInfo = hdWallet.getNextAddressSync(0, quais.Zone.Cyprus1);
const pk = hdWallet.getPrivateKey(addrInfo.address);
const wallet = new quais.Wallet(pk);

if (quais.getZoneForAddress(wallet.address) !== quais.Zone.Cyprus1) {
  throw new Error(`Generated address ${wallet.address} is not in Cyprus-1 (${quais.Zone.Cyprus1})`);
}

const envContent = [
  'RPC_URL=https://orchard.rpc.quai.network',
  `CYPRUS1_PK=${pk}`,
  'CHAIN_ID=15000',
  '',
].join('\n');

writeFileSync(envPath, envContent, { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  created: true,
  envFile: '.env',
  address: wallet.address,
  zone: quais.getZoneForAddress(wallet.address),
  chainId: 15000,
  faucet: 'https://orchard.faucet.quai.network',
  explorer: `https://orchard.quaiscan.io/address/${wallet.address}`,
}, null, 2));
