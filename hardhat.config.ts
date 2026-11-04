import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  // Source verification on Robinhood Chain's Blockscout explorer:
  //   npx hardhat verify --network rhMainnet <address> <constructor args>
  chainDescriptors: {
    4663: {
      name: "Robinhood Chain",
      blockExplorers: {
        blockscout: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com", apiUrl: "https://robinhoodchain.blockscout.com/api" },
      },
    },
  },
  verify: { blockscout: { enabled: true } },
  networks: {
    localhost: {
      type: "http",
      url: "http://127.0.0.1:18545",
    },
    // Forks Robinhood Chain mainnet locally (no real funds): FORK=1 npx hardhat test --network rhFork
    // The public RPC keeps little history, so the fork pins to the latest block when it starts.
    rhFork: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 4663,
      forking: { url: process.env.RH_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com" },
    },
    // Robinhood Chain testnet (Arbitrum Orbit)
    rhTestnet: {
      type: "http",
      chainType: "generic",
      chainId: 46630,
      url: configVariable("RH_TESTNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    // Robinhood Chain mainnet
    rhMainnet: {
      type: "http",
      chainType: "generic",
      chainId: 4663,
      url: configVariable("RH_MAINNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
