// Runs the mainnet-fork tests (real PoolManager, pools, hooks, Chainlink feeds; nothing is spent).
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["hardhat", "test", "test/Mainnet.fork.ts", "--network", "rhFork"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, FORK: "1" },
});
process.exit(r.status ?? 1);
