import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, parseUnits, zeroAddress, type Address } from "viem";

const { viem, networkHelpers } = await network.create();

const Kind = { DCA: 0, StopLoss: 1, TakeProfit: 2, Rebalance: 3 } as const;
const Status = {
  Ready: 0,
  Inactive: 1,
  Paused: 2,
  Expired: 3,
  MaxRuns: 4,
  TooEarly: 5,
  PriceNotMet: 6,
  NoBalance: 7,
  OracleUnavailable: 8,
  InBand: 9,
  AdapterNotAllowed: 10,
} as const;

const usd8 = (n: number) => BigInt(Math.round(n * 1e8)); // Chainlink 8-dec answer
const usd18 = (n: number) => parseEther(String(n));
const DAY = 86_400;

async function deploy() {
  const [admin, user, operator, stranger, treasury] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("TestToken", ["Test USDG", "tUSDG", 6, parseUnits("10000", 6), admin.account.address]);
  const aapl = await viem.deployContract("TestToken", ["Test Apple", "tAAPL", 18, parseEther("10"), admin.account.address]);
  const usdgFeed = await viem.deployContract("TestPriceFeed", [8, "USDG / USD", usd8(1), admin.account.address]);
  const aaplFeed = await viem.deployContract("TestPriceFeed", [8, "AAPL / USD", usd8(200), admin.account.address]);
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);

  await hub.write.setFeed([usdg.address, usdgFeed.address, DAY]);
  await hub.write.setFeed([aapl.address, aaplFeed.address, DAY]);
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setOperator([operator.account.address, true]);
  await usdg.write.setMinter([adapter.address, true]);
  await aapl.write.setMinter([adapter.address, true]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);

  const asUser = { account: user.account };
  const asOperator = { account: operator.account };

  async function fund(token: typeof usdg, amount: bigint) {
    await token.write.mint([vault.address, amount]);
  }

  function strategy(over: Partial<StrategyInput>): StrategyInput {
    return {
      kind: Kind.DCA,
      active: true,
      tokenIn: usdg.address,
      tokenOut: aapl.address,
      adapter: adapter.address,
      amount: parseUnits("100", 6),
      triggerPrice: 0n,
      interval: DAY,
      slippageBps: 100,
      targetBps: 0,
      driftBps: 0,
      maxRuns: 0,
      runs: 0,
      lastRun: 0n,
      expiresAt: 0n,
      ...over,
    };
  }

  return { hub, usdg, aapl, usdgFeed, aaplFeed, adapter, vault, admin, user, operator, stranger, treasury, pc, asUser, asOperator, fund, strategy };
}

type StrategyInput = {
  kind: number;
  active: boolean;
  tokenIn: Address;
  tokenOut: Address;
  adapter: Address;
  amount: bigint;
  triggerPrice: bigint;
  interval: number;
  slippageBps: number;
  targetBps: number;
  driftBps: number;
  maxRuns: number;
  runs: number;
  lastRun: bigint;
  expiresAt: bigint;
};

describe("TenetHub", () => {
  it("creates a vault owned by the caller", async () => {
    const { hub, vault, user } = await networkHelpers.loadFixture(deploy);
    assert.equal(getAddress(await vault.read.owner()), getAddress(user.account.address));
    assert.equal(await hub.read.isVault([vault.address]), true);
    assert.equal(await hub.read.vaultCount(), 1n);
  });

  it("normalises 8-decimal prices to 1e18 and rejects stale ones", async () => {
    const { hub, aapl } = await networkHelpers.loadFixture(deploy);
    const [price, ok] = await hub.read.getPrice([aapl.address]);
    assert.equal(ok, true);
    assert.equal(price, usd18(200));

    await networkHelpers.time.increase(DAY + 1);
    const [, okLater] = await hub.read.getPrice([aapl.address]);
    assert.equal(okLater, false);
  });

  it("caps fees at 0.5%", async () => {
    const { hub, treasury } = await networkHelpers.loadFixture(deploy);
    await viem.assertions.revertWithCustomError(hub.write.setFees([51, 10, treasury.account.address]), hub, "FeeTooHigh");
  });
});

describe("TenetVault: DCA", () => {
  it("buys at the oracle price, pays fees and waits for the interval", async () => {
    const { vault, usdg, aapl, usdgFeed, aaplFeed, operator, treasury, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);

    const plan = await vault.read.checkStrategy([0n]);
    assert.equal(plan.status, Status.Ready);
    assert.equal(plan.amountIn, parseUnits("100", 6));

    await vault.write.execute([0n, "0x"], asOperator);

    // 100 USDG - 0.1% keeper - 0.1% protocol = 99.8 USDG -> AAPL at $200, minus 0.1% spread
    const expected = (parseEther("99.8") * 9990n) / 10000n / 200n;
    assert.equal(await aapl.read.balanceOf([vault.address]), expected);
    assert.equal(await usdg.read.balanceOf([vault.address]), parseUnits("900", 6));
    assert.equal(await usdg.read.balanceOf([operator.account.address]), parseUnits("0.1", 6));
    assert.equal(await usdg.read.balanceOf([treasury.account.address]), parseUnits("0.1", 6));

    const again = await vault.read.checkStrategy([0n]);
    assert.equal(again.status, Status.TooEarly);
    await viem.assertions.revertWithCustomError(vault.write.execute([0n, "0x"], asOperator), vault, "NotReady");

    await networkHelpers.time.increase(DAY);
    // keep the feeds fresh after the time jump
    await refreshFeeds(usdgFeed, aaplFeed);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.Ready);
  });

  it("respects a max buy price", async () => {
    const { vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({ triggerPrice: usd18(150) })], asUser);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.PriceNotMet);
  });

  it("stops after maxRuns and reports missing balance", async () => {
    const { vault, usdg, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("100", 6));
    await vault.write.createStrategy([strategy({ maxRuns: 1, interval: 60 })], asUser);
    await vault.write.execute([0n, "0x"], asOperator);
    const s = await vault.read.getStrategy([0n]);
    assert.equal(s.active, false);
    assert.equal(s.runs, 1);

    await vault.write.createStrategy([strategy({ interval: 60 })], asUser);
    assert.equal((await vault.read.checkStrategy([1n])).status, Status.NoBalance);
  });
});

describe("TenetVault: stop-loss and take-profit", () => {
  it("sells once the price falls through the trigger, then deactivates", async () => {
    const { vault, usdg, aapl, aaplFeed, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(aapl, parseEther("5"));
    await vault.write.createStrategy(
      [strategy({ kind: Kind.StopLoss, tokenIn: aapl.address, tokenOut: usdg.address, amount: parseEther("1000"), triggerPrice: usd18(180) })],
      asUser,
    );
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.PriceNotMet);

    await aaplFeed.write.setAnswer([usd8(179)]);
    const plan = await vault.read.checkStrategy([0n]);
    assert.equal(plan.status, Status.Ready);
    assert.equal(plan.amountIn, parseEther("5")); // capped at the balance

    await vault.write.execute([0n, "0x"], asOperator);
    assert.equal(await aapl.read.balanceOf([vault.address]), 0n);
    assert.ok((await usdg.read.balanceOf([vault.address])) > parseUnits("890", 6));
    assert.equal((await vault.read.getStrategy([0n])).active, false);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.Inactive);
  });

  it("takes profit above the trigger", async () => {
    const { vault, usdg, aapl, aaplFeed, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(aapl, parseEther("2"));
    await vault.write.createStrategy(
      [strategy({ kind: Kind.TakeProfit, tokenIn: aapl.address, tokenOut: usdg.address, amount: parseEther("1"), triggerPrice: usd18(250) })],
      asUser,
    );
    await aaplFeed.write.setAnswer([usd8(260)]);
    await vault.write.execute([0n, "0x"], asOperator);
    assert.equal(await aapl.read.balanceOf([vault.address]), parseEther("1"));
  });
});

describe("TenetVault: rebalance", () => {
  it("buys the risk asset when under target and sells when over", async () => {
    const { vault, usdg, aapl, usdgFeed, aaplFeed, hub, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6)); // 100% stable
    await vault.write.createStrategy(
      [strategy({ kind: Kind.Rebalance, amount: 0n, targetBps: 5000, driftBps: 500, interval: 60 })],
      asUser,
    );

    const buy = await vault.read.checkStrategy([0n]);
    assert.equal(buy.status, Status.Ready);
    assert.equal(getAddress(buy.tokenIn), getAddress(usdg.address));
    assert.equal(buy.amountIn, parseUnits("500", 6));
    await vault.write.execute([0n, "0x"], asOperator);

    assert.equal((await vault.read.checkStrategy([0n])).status, Status.TooEarly);
    await networkHelpers.time.increase(61);
    await refreshFeeds(usdgFeed, aaplFeed);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.InBand);

    // AAPL doubles: the risk side is now ~67% of the vault
    await aaplFeed.write.setAnswer([usd8(400)]);
    const sell = await vault.read.checkStrategy([0n]);
    assert.equal(sell.status, Status.Ready);
    assert.equal(getAddress(sell.tokenIn), getAddress(aapl.address));
    await vault.write.execute([0n, "0x"], asOperator);

    const [pA] = await hub.read.getPrice([usdg.address]);
    const [pB] = await hub.read.getPrice([aapl.address]);
    const valA = ((await usdg.read.balanceOf([vault.address])) * pA) / 10n ** 6n;
    const valB = ((await aapl.read.balanceOf([vault.address])) * pB) / 10n ** 18n;
    const weightB = Number((valB * 10000n) / (valA + valB));
    assert.ok(weightB > 4900 && weightB < 5100, `weight ${weightB}`);
  });

  it("caps the trade size per run", async () => {
    const { vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy(
      [strategy({ kind: Kind.Rebalance, amount: usd18(100), targetBps: 5000, driftBps: 500, interval: 60 })],
      asUser,
    );
    assert.equal((await vault.read.checkStrategy([0n])).amountIn, parseUnits("100", 6));
  });
});

describe("TenetVault: safety", () => {
  it("only the owner or an operator can execute", async () => {
    const { vault, usdg, user, stranger, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);
    await viem.assertions.revertWithCustomError(vault.write.execute([0n, "0x"], { account: stranger.account }), vault, "NotOperator");
    // the owner can run their own strategy, without a keeper fee
    await vault.write.execute([0n, "0x"], { account: user.account });
  });

  it("only the owner can manage strategies and withdraw", async () => {
    const { vault, usdg, stranger, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    const as = { account: stranger.account };
    await viem.assertions.revertWithCustomError(vault.write.createStrategy([strategy({})], as), vault, "NotOwner");
    await viem.assertions.revertWithCustomError(vault.write.withdraw([usdg.address, 1n, stranger.account.address], as), vault, "NotOwner");
    await viem.assertions.revertWithCustomError(vault.write.setPaused([true], as), vault, "NotOwner");
  });

  it("the owner can always withdraw, even when everything is paused", async () => {
    const { hub, vault, usdg, user, asUser, fund } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await hub.write.setExecutionsPaused([true]);
    await vault.write.setPaused([true], asUser);
    await vault.write.withdraw([usdg.address, parseUnits("1000", 6), user.account.address], asUser);
    assert.equal(await usdg.read.balanceOf([user.account.address]), parseUnits("1000", 6));
  });

  it("pauses block execution", async () => {
    const { hub, vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);
    await vault.write.setPaused([true], asUser);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.Paused);
    await vault.write.setPaused([false], asUser);
    await hub.write.setExecutionsPaused([true]);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.Paused);
  });

  it("a cheating venue cannot drain the vault", async () => {
    const { hub, vault, usdg, asUser, asOperator, fund, strategy } = await networkHelpers.loadFixture(deploy);
    const bad = await viem.deployContract("MaliciousAdapter");
    await hub.write.setAdapter([bad.address, true]);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({ adapter: bad.address })], asUser);
    await viem.assertions.revertWithCustomError(vault.write.execute([0n, "0x"], asOperator), vault, "SlippageExceeded");
    assert.equal(await usdg.read.balanceOf([vault.address]), parseUnits("1000", 6));
  });

  it("a de-listed adapter stops the strategy", async () => {
    const { hub, adapter, vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);
    await hub.write.setAdapter([adapter.address, false]);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.AdapterNotAllowed);
  });

  it("a stale oracle stops the strategy", async () => {
    const { vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);
    await networkHelpers.time.increase(DAY + 1);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.OracleUnavailable);
  });

  it("rejects invalid strategies", async () => {
    const { vault, usdg, asUser, strategy } = await networkHelpers.loadFixture(deploy);
    const bad = (s: Partial<StrategyInput>) => viem.assertions.revertWithCustomError(vault.write.createStrategy([strategy(s)], asUser), vault, "InvalidStrategy");
    await bad({ slippageBps: 1001 });
    await bad({ interval: 10 });
    await bad({ amount: 0n });
    await bad({ tokenOut: usdg.address });
    await bad({ adapter: zeroAddress });
    await bad({ kind: Kind.StopLoss, triggerPrice: 0n });
    await bad({ kind: Kind.Rebalance, targetBps: 10000, driftBps: 100 });
  });

  it("the owner can cancel", async () => {
    const { vault, usdg, asUser, fund, strategy } = await networkHelpers.loadFixture(deploy);
    await fund(usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([strategy({})], asUser);
    await vault.write.cancelStrategy([0n], asUser);
    assert.equal((await vault.read.checkStrategy([0n])).status, Status.Inactive);
  });

  it("implementation cannot be initialised", async () => {
    const { hub, stranger } = await networkHelpers.loadFixture(deploy);
    const impl = await viem.getContractAt("TenetVault", await hub.read.vaultImplementation());
    await viem.assertions.revertWithCustomError(impl.write.initialize([stranger.account.address]), impl, "InvalidInitialization");
  });
});

type Feed = Awaited<ReturnType<typeof deploy>>["aaplFeed"];

/** Re-post the current answers so feeds are fresh after a time jump. */
async function refreshFeeds(...feeds: Feed[]) {
  for (const feed of feeds) {
    const [, answer] = await feed.read.latestRoundData();
    await feed.write.setAnswer([answer]);
  }
}
