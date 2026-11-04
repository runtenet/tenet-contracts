import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const HOUR = 3600;

async function deploy() {
  const [admin, payer, a, b, c, d, treasury] = await viem.getWalletClients();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("MockWETH", [admin.account.address]); // the pool is held as wrapped ether and paid as ETH
  const aapl = await viem.deployContract("TestToken", ["AAPL", "AAPL", 18, 0n, admin.account.address]);
  for (const [t, name, p] of [[usdg, "WETH/USD", 2000], [aapl, "AAPL/USD", 200]] as const) {
    const feed = await viem.deployContract("TestPriceFeed", [8, name, usd8(p), admin.account.address]);
    await hub.write.setFeed([t.address, feed.address, 365 * 86400]);
    await t.write.setMinter([admin.account.address, true]);
  }
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);
  await usdg.write.setMinter([adapter.address, true]);
  await aapl.write.setMinter([adapter.address, true]);
  await hub.write.setAdapter([adapter.address, true]);

  // the project token lives on the fee burner; the licenses are paid in it
  const stand = await viem.deployContract("TestToken", ["stand-in", "X", 18, 0n, admin.account.address]);
  const burner = await viem.deployContract("FeeBurner", [admin.account.address, stand.address, 365n * 86400n]);
  const token = await viem.deployContract("TestToken", ["Project", "PRJ", 18, parseEther("1000000"), admin.account.address]);
  const licenses = await viem.deployContract("AgentLicenses", [admin.account.address, hub.address, burner.address, 500]);
  const payouts = await viem.deployContract("AuthorPayouts", [admin.account.address, usdg.address, hub.address, adapter.address, licenses.address, burner.address]);
  await payouts.write.setPayer([payer.account.address]);
  await payouts.write.setConverter([payer.account.address, true]);

  // four people with a vault each; the vault owner is the seller
  const vaults: Record<string, `0x${string}`> = {};
  for (const [name, w] of [["a", a], ["b", b], ["c", c], ["d", d]] as const) {
    await hub.write.createVault({ account: w.account });
    vaults[name] = (await hub.read.vaultsOf([w.account.address]))[0]!;
  }
  await admin.sendTransaction({ to: payouts.address, value: parseEther("1000") }); // ETH sent in is wrapped into the pool
  return { hub, usdg, aapl, adapter, burner, token, licenses, payouts, vaults, admin, payer, a, b, c, d };
}
type C = Awaited<ReturnType<typeof deploy>>;
const sell = (c: C, w: "a" | "b" | "c" | "d", open = true) => c.licenses.write.setSeries([c.vaults[w]!, parseUnits("10", 18), 0, open], { account: c[w].account });
const pay = (c: C, ...ws: ("a" | "b" | "c" | "d")[]) => c.payouts.write.payout([ws.map((w) => c.vaults[w]!)], { account: c.payer.account });
const pc = await viem.getPublicClient();
/** what a seller gains from one payout call (the payer pays the gas, so the seller's ETH balance moves only by the payment) */
const gained = async (c: C, w: "a" | "b" | "c" | "d", run: () => Promise<unknown>) => {
  const before = await pc.getBalance({ address: c[w].account.address });
  await run();
  return (await pc.getBalance({ address: c[w].account.address })) - before;
};

const E = (n: string) => parseEther(n);

describe("hourly author payouts (paid in ETH)", () => {
  it("pays 10% of the pool as plain ETH, split equally between everyone who has an agent on sale", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await sell(c, "a");
    await sell(c, "b");
    await sell(c, "c");
    const [a, b, d] = [
      await pc.getBalance({ address: c.a.account.address }),
      await pc.getBalance({ address: c.b.account.address }),
      await pc.getBalance({ address: c.c.account.address }),
    ];
    await pay(c, "a", "b", "c");
    // 10% of 1000 = 100, three equal shares
    const share = E("100") / 3n;
    assert.equal((await pc.getBalance({ address: c.a.account.address })) - a, share);
    assert.equal((await pc.getBalance({ address: c.b.account.address })) - b, share);
    assert.equal((await pc.getBalance({ address: c.c.account.address })) - d, share);
    assert.equal(await c.payouts.read.round(), 1n);
    const events = await c.payouts.getEvents.PaidOut();
    assert.equal(events.length, 3);
  });

  it("ETH sent straight to the contract goes into the pool", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    const before = await c.usdg.read.balanceOf([c.payouts.address]);
    await c.admin.sendTransaction({ to: c.payouts.address, value: E("5") });
    assert.equal((await c.usdg.read.balanceOf([c.payouts.address])) - before, E("5"));
    assert.equal(await pc.getBalance({ address: c.payouts.address }), 0n, "no loose ETH is left on the contract");
  });

  it("only pays vaults whose sale is open, and each seller once", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await sell(c, "a");
    await sell(c, "b", false); // closed
    // d never put anything on sale
    assert.equal(await gained(c, "a", () => pay(c, "a", "a", "b", "d")), E("100")); // the only one: the whole 10%
    assert.equal(await gained(c, "b", async () => {}), 0n);
  });

  it("the robot cannot pay anyone who is not on sale, and nobody else can start a payout", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await viem.assertions.revertWithCustomError(pay(c, "a", "b"), c.payouts, "NobodyToPay");
    await sell(c, "a");
    await viem.assertions.revertWithCustomError(c.payouts.write.payout([[c.vaults.a!]], { account: c.a.account }), c.payouts, "NotPayer");
    await viem.assertions.revertWithCustomError(c.payouts.write.payout([[]], { account: c.payer.account }), c.payouts, "BadParam");
  });

  it("pays at most once an hour, and the pool rolls on: each hour pays a tenth of what is left", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await sell(c, "a");
    assert.equal(await gained(c, "a", () => pay(c, "a")), E("100"));
    await viem.assertions.revertWithCustomError(pay(c, "a"), c.payouts, "TooEarly");
    await networkHelpers.time.increase(HOUR);
    assert.equal(await gained(c, "a", () => pay(c, "a")), E("90")); // 10% of the 900 left
    assert.equal(await c.usdg.read.balanceOf([c.payouts.address]), E("810"));
  });

  it("while the project token exists and the gate is on, a seller must hold the minimum share to be paid", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.burner.write.setBurnToken([c.token.address]);
    await sell(c, "a");
    await sell(c, "b");
    // gate: 0.05% of the 1,000,000 supply = 500 tokens. Only a holds it.
    await c.token.write.mint([c.a.account.address, parseEther("600")]);
    assert.equal(await c.payouts.read.holdsEnough([c.a.account.address]), true);
    assert.equal(await c.payouts.read.holdsEnough([c.b.account.address]), false);
    const b0 = await pc.getBalance({ address: c.b.account.address });
    assert.equal(await gained(c, "a", () => pay(c, "a", "b")), E("100"));
    assert.equal(await pc.getBalance({ address: c.b.account.address }), b0);
    // the owner can switch the gate off
    await c.payouts.write.setParams([1000, 55 * 60, 0, 300]);
    assert.equal(await c.payouts.read.holdsEnough([c.b.account.address]), true);
  });

  it("a wallet that cannot take ETH is paid the same amount as WETH instead, and the payout still goes through", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    const rejecting = await viem.deployContract("RejectingSeller", []);
    await rejecting.write.sell([c.hub.address, c.licenses.address, parseEther("10")]);
    const [vault] = await c.hub.read.vaultsOf([rejecting.address]);
    await sell(c, "a");
    await c.payouts.write.payout([[vault!, c.vaults.a!]], { account: c.payer.account });
    assert.equal(await c.usdg.read.balanceOf([rejecting.address]), E("50")); // half of 100, as WETH
    assert.equal(await pc.getBalance({ address: rejecting.address }), 0n);
    assert.equal(await c.usdg.read.balanceOf([c.payouts.address]), E("900"));
  });

  it("the owner can withdraw from the pool at any time, pause the payouts, and change the share; nobody else can", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await sell(c, "a");
    await viem.assertions.revertWithCustomError(c.payouts.write.withdraw([c.usdg.address, 1n, c.a.account.address], { account: c.a.account }), c.payouts, "OwnableUnauthorizedAccount");
    await c.payouts.write.withdraw([c.usdg.address, E("400"), c.admin.account.address]);
    assert.equal(await c.usdg.read.balanceOf([c.admin.account.address]), E("400"));
    await c.payouts.write.setPaused([true]);
    await viem.assertions.revertWithCustomError(pay(c, "a"), c.payouts, "PausedError");
    await c.payouts.write.setPaused([false]);
    await c.payouts.write.setParams([2000, 55 * 60, 5, 300]); // 20% now
    assert.equal(await gained(c, "a", () => pay(c, "a")), E("120")); // 20% of the 600 left
    await viem.assertions.revertWithCustomError(c.payouts.write.setParams([0, 55 * 60, 5, 300]), c.payouts, "BadParam");
    await viem.assertions.revertWithCustomError(c.payouts.write.setParams([1000, 60, 5, 300]), c.payouts, "BadParam"); // under 10 minutes
  });

  it("converts a fee token into the reward token (WETH) at the oracle price, only by a converter", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.aapl.write.mint([c.payouts.address, parseEther("1")]); // 1 AAPL = $200 = 0.1 ETH at $2000
    await viem.assertions.revertWithCustomError(c.payouts.write.convert([c.aapl.address, parseEther("1"), 0n, "0x"], { account: c.a.account }), c.payouts, "NotConverter");
    const before = await c.usdg.read.balanceOf([c.payouts.address]);
    await c.payouts.write.convert([c.aapl.address, parseEther("1"), 0n, "0x"], { account: c.payer.account });
    const got = (await c.usdg.read.balanceOf([c.payouts.address])) - before;
    assert.ok(got >= E("0.0995") && got <= E("0.1"), `got ${got}`); // the oracle price, less the venue's own spread
    await viem.assertions.revertWithCustomError(c.payouts.write.convert([c.usdg.address, 1n, 0n, "0x"], { account: c.payer.account }), c.payouts, "WrongToken");
  });
});
