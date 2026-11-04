import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

async function deploy() {
  const [admin, owner, depositor, stranger] = await viem.getWalletClients();
  const stand = await viem.deployContract("TestToken", ["adapter stand-in", "X", 18, 0n, admin.account.address]); // an address with code for the burner
  const burner = await viem.deployContract("FeeBurner", [admin.account.address, stand.address, 365n * 86400n]);
  const weth = await viem.deployContract("MockWETH", [admin.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, 0n, admin.account.address]);
  await usdg.write.setMinter([admin.account.address, true]);
  await usdg.write.mint([depositor.account.address, parseUnits("1000", 6)]);
  const pool = await viem.deployContract("FeePool", [owner.account.address, burner.address, weth.address, 3000]);
  await usdg.write.approve([pool.address, parseUnits("1000", 6)], { account: depositor.account });
  return { pool, burner, weth, usdg, admin, owner, depositor, stranger };
}
type C = Awaited<ReturnType<typeof deploy>>;
const put = (c: C, amount: string) => c.pool.write.deposit([c.usdg.address, parseUnits(amount, 6)], { account: c.depositor.account });

describe("fee pool", () => {
  it("burns its share of a deposit at once and keeps the rest", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await put(c, "100");
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("30", 6)); // 30% sent to the burner
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("70", 6)); // the rest stays
    assert.equal(await c.usdg.read.balanceOf([c.depositor.account.address]), parseUnits("900", 6));
    const events = await c.pool.getEvents.Deposited();
    assert.equal(events[0]!.args.burned, parseUnits("30", 6));
    assert.equal(events[0]!.args.kept, parseUnits("70", 6));
  });

  it("what is kept is never burned later, and only the owner can take it out", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await put(c, "100");
    await networkHelpers.time.increase(30 * 86400); // a month passes: nothing moves by itself
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("70", 6));
    await viem.assertions.revertWithCustomError(c.pool.write.withdraw([c.usdg.address, 1n, c.stranger.account.address], { account: c.stranger.account }), c.pool, "OwnableUnauthorizedAccount");
    await viem.assertions.revertWithCustomError(c.pool.write.withdraw([c.usdg.address, 1n, c.depositor.account.address], { account: c.depositor.account }), c.pool, "OwnableUnauthorizedAccount"); // not even who paid in
    await c.pool.write.withdraw([c.usdg.address, parseUnits("50", 6), c.owner.account.address], { account: c.owner.account });
    assert.equal(await c.usdg.read.balanceOf([c.owner.account.address]), parseUnits("50", 6));
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("20", 6));
  });

  it("a plain transfer is not a deposit: it is not burned, it is just held (and withdrawable)", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.usdg.write.transfer([c.pool.address, parseUnits("10", 6)], { account: c.depositor.account });
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), 0n);
    await c.pool.write.withdraw([c.usdg.address, parseUnits("10", 6), c.owner.account.address], { account: c.owner.account });
    assert.equal(await c.usdg.read.balanceOf([c.owner.account.address]), parseUnits("10", 6));
  });

  it("takes ETH in one step: wrapped, then split the same way", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.pool.write.depositEth({ account: c.depositor.account, value: parseEther("1") });
    assert.equal(await c.weth.read.balanceOf([c.burner.address]), parseEther("0.3"));
    assert.equal(await c.weth.read.balanceOf([c.pool.address]), parseEther("0.7"));
  });

  it("the burn share is the owner's to change, only for deposits made afterwards", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await put(c, "100");
    await viem.assertions.revertWithCustomError(c.pool.write.setBurnBps([5000], { account: c.stranger.account }), c.pool, "OwnableUnauthorizedAccount");
    await viem.assertions.revertWithCustomError(c.pool.write.setBurnBps([10001], { account: c.owner.account }), c.pool, "BadShare");
    await c.pool.write.setBurnBps([0], { account: c.owner.account }); // no burn at all
    await put(c, "100");
    assert.equal(await c.usdg.read.balanceOf([c.burner.address]), parseUnits("30", 6)); // only the first deposit burned
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("170", 6)); // the old kept 70 stayed 70, the new 100 stayed whole
  });

  it("refuses an empty deposit", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await viem.assertions.revertWithCustomError(c.pool.write.deposit([c.usdg.address, 0n], { account: c.depositor.account }), c.pool, "NothingToDeposit");
    await viem.assertions.revertWithCustomError(c.pool.write.depositEth({ account: c.depositor.account, value: 0n }), c.pool, "NothingToDeposit");
  });

  it("the owner pays several authors in one transaction, each payment is an event, and only from what the pool holds", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await put(c, "100"); // 30 burned, 70 kept
    const [a, b] = [c.stranger.account.address, c.depositor.account.address];
    await viem.assertions.revertWithCustomError(c.pool.write.payAuthors([c.usdg.address, [a], [1n], "x"], { account: c.stranger.account }), c.pool, "OwnableUnauthorizedAccount");
    await c.pool.write.payAuthors([c.usdg.address, [a, b], [parseUnits("30", 6), parseUnits("20", 6)], "week 1, by volume"], { account: c.owner.account });
    assert.equal(await c.usdg.read.balanceOf([a]), parseUnits("30", 6));
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("20", 6));
    const events = await c.pool.getEvents.AuthorPaid();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.args.note, "week 1, by volume");
    // more than the pool holds fails whole, nothing is half-paid
    await assert.rejects(c.pool.write.payAuthors([c.usdg.address, [a, b], [parseUnits("15", 6), parseUnits("15", 6)], "too much"], { account: c.owner.account }));
    assert.equal(await c.usdg.read.balanceOf([c.pool.address]), parseUnits("20", 6));
  });

  it("refuses a malformed payout", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await put(c, "100");
    const a = c.stranger.account.address;
    const pay = (to: `0x${string}`[], amounts: bigint[], note = "n") => c.pool.write.payAuthors([c.usdg.address, to, amounts, note], { account: c.owner.account });
    await viem.assertions.revertWithCustomError(pay([], []), c.pool, "BadPayout");
    await viem.assertions.revertWithCustomError(pay([a], [1n, 2n]), c.pool, "BadPayout");
    await viem.assertions.revertWithCustomError(pay([a], [0n]), c.pool, "BadPayout");
    await viem.assertions.revertWithCustomError(pay(["0x0000000000000000000000000000000000000000"], [1n]), c.pool, "BadPayout");
    await viem.assertions.revertWithCustomError(pay([a], [1n], "x".repeat(201)), c.pool, "BadPayout");
  });
});
