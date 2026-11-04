import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 86_400;

async function deploy() {
  const [admin, user, operator, treasury] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, parseUnits("10000", 6), admin.account.address]);
  const weth = await viem.deployContract("MockWETH", [admin.account.address]);
  const aapl = await viem.deployContract("TestToken", ["AAPL", "AAPL", 18, parseEther("5"), admin.account.address]);
  const usdgFeed = await viem.deployContract("TestPriceFeed", [8, "USDG/USD", usd8(1), admin.account.address]);
  const wethFeed = await viem.deployContract("TestPriceFeed", [8, "ETH/USD", usd8(2000), admin.account.address]);
  const aaplFeed = await viem.deployContract("TestPriceFeed", [8, "AAPL/USD", usd8(200), admin.account.address]);
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);

  for (const [t, f] of [[usdg, usdgFeed], [weth, wethFeed], [aapl, aaplFeed]] as const) await hub.write.setFeed([t.address, f.address, DAY]);
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setOperator([operator.account.address, true]);
  for (const t of [usdg, weth, aapl]) await t.write.setMinter([adapter.address, true]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);
  return { hub, usdg, weth, aapl, vault, adapter, user, operator, pc };
}

const dca = (adapter: `0x${string}`, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amount: bigint) => ({
  kind: 0, active: true, tokenIn, tokenOut, adapter, amount, triggerPrice: 0n, interval: 60, slippageBps: 100,
  targetBps: 0, driftBps: 0, maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n,
});

describe("ETH as a way to pay (WETH9-style token)", () => {
  it("wraps ETH, unwraps it again, and a plain transfer into the vault is enough to fund it", async () => {
    const { weth, vault, user, pc } = await networkHelpers.loadFixture(deploy);
    await weth.write.deposit({ account: user.account, value: parseEther("1") });
    assert.equal(await weth.read.balanceOf([user.account.address]), parseEther("1"));

    // "deposit ETH" on the website: wrap, then transfer (no approval, no vault call)
    await weth.write.transfer([vault.address, parseEther("0.6")], { account: user.account });
    assert.equal(await weth.read.balanceOf([vault.address]), parseEther("0.6"));

    // "withdraw as ETH": the vault pays out WETH, the owner unwraps it
    await vault.write.withdraw([weth.address, parseEther("0.6"), user.account.address], { account: user.account });
    const before = await pc.getBalance({ address: user.account.address });
    const hash = await weth.write.withdraw([parseEther("1")], { account: user.account });
    const r = await pc.waitForTransactionReceipt({ hash });
    assert.equal((await pc.getBalance({ address: user.account.address })) - before + r.gasUsed * r.effectiveGasPrice, parseEther("1"));
    assert.equal(await weth.read.balanceOf([user.account.address]), 0n);
  });

  it("a strategy can pay in WETH and the keeper buys a stock at the oracle price", async () => {
    const { hub, weth, aapl, vault, adapter, user, operator } = await networkHelpers.loadFixture(deploy);
    await weth.write.deposit({ account: user.account, value: parseEther("1") });
    await weth.write.transfer([vault.address, parseEther("1")], { account: user.account });
    await vault.write.createStrategy([dca(adapter.address, weth.address, aapl.address, parseEther("0.1"))], { account: user.account });

    assert.equal((await vault.read.checkStrategy([0n])).status, 0); // Ready
    await vault.write.execute([0n, "0x"], { account: operator.account });

    // 0.1 ETH = $200, minus 0.2% fees and a 0.1% spread, at $200 per share
    const expected = (parseEther("0.0998") * 2000n * 9990n) / 10000n / 200n;
    assert.equal(await aapl.read.balanceOf([vault.address]), expected);
    assert.equal(await weth.read.balanceOf([vault.address]), parseEther("0.9"));
    void hub;
  });

  it("selling a stock into WETH works too (take-profit paid in ETH)", async () => {
    const { weth, aapl, vault, adapter, user, operator } = await networkHelpers.loadFixture(deploy);
    await aapl.write.mint([vault.address, parseEther("2")]);
    await vault.write.createStrategy(
      [{ ...dca(adapter.address, aapl.address, weth.address, parseEther("1")), kind: 2, triggerPrice: parseEther("1"), interval: 0, maxRuns: 1 }],
      { account: user.account },
    );
    await vault.write.execute([0n, "0x"], { account: operator.account });
    assert.ok((await weth.read.balanceOf([vault.address])) > parseEther("0.09")); // about $200 / $2000 = 0.1 ETH
    assert.equal(await aapl.read.balanceOf([vault.address]), parseEther("1"));
  });
});
