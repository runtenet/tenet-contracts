/**
 * The agent's direct trading against REAL Uniswap v4 pools and REAL Chainlink feeds on a fork of Robinhood Chain mainnet.
 *
 *   FORK=1 npx hardhat test test/AgentTrade.fork.ts --network rhFork
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, erc20Abi, getAddress, parseEther, parseUnits, type Address } from "viem";

const RUN = process.env.FORK === "1";
const cfg = JSON.parse(readFileSync(new URL("../config/mainnet.json", import.meta.url), "utf8"));

const hopsAbi = [
  {
    type: "tuple[]",
    components: [
      { name: "key", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;
const path = (...keys: any[]) => encodeAbiParameters(hopsAbi, [keys.map((key) => ({ key, hookData: "0x" as const }))]);

describe("mainnet fork: the agent trades directly through a real pool", { skip: !RUN }, async () => {
  const { viem, networkHelpers } = await network.create({ network: "rhFork" } as never);
  const pc = await viem.getPublicClient();
  const usdg: Address = cfg.usdg.address;
  const nvda = cfg.tokens.find((t: any) => t.symbol === "NVDA");
  const pools = cfg.pools.filter((p: any) => p.symbol === "NVDA" && p.kind === "stock/USDG");
  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  it("buys NVDA with USDG, inside the owner's limits, with the reason on chain", async () => {
    const [admin, user, agent, treasury] = await viem.getWalletClients();
    const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
    const adapter = await viem.deployContract("UniswapV4NativeAdapter", [cfg.poolManager, admin.account.address, cfg.weth.address]);
    for (const t of [cfg.usdg, nvda]) {
      await hub.write.setFeed([t.address, t.feed, t.maxStaleness]);
      if (t.kind === "stock") await hub.write.setTokenPauseCheck([t.address, true]);
    }
    await hub.write.setAdapter([adapter.address, true]);
    for (const p of pools) await adapter.write.setPool([p.key, true]);

    await hub.write.createVault({ account: user.account });
    const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
    const vault = await viem.getContractAt("TenetVault", vaultAddr);

    // real USDG, taken out of the PoolManager's reserves
    const pm = getAddress(cfg.poolManager);
    await networkHelpers.setBalance(pm, parseEther("1"));
    await networkHelpers.impersonateAccount(pm);
    const pmWallet = await viem.getWalletClient(pm);
    await pc.waitForTransactionReceipt({ hash: await pmWallet.writeContract({ address: usdg, abi: erc20Abi, functionName: "transfer", args: [vault.address, parseUnits("500", 6)] }) });

    const latest = Number(await networkHelpers.time.latest());
    await vault.write.setAgent([agent.account.address, BigInt(latest + 7 * 86400), parseEther("100"), parseEther("200"), 3, 3600, 150, [usdg, nvda.address]], { account: user.account });
    await vault.write.setAgentTrading([true], { account: user.account });

    // the market may refuse a given pool at a given moment (the hooks guard against drifted prices): try each, like the robot
    let bought = 0n;
    for (const p of pools) {
      try {
        await vault.write.agentTrade([usdg, nvda.address, parseUnits("50", 6), adapter.address, path(p.key), "buying a little NVDA"], { account: agent.account });
        bought = await bal(nvda.address, vault.address);
        break;
      } catch (e: any) {
        console.log(`    (pool refused: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 80)})`);
      }
    }
    assert.ok(bought > 0n, "no real pool accepted the agent's buy");
    console.log(`    agent bought ${Number(bought) / 1e18} NVDA for 50 USDG`);
    const events = await vault.getEvents.AgentTraded();
    assert.equal(events[0]!.args.note, "buying a little NVDA");
    assert.equal(await bal(usdg, vault.address), parseUnits("450", 6));

    // a trade above the limit is refused by the contract, whatever the model says
    await networkHelpers.time.increase(3601);
    await assert.rejects(vault.write.agentTrade([usdg, nvda.address, parseUnits("150", 6), adapter.address, path(pools[0].key), "too big"], { account: agent.account }), /AgentLimit/);
    // the agent cannot take anything out
    await assert.rejects(vault.write.withdraw([usdg, 1n, agent.account.address], { account: agent.account }), /NotOwner|0x30cd7471/);
  });
});
