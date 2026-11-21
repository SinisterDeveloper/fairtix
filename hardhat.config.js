require('dotenv').config();
require('@quai/hardhat-deploy-metadata');

const compilerSettings = {
  optimizer: {
    enabled: true,
    runs: 200,
  },
  evmVersion: 'london',
  metadata: {
    bytecodeHash: 'ipfs',
    useLiteralContent: true,
  },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  defaultNetwork: 'cyprus1',
  solidity: {
    compilers: [
      { version: '0.8.20', settings: compilerSettings },
      { version: '0.8.30', settings: compilerSettings },
    ],
  },
  networks: {
    cyprus1: {
      url: process.env.RPC_URL || 'https://orchard.rpc.quai.network',
      accounts: process.env.CYPRUS1_PK ? [process.env.CYPRUS1_PK] : [],
      chainId: Number(process.env.CHAIN_ID || 15000),
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts-hardhat',
  },
};
