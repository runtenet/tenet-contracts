import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 86_400;
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

async function deploy() {
  const [admin, user, operator, burnerKeeper, stranger, treasury] = await viem.getWalletClients();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, parseUnits("10000", 6), admin.account.address]);
  const aapl = await viem.deployContract("TestToken", ["AAPL", "AAPL", 18, parseEther("5"), admin.account.address]);
  const meme = await viem.deployContract("TestToken", ["MEME", "MEME", 18, parseEther("1"), admin.account.address]);
  const usdgFeed = await viem.deployContract("TestPriceFeed", [8, "USDG/USD", usd8(1), admin.account.address]);
  const aaplFeed = await viem.deployContract("TestPriceFeed", [8, "AAPL/USD", usd8(200), admin.account.address]);
  const memeFeed = await viem.deployContract("TestPriceFeed", [8, "MEME/USD", usd8(0.0005), admin.account.address]); // 1 USD = 2000 MEME
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);
  const burner = await viem.deployContract("FeeBurner", [admin.account.address, adapter.address, BigInt(30 * DAY)]);

  for (const [t, f] of [[usdg, usdgFeed], [aapl, aaplFeed], [meme, memeFeed]] as const) {
    await hub.write.setFeed([t.address, f.address, 365n * 86400n]);
    await t.write.setMinter([adapter.address, true]);
  }
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setOperator([operator.account.address, true]);
  await hub.write.setFees([10, 10, burner.address]); // the whole protocol fee goes to the burner
  await burner.write.setBurner([burnerKeeper.account.address, true]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);
  await usdg.write.mint([vault.address, parseUnits("5000", 6)]);
  await aapl.write.mint([vault.address, parseEther("10")]);

  const strategy = (over: Record<string, unknown>) => ({
    kind: 0, active: true, tokenIn: usdg.address, tokenOut: aapl.address, adapter: adapter.address,
    amount: parseUnits("1000", 6), triggerPrice: 0n, interval: 60, slippageBps: 100, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n, ...over,
  });
  return { hub, usdg, aapl, meme, adapter, burner, vault, admin, user, operator, burnerKeeper, stranger, treasury, strategy };
}

/** One 1000 USDG purchase: 0.1% (1 USDG) goes to the burner as the protocol fee. */
async function tradeOnce(c: Awaited<ReturnType<typeof deploy>>) {
  await c.vault.write.createStrategy([c.strategy({})], { account: c.user.account });
  await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
}

describe("FeeBurner", () => {
  it("collects the whole protocol fee of a trade and keeps it until a token exists", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("1", 6)); // 0.1% of 1000 USDG
    assert.equal(await c.usdg.read.balanceOf([c.treasury.account.address]), 0n); // nothing for anyone else
    // no token yet: burning is impossible, the fee just waits
    await viem.assertions.revertWithCustomError(
      c.burner.write.burn([c.usdg.address, parseUnits("1", 6), 0n, "0x"], { account: c.burnerKeeper.account }),
      c.burner,
      "TokenNotSet",
    );
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("1", 6));
  });

  it("swaps the fee into the project token and sends it to the dead address", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);
    await c.burner.write.setBurnToken([c.meme.address]);

    await c.burner.write.burn([c.usdg.address, parseUnits("1", 6), 1n, "0x"], { account: c.burnerKeeper.account });

    // $1 at $0.0005 per MEME = 2000 MEME, minus the test venue's 0.1% spread
    const expected = (parseEther("2000") * 9990n) / 10000n;
    assert.equal(await c.meme.read.balanceOf([DEAD]), expected);
    assert.equal(await c.burner.read.totalBurned(), expected);
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), 0n);
    assert.equal(await c.meme.read.balanceOf([c.burner.address]), 0n); // nothing is kept
  });

  it("burns fees that came in as a stock token too (a take-profit pays its fee in the stock)", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.burner.write.setBurnToken([c.meme.address]);
    await c.vault.write.createStrategy(
      [c.strategy({ kind: 2, tokenIn: c.aapl.address, tokenOut: c.usdg.address, amount: parseEther("5"), triggerPrice: parseEther("1"), interval: 0, maxRuns: 1 })],
      { account: c.user.account },
    );
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
    const fee = await c.aapl.read.balanceOf([c.burner.address]);
    assert.equal(fee, parseEther("0.005")); // 0.1% of 5 AAPL

    await c.burner.write.burn([c.aapl.address, fee, 1n, "0x"], { account: c.burnerKeeper.account });
    // 0.005 AAPL = $1 = 2000 MEME (minus the spread)
    assert.equal(await c.meme.read.balanceOf([DEAD]), (parseEther("2000") * 9990n) / 10000n);
    assert.equal(await c.aapl.read.balanceOf([c.burner.address]), 0n);
  });

  it("only an allowlisted burner can burn", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);
    await c.burner.write.setBurnToken([c.meme.address]);
    await viem.assertions.revertWithCustomError(
      c.burner.write.burn([c.usdg.address, parseUnits("1", 6), 1n, "0x"], { account: c.stranger.account }),
      c.burner,
      "NotBurner",
    );
    // the owner can revoke a burner
    await c.burner.write.setBurner([c.burnerKeeper.account.address, false]);
    await viem.assertions.revertWithCustomError(
      c.burner.write.burn([c.usdg.address, parseUnits("1", 6), 1n, "0x"], { account: c.burnerKeeper.account }),
      c.burner,
      "NotBurner",
    );
  });

  it("a minimum output the venue cannot meet reverts the whole burn (no bad fills)", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);
    await c.burner.write.setBurnToken([c.meme.address]);
    await assert.rejects(
      c.burner.write.burn([c.usdg.address, parseUnits("1", 6), parseEther("5000"), "0x"], { account: c.burnerKeeper.account }),
      /InsufficientOutput/,
    );
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("1", 6)); // untouched
    assert.equal(await c.meme.read.balanceOf([DEAD]), 0n);
  });

  it("the owner can name the token and change it as often as they like; it must be a contract, and not the same one twice", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await assert.rejects(c.burner.write.setBurnToken([c.meme.address], { account: c.stranger.account }));
    await viem.assertions.revertWithCustomError(c.burner.write.setBurnToken([c.stranger.account.address]), c.burner, "NotAToken");
    await c.burner.write.setBurnToken([c.meme.address]);
    assert.equal(getAddress(await c.burner.read.burnToken()), getAddress(c.meme.address));
    await viem.assertions.revertWithCustomError(c.burner.write.setBurnToken([c.meme.address]), c.burner, "SameToken");
    await c.burner.write.setBurnToken([c.aapl.address]); // a second token
    assert.equal(getAddress(await c.burner.read.burnToken()), getAddress(c.aapl.address));
    await c.burner.write.setBurnToken([c.meme.address]); // and back
    assert.equal(getAddress(await c.burner.read.burnToken()), getAddress(c.meme.address));
  });

  it("after a switch, the burned count follows the current token and what is left of the old one can still be burned by anyone", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.burner.write.setBurnToken([c.meme.address]);
    await c.meme.write.mint([c.burner.address, parseEther("10")]);
    await c.burner.write.burnHeld({ account: c.stranger.account });
    assert.equal(await c.burner.read.totalBurned(), parseEther("10"));
    await c.meme.write.mint([c.burner.address, parseEther("7")]); // arrives, then the owner switches before it is burned
    await c.burner.write.setBurnToken([c.aapl.address]);
    assert.equal(await c.burner.read.totalBurned(), 0n, "a new token starts at zero");
    await viem.assertions.revertWithCustomError(c.burner.write.burnHeldToken([c.usdg.address], { account: c.stranger.account }), c.burner, "NotAProjectToken");
    await c.burner.write.burnHeldToken([c.meme.address], { account: c.stranger.account });
    assert.equal(await c.meme.read.balanceOf([DEAD]), parseEther("17"));
    assert.equal(await c.burner.read.burnedOf([c.meme.address]), parseEther("17"));
    assert.equal(await c.burner.read.totalBurned(), 0n);
  });

  it("burnHeld sends tokens that landed here directly to the dead address, and anyone may call it", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.burner.write.setBurnToken([c.meme.address]);
    await viem.assertions.revertWithCustomError(c.burner.write.burnHeld({ account: c.stranger.account }), c.burner, "NothingToBurn");
    await c.meme.write.mint([c.burner.address, parseEther("123")]);
    await c.burner.write.burnHeld({ account: c.stranger.account });
    assert.equal(await c.meme.read.balanceOf([DEAD]), parseEther("123"));
    assert.equal(await c.burner.read.totalBurned(), parseEther("123"));
    // swapping the project token for itself is not a thing
    await viem.assertions.revertWithCustomError(
      c.burner.write.burn([c.meme.address, 1n, 0n, "0x"], { account: c.burnerKeeper.account }),
      c.burner,
      "UseBurnHeld",
    );
  });

  it("recovery is only possible if no token ever launched, and only after the deadline", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);

    // before the deadline: no
    await viem.assertions.revertWithCustomError(c.burner.write.recoverIfNoToken([c.usdg.address, c.admin.account.address]), c.burner, "RecoveryNotAllowed");

    await networkHelpers.time.increase(30 * DAY + 10);
    await assert.rejects(c.burner.write.recoverIfNoToken([c.usdg.address, c.admin.account.address], { account: c.stranger.account })); // owner only
    await c.burner.write.recoverIfNoToken([c.usdg.address, c.admin.account.address]);
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), 0n);
    assert.equal(await c.usdg.read.balanceOf([c.admin.account.address]), parseUnits("1", 6));
  });

  it("once a token is set, recovery is closed for good, even after the deadline", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await tradeOnce(c);
    await c.burner.write.setBurnToken([c.meme.address]);
    await networkHelpers.time.increase(400 * DAY);
    await viem.assertions.revertWithCustomError(c.burner.write.recoverIfNoToken([c.usdg.address, c.admin.account.address]), c.burner, "RecoveryNotAllowed");
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("1", 6)); // the owner cannot take the fees
  });

  it("ownership moves in two steps", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.burner.write.transferOwnership([c.stranger.account.address]);
    assert.notEqual(getAddress(await c.burner.read.owner()), getAddress(c.stranger.account.address));
    await c.burner.write.acceptOwnership({ account: c.stranger.account });
    assert.equal(getAddress(await c.burner.read.owner()), getAddress(c.stranger.account.address));
  });
});
