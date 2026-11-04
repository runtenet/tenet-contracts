import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 86_400;

async function deploy() {
  const [admin, user, operator, guardian, stranger, treasury] = await viem.getWalletClients();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, parseUnits("10000", 6), admin.account.address]);
  const stock = await viem.deployContract("MockStockToken", ["Mock AAPL", "mAAPL", admin.account.address]);
  const usdgFeed = await viem.deployContract("TestPriceFeed", [8, "USDG/USD", usd8(1), admin.account.address]);
  const stockFeed = await viem.deployContract("TestPriceFeed", [8, "AAPL/USD", usd8(200), admin.account.address]);
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);

  await hub.write.setFeed([usdg.address, usdgFeed.address, DAY]);
  await hub.write.setFeed([stock.address, stockFeed.address, DAY]);
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setOperator([operator.account.address, true]);
  await usdg.write.setMinter([adapter.address, true]);
  await stock.write.setMinter([adapter.address, true]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);
  await usdg.write.mint([vault.address, parseUnits("5000", 6)]);

  const strategy = {
    kind: 0, active: true, tokenIn: usdg.address, tokenOut: stock.address, adapter: adapter.address,
    amount: parseUnits("100", 6), triggerPrice: 0n, interval: 60, slippageBps: 100, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n,
  };
  await vault.write.createStrategy([strategy], { account: user.account });
  return { hub, usdg, stock, stockFeed, usdgFeed, vault, admin, user, operator, guardian, stranger, treasury };
}

describe("guardian and pause rights", () => {
  it("the guardian can pause but never unpause; only the owner can unpause", async () => {
    const { hub, guardian, stranger } = await networkHelpers.loadFixture(deploy);
    await hub.write.setGuardian([guardian.account.address]);

    await hub.write.setExecutionsPaused([true], { account: guardian.account });
    assert.equal(await hub.read.executionsPaused(), true);

    await viem.assertions.revertWithCustomError(hub.write.setExecutionsPaused([false], { account: guardian.account }), hub, "NotAuthorized");
    await viem.assertions.revertWithCustomError(hub.write.setExecutionsPaused([true], { account: stranger.account }), hub, "NotAuthorized");

    await hub.write.setExecutionsPaused([false]); // owner
    assert.equal(await hub.read.executionsPaused(), false);
  });

  it("only the owner can set the guardian, the trade cap and pause checks", async () => {
    const { hub, stock, guardian, stranger } = await networkHelpers.loadFixture(deploy);
    const as = { account: stranger.account };
    await viem.assertions.revertWithCustomErrorWithArgs(hub.write.setGuardian([guardian.account.address], as), hub, "OwnableUnauthorizedAccount", [
      stranger.account.address,
    ]);
    await assert.rejects(hub.write.setMaxTradeUsd([1n], as));
    await assert.rejects(hub.write.setTokenPauseCheck([stock.address, true], as));
  });
});

describe("per-trade cap (beta brake)", () => {
  it("blocks a run above the cap and allows it again when the cap is raised", async () => {
    const { hub, vault, operator } = await networkHelpers.loadFixture(deploy);
    await hub.write.setMaxTradeUsd([parseEther("50")]); // $50 cap, the strategy buys $100
    assert.equal((await vault.read.checkStrategy([0n])).status, 11); // OverTradeLimit
    await viem.assertions.revertWithCustomError(vault.write.execute([0n, "0x"], { account: operator.account }), vault, "NotReady");

    await hub.write.setMaxTradeUsd([parseEther("100")]); // equal to the trade: allowed
    assert.equal((await vault.read.checkStrategy([0n])).status, 0); // Ready
    await hub.write.setMaxTradeUsd([0n]); // 0 = no cap
    assert.equal((await vault.read.checkStrategy([0n])).status, 0);
  });
});

describe("issuer pause flags and corporate actions", () => {
  it("ignores the flags unless the pause check is enabled for the token", async () => {
    const { hub, stock } = await networkHelpers.loadFixture(deploy);
    await stock.write.setFlags([true, false]);
    const [, ok] = await hub.read.getPrice([stock.address]);
    assert.equal(ok, true);
  });

  it("oraclePaused() and paused() make the token unpriceable", async () => {
    const { hub, stock, vault } = await networkHelpers.loadFixture(deploy);
    await hub.write.setTokenPauseCheck([stock.address, true]);
    assert.equal((await hub.read.getPrice([stock.address]))[1], true);

    await stock.write.setFlags([true, false]);
    assert.equal((await hub.read.getPrice([stock.address]))[1], false);
    assert.equal((await vault.read.checkStrategy([0n])).status, 8); // OracleUnavailable

    await stock.write.setFlags([false, true]);
    assert.equal((await hub.read.getPrice([stock.address]))[1], false);

    await stock.write.setFlags([false, false]);
    assert.equal((await hub.read.getPrice([stock.address]))[1], true);
  });

  it("a flagged token that does not expose oraclePaused() is treated as suspended", async () => {
    const { hub, usdg } = await networkHelpers.loadFixture(deploy);
    await hub.write.setTokenPauseCheck([usdg.address, true]); // TestToken has no oraclePaused()
    assert.equal((await hub.read.getPrice([usdg.address]))[1], false);
  });

  it("blocks around a multiplier change: an hour before, and for two hours after", async () => {
    const { hub, stock } = await networkHelpers.loadFixture(deploy);
    await hub.write.setTokenPauseCheck([stock.address, true]);
    const now = BigInt(await networkHelpers.time.latest());

    // a split is scheduled in 3 hours: fine now
    await stock.write.setMultiplier([parseEther("1"), parseEther("2"), now + 3n * 3600n]);
    assert.equal((await hub.read.getPrice([stock.address]))[1], true);

    // 30 minutes before: blocked
    await networkHelpers.time.increaseTo(now + 3n * 3600n - 1800n);
    assert.equal((await hub.read.getPrice([stock.address]))[1], false);

    // the change is applied at the effective time, but the feed may lag: still blocked for two hours
    await stock.write.setMultiplier([parseEther("2"), parseEther("2"), now + 3n * 3600n]);
    await networkHelpers.time.increaseTo(now + 3n * 3600n + 3600n);
    assert.equal((await hub.read.getPrice([stock.address]))[1], false);

    // afterwards the feed is trusted again (the feed itself must still be fresh)
    await networkHelpers.time.increaseTo(now + 3n * 3600n + 2n * 3600n + 10n);
    assert.equal((await hub.read.getPrice([stock.address]))[1], true);
  });
});

describe("oracle robustness", () => {
  it("rejects a feed that reverts on decimals() instead of reverting the whole call", async () => {
    const { hub, usdg } = await networkHelpers.loadFixture(deploy);
    const [, , , , , treasury] = await viem.getWalletClients();
    // an EOA as feed: latestRoundData() reverts (no code) -> unusable price, no revert
    await hub.write.setFeed([usdg.address, treasury.account.address, DAY]);
    assert.equal((await hub.read.getPrice([usdg.address]))[1], false);
  });

  it("ownership transfer is two-step", async () => {
    const { hub, stranger } = await networkHelpers.loadFixture(deploy);
    await hub.write.transferOwnership([stranger.account.address]);
    assert.notEqual((await hub.read.owner()).toLowerCase(), stranger.account.address.toLowerCase());
    await hub.write.acceptOwnership({ account: stranger.account });
    assert.equal((await hub.read.owner()).toLowerCase(), stranger.account.address.toLowerCase());
  });
});
