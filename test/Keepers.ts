import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();
const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 86_400;
const MIN = parseEther("1000");

async function deploy() {
  const [admin, user, keeper, other, stranger] = await viem.getWalletClients();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, admin.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, parseUnits("100000", 6), admin.account.address]);
  const aapl = await viem.deployContract("TestToken", ["AAPL", "AAPL", 18, parseEther("5"), admin.account.address]);
  const meme = await viem.deployContract("TestToken", ["MEME", "MEME", 18, parseEther("1000000"), admin.account.address]);
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);
  const registry = await viem.deployContract("KeeperRegistry", [admin.account.address, MIN]);
  for (const [t, f, p] of [[usdg, "USDG/USD", 1], [aapl, "AAPL/USD", 200]] as const) {
    const feed = await viem.deployContract("TestPriceFeed", [8, f, usd8(p), admin.account.address]);
    await hub.write.setFeed([t.address, feed.address, 365n * 86400n]);
    await t.write.setMinter([adapter.address, true]);
  }
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setKeeperRegistry([registry.address]);
  await meme.write.mint([keeper.account.address, parseEther("5000")]);
  await meme.write.mint([other.account.address, parseEther("500")]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);
  await usdg.write.mint([vault.address, parseUnits("5000", 6)]);
  const strategy = {
    kind: 0, active: true, tokenIn: usdg.address, tokenOut: aapl.address, adapter: adapter.address,
    amount: parseUnits("100", 6), triggerPrice: 0n, interval: 60, slippageBps: 100, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n,
  };
  await vault.write.createStrategy([strategy], { account: user.account });
  return { hub, registry, meme, vault, admin, user, keeper, other, stranger };
}
type C = Awaited<ReturnType<typeof deploy>>;
const stakeAs = async (c: C, who: C["keeper"], amount: bigint) => {
  await c.meme.write.approve([c.registry.address, amount], { account: who.account });
  await c.registry.write.stake([amount], { account: who.account });
};

describe("KeeperRegistry", () => {
  it("nobody is a keeper before the token exists", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), false);
    await viem.assertions.revertWithCustomError(c.vault.write.execute([0n, "0x"], { account: c.keeper.account }), c.vault, "NotOperator");
  });

  it("a bonded keeper can execute; one below the minimum or outside cannot", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.registry.write.setStakeToken([c.meme.address]);
    await stakeAs(c, c.other, parseEther("500")); // below the 1000 minimum
    assert.equal(await c.registry.read.isActive([c.other.account.address]), false);
    await viem.assertions.revertWithCustomError(c.vault.write.execute([0n, "0x"], { account: c.other.account }), c.vault, "NotOperator");

    await stakeAs(c, c.keeper, MIN);
    assert.equal(await c.hub.read.canExecute([c.keeper.account.address]), true);
    await c.vault.write.execute([0n, "0x"], { account: c.keeper.account }); // earns the keeper fee
    await viem.assertions.revertWithCustomError(c.vault.write.execute([0n, "0x"], { account: c.stranger.account }), c.vault, "NotOperator");
  });

  it("leaving stops the keeper at once and returns the bond after the delay, never early", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.registry.write.setStakeToken([c.meme.address]);
    await stakeAs(c, c.keeper, MIN);
    await c.registry.write.requestLeave({ account: c.keeper.account });
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), false);
    await viem.assertions.revertWithCustomError(c.registry.write.withdraw({ account: c.keeper.account }), c.registry, "TooEarly");
    await networkHelpers.time.increase(7 * DAY + 1);
    await c.registry.write.withdraw({ account: c.keeper.account });
    assert.equal(await c.meme.read.balanceOf([c.keeper.account.address]), parseEther("5000"));
    assert.equal(await c.registry.read.totalStaked(), 0n);
  });

  it("the owner can ban a keeper but cannot take its bond", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.registry.write.setStakeToken([c.meme.address]);
    await stakeAs(c, c.keeper, MIN);
    await viem.assertions.revertWithCustomError(c.registry.write.setBanned([c.keeper.account.address, true], { account: c.stranger.account }), c.registry, "OwnableUnauthorizedAccount");
    await c.registry.write.setBanned([c.keeper.account.address, true]);
    assert.equal(await c.hub.read.canExecute([c.keeper.account.address]), false);
    await c.registry.write.requestLeave({ account: c.keeper.account });
    await networkHelpers.time.increase(7 * DAY + 1);
    await c.registry.write.withdraw({ account: c.keeper.account }); // the bond is still theirs
    assert.equal(await c.meme.read.balanceOf([c.keeper.account.address]), parseEther("5000"));
  });

  it("the owner can change the bond token; keepers bonded in the old one go inactive, can still withdraw it, and bond again in the new one", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.registry.write.setStakeToken([c.meme.address]);
    await viem.assertions.revertWithCustomError(c.registry.write.setStakeToken([c.meme.address]), c.registry, "SameToken");
    await stakeAs(c, c.keeper, MIN);
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), true);
    const other = await viem.deployContract("TestToken", ["OTHER", "OTH", 18, 0n, c.admin.account.address]);
    await other.write.setMinter([c.admin.account.address, true]);
    await other.write.mint([c.keeper.account.address, parseEther("3000")]);
    await c.registry.write.setStakeToken([other.address]); // the owner switches the token
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), false, "bonded in the old token");
    assert.equal(await c.registry.read.totalStaked(), 0n, "the total is per token");
    await other.write.approve([c.registry.address, MIN], { account: c.keeper.account });
    await viem.assertions.revertWithCustomError(c.registry.write.stake([MIN], { account: c.keeper.account }), c.registry, "BondedInOldToken");
    // leave, take the old bond back (in the old token), bond again in the new one
    await c.registry.write.requestLeave({ account: c.keeper.account });
    await networkHelpers.time.increase(7 * DAY + 1);
    const before = await c.meme.read.balanceOf([c.keeper.account.address]);
    await c.registry.write.withdraw({ account: c.keeper.account });
    assert.equal((await c.meme.read.balanceOf([c.keeper.account.address])) - before, MIN);
    await c.registry.write.stake([MIN], { account: c.keeper.account });
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), true);
    assert.equal(await c.registry.read.totalStaked(), MIN);
  });

  it("raising the minimum deactivates smaller keepers", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.registry.write.setStakeToken([c.meme.address]);
    await stakeAs(c, c.keeper, MIN);
    await c.registry.write.setMinStake([parseEther("2000")]);
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), false);
    await stakeAs(c, c.keeper, MIN); // top up
    assert.equal(await c.registry.read.isActive([c.keeper.account.address]), true);
  });

  it("the hub's own operators still work, with or without a registry", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.hub.write.setOperator([c.admin.account.address, true]);
    await c.vault.write.execute([0n, "0x"], { account: c.admin.account });
    await c.hub.write.setKeeperRegistry(["0x0000000000000000000000000000000000000000"]);
    assert.equal(await c.hub.read.canExecute([c.admin.account.address]), true);
  });
});
