import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { maxUint256, parseEther, parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const Kind = { DCA: 0, StopLoss: 1, TakeProfit: 2, Rebalance: 3 } as const;
const Status = { Ready: 0, Inactive: 1, Expired: 3, OverAgentLimit: 12 } as const;
const usd8 = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 86_400;

async function deploy() {
  const [admin, user, operator, agent, stranger, treasury] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const usdg = await viem.deployContract("TestToken", ["USDG", "USDG", 6, 0n, admin.account.address]);
  const aapl = await viem.deployContract("TestToken", ["AAPL", "AAPL", 18, 0n, admin.account.address]);
  const tsla = await viem.deployContract("TestToken", ["TSLA", "TSLA", 18, 0n, admin.account.address]);
  for (const [t, name, p] of [[usdg, "USDG/USD", 1], [aapl, "AAPL/USD", 200], [tsla, "TSLA/USD", 400]] as const) {
    const feed = await viem.deployContract("TestPriceFeed", [8, name, usd8(p), admin.account.address]);
    await hub.write.setFeed([t.address, feed.address, 365 * DAY]);
    await t.write.setMinter([admin.account.address, true]);
  }
  const adapter = await viem.deployContract("OracleSwapAdapter", [hub.address, admin.account.address]);
  await usdg.write.setMinter([adapter.address, true]);
  await aapl.write.setMinter([adapter.address, true]);
  await tsla.write.setMinter([adapter.address, true]);
  await hub.write.setAdapter([adapter.address, true]);
  await hub.write.setOperator([operator.account.address, true]);

  await hub.write.createVault({ account: user.account });
  const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
  const vault = await viem.getContractAt("TenetVault", vaultAddr);
  await usdg.write.mint([vault.address, parseUnits("10000", 6)]);

  const strategy = (over: Record<string, unknown> = {}) => ({
    kind: Kind.DCA, active: true, tokenIn: usdg.address, tokenOut: aapl.address, adapter: adapter.address,
    amount: parseUnits("50", 6), triggerPrice: 0n, interval: 3600, slippageBps: 100, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n, ...over,
  });
  const grant = async (over: Partial<{ days: number; perStrategy: bigint; perDay: bigint; maxActive: number; minInterval: number; slippage: number; tokens: `0x${string}`[] }> = {}) => {
    const latest = Number(await networkHelpers.time.latest());
    await vault.write.setAgent(
      [agent.account.address, BigInt(latest + (over.days ?? 7) * DAY), over.perStrategy ?? parseEther("100"), over.perDay ?? parseEther("150"), over.maxActive ?? 3, over.minInterval ?? 3600, over.slippage ?? 150, over.tokens ?? [usdg.address, aapl.address]],
      { account: user.account },
    );
  };
  return { hub, vault, usdg, aapl, tsla, adapter, strategy, grant, pc, admin, user, operator, agent, stranger };
}
type C = Awaited<ReturnType<typeof deploy>>;
const asAgent = (c: C) => ({ account: c.agent.account });

describe("agent mode", () => {
  it("the agent creates a strategy inside its limits and a keeper runs it", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c));
    assert.equal(await c.vault.read.agentMade([0n]), true);
    assert.equal(await c.vault.read.agentActive(), 1);
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
    assert.ok((await c.aapl.read.balanceOf([c.vault.address])) > 0n);
  });

  it("nobody but the agent can use the agent's powers, and before any grant nobody can", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)), c.vault, "NotAgent");
    await c.grant();
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], { account: c.stranger.account }), c.vault, "NotAgent");
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], { account: c.user.account }), c.vault, "NotAgent"); // the owner uses createStrategy
    await viem.assertions.revertWithCustomError(c.vault.write.setAgent([c.agent.account.address, 1n, 1n, 1n, 1, 3600, 100, [c.usdg.address, c.aapl.address]], asAgent(c)), c.vault, "NotOwner");
    await viem.assertions.revertWithCustomError(c.vault.write.withdraw([c.usdg.address, 1n, c.agent.account.address], asAgent(c)), c.vault, "NotOwner");
    await viem.assertions.revertWithCustomError(c.vault.write.revokeAgent([true], asAgent(c)), c.vault, "NotOwner");
  });

  it("refuses a token the owner did not allow, a too-large run, an unbounded buy, a short interval and high slippage", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100") });
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ tokenOut: c.tsla.address })], asAgent(c)), c.vault, "AgentLimit");
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ amount: parseUnits("101", 6) })], asAgent(c)), c.vault, "AgentLimit");
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ interval: 600 })], asAgent(c)), c.vault, "AgentLimit");
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ slippageBps: 300 })], asAgent(c)), c.vault, "AgentLimit");
    const sell = { kind: Kind.StopLoss, tokenIn: c.aapl.address, tokenOut: c.usdg.address, triggerPrice: parseEther("150"), interval: 0 };
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ amount: maxUint256 })], asAgent(c)), c.vault, "AgentLimit"); // a repeating buy needs a real amount
  });

  it("a rebalance must carry its own cap, and a stop-loss with a sized amount is fine", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    const rebalance = { kind: Kind.Rebalance, tokenIn: c.usdg.address, tokenOut: c.aapl.address, targetBps: 5000, driftBps: 500, interval: 3600 };
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ ...rebalance, amount: 0n })], asAgent(c)), c.vault, "AgentLimit");
    await c.vault.write.agentCreateStrategy([c.strategy({ ...rebalance, amount: parseEther("80") })], asAgent(c));
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy({ ...rebalance, amount: parseEther("101") })], asAgent(c)), c.vault, "AgentLimit");
    await c.vault.write.agentCreateStrategy([c.strategy({ kind: Kind.StopLoss, tokenIn: c.aapl.address, tokenOut: c.usdg.address, amount: parseEther("0.5"), triggerPrice: parseEther("150"), interval: 0 })], asAgent(c));
  });

  it("the agent can close a whole position, but only a chunk at a time: never above one run, today's allowance, or the protocol's cap", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100"), perDay: parseEther("150") });
    await c.aapl.write.mint([c.vault.address, parseEther("2")]); // 2 x $200 = $400
    const close = { kind: Kind.StopLoss, tokenIn: c.aapl.address, tokenOut: c.usdg.address, amount: maxUint256, triggerPrice: parseEther("300"), interval: 0 };
    await c.vault.write.agentCreateStrategy([c.strategy(close)], asAgent(c));
    const created = await c.vault.read.getStrategy([0n]);
    assert.equal(created.maxRuns, 100); // it may take several runs, bounded

    const aaplLeft = () => c.aapl.read.balanceOf([c.vault.address]);
    const runToday = async () => {
      let runs = 0;
      while ((await c.vault.read.checkStrategy([0n])).status === Status.Ready) {
        const before = await aaplLeft();
        await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
        const sold = before - (await aaplLeft());
        assert.ok(sold <= parseEther("0.5"), "a chunk is never above the per-run limit of $100 (0.5 AAPL)");
        runs += 1;
      }
      return runs;
    };

    // day 1: $100 then the last $50 of the allowance, then it waits
    assert.equal(await runToday(), 2);
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.OverAgentLimit);
    assert.equal(await aaplLeft(), parseEther("1.25"));

    let days = 1;
    while ((await c.vault.read.getStrategy([0n])).active && days < 10) {
      await networkHelpers.time.increase(DAY);
      await runToday();
      days += 1;
    }
    assert.equal(days, 3); // 0.75 on day 2, the last 0.5 on day 3
    assert.equal(await aaplLeft(), 0n);
    assert.equal((await c.vault.read.getStrategy([0n])).active, false);
    assert.equal(await c.vault.read.agentActive(), 0);
    assert.ok((await c.usdg.read.balanceOf([c.vault.address])) > parseUnits("10000", 6) + parseUnits("390", 6)); // the position became dollars
  });

  it("the owner's own stop-loss with 'everything' still runs once; only the agent's closes in chunks", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.aapl.write.mint([c.vault.address, parseEther("2")]);
    await c.vault.write.createStrategy([c.strategy({ kind: Kind.StopLoss, tokenIn: c.aapl.address, tokenOut: c.usdg.address, amount: maxUint256, triggerPrice: parseEther("300"), interval: 0 })], { account: c.user.account });
    assert.equal((await c.vault.read.getStrategy([0n])).maxRuns, 1);
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
    assert.equal(await c.aapl.read.balanceOf([c.vault.address]), 0n); // all at once: it is the owner's own rule
  });

  it("limits how many strategies the agent keeps active, and frees a slot when one is cancelled by either side", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ maxActive: 2 });
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c));
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c));
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)), c.vault, "AgentLimit");
    await c.vault.write.agentCancelStrategy([0n], asAgent(c));
    assert.equal(await c.vault.read.agentActive(), 1);
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c));
    await c.vault.write.cancelStrategy([1n], { account: c.user.account }); // the owner can cancel the agent's strategy too
    assert.equal(await c.vault.read.agentActive(), 1);
  });

  it("the agent can only cancel what it made, never the owner's strategies", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    await c.vault.write.createStrategy([c.strategy()], { account: c.user.account }); // id 0: the owner's own
    await viem.assertions.revertWithCustomError(c.vault.write.agentCancelStrategy([0n], asAgent(c)), c.vault, "AgentLimit");
    assert.equal((await c.vault.read.getStrategy([0n])).active, true);
  });

  it("a daily allowance: once it is used the agent's strategies wait until the next day", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100"), perDay: parseEther("120") });
    await c.vault.write.agentCreateStrategy([c.strategy({ amount: parseUnits("100", 6), interval: 3600 })], asAgent(c));
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account }); // $100 of $120 today
    await networkHelpers.time.increase(3601);
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.OverAgentLimit); // another $100 would pass $120
    await viem.assertions.revertWithCustomError(c.vault.write.execute([0n, "0x"], { account: c.operator.account }), c.vault, "NotReady");
    await networkHelpers.time.increase(DAY);
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.Ready);
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account });
  });

  it("lowering the limits, or removing a token, stops the agent's strategies at once", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100") });
    await c.vault.write.agentCreateStrategy([c.strategy({ amount: parseUnits("80", 6) })], asAgent(c));
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.Ready);
    await c.grant({ perStrategy: parseEther("50"), perDay: parseEther("50") }); // the owner tightens the limits
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.OverAgentLimit);
    await c.grant({ tokens: [c.usdg.address, c.tsla.address] }); // aapl no longer allowed
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.OverAgentLimit);
  });

  it("when the grant expires the agent can create nothing and its strategies stop", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ days: 1 });
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c));
    await networkHelpers.time.increase(DAY + 10);
    assert.equal((await c.vault.read.checkStrategy([0n])).status, Status.Expired);
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)), c.vault, "AgentLimit");
  });

  it("revoking removes the agent at once and can stop everything it made; the owner's own strategies are untouched", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    await c.vault.write.createStrategy([c.strategy()], { account: c.user.account }); // 0: the owner's
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)); // 1
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)); // 2
    await c.vault.write.revokeAgent([true], { account: c.user.account });
    assert.equal((await c.vault.read.getStrategy([0n])).active, true);
    assert.equal((await c.vault.read.getStrategy([1n])).active, false);
    assert.equal((await c.vault.read.getStrategy([2n])).active, false);
    assert.equal(await c.vault.read.agentActive(), 0);
    await viem.assertions.revertWithCustomError(c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)), c.vault, "NotAgent");

    // revoking without cancelling leaves them in place but they cannot run without a grant
    await c.grant();
    await c.vault.write.agentCreateStrategy([c.strategy()], asAgent(c)); // 3
    await c.vault.write.revokeAgent([false], { account: c.user.account });
    assert.equal((await c.vault.read.checkStrategy([3n])).status, Status.Expired);
  });

  it("the grant itself is bounded: term, amounts, counts, tokens", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    const now = Number(await networkHelpers.time.latest());
    const set = (args: unknown[]) => c.vault.write.setAgent(args as never, { account: c.user.account });
    const ok = [c.agent.account.address, BigInt(now + 7 * DAY), parseEther("100"), parseEther("150"), 3, 3600, 150, [c.usdg.address, c.aapl.address]];
    await set(ok);
    for (const bad of [
      [...ok.slice(0, 1), BigInt(now + 200 * DAY), ...ok.slice(2)], // more than 90 days
      [...ok.slice(0, 1), BigInt(now - 1), ...ok.slice(2)], // already over
      [...ok.slice(0, 2), parseEther("100"), parseEther("50"), ...ok.slice(4)], // the day is smaller than one run
      [...ok.slice(0, 4), 0, ...ok.slice(5)], // no strategies allowed
      [...ok.slice(0, 4), 51, ...ok.slice(5)], // too many
      [...ok.slice(0, 5), 30, ...ok.slice(6)], // interval below the minimum
      [...ok.slice(0, 6), 2000, ok[7]], // slippage above 10%
      [...ok.slice(0, 7), [c.usdg.address]], // one token is not a pair
      [...ok.slice(0, 7), [c.usdg.address, c.usdg.address]], // duplicates
      ["0x0000000000000000000000000000000000000000", ...ok.slice(1)], // no agent
      [c.user.account.address, ...ok.slice(1)], // the owner cannot be its own agent
    ]) {
      await viem.assertions.revertWithCustomError(set(bad), c.vault, "AgentLimit");
    }
  });
});

describe("agent mode: direct trading", () => {
  const note = "NVDA looks cheap after the dip; adding a little at a time.";
  const trade = (c: C, over: Partial<{ tokenIn: `0x${string}`; tokenOut: `0x${string}`; amount: bigint; note: string; account: typeof c.agent }> = {}) =>
    c.vault.write.agentTrade(
      [over.tokenIn ?? c.usdg.address, over.tokenOut ?? c.aapl.address, over.amount ?? parseUnits("50", 6), c.adapter.address, "0x", over.note ?? note],
      { account: (over.account ?? c.agent).account },
    );
  const refuses = (c: C, p: Promise<unknown>, reason: string) => viem.assertions.revertWithCustomErrorWithArgs(p, c.vault, "AgentLimit", [reason]);

  it("is off until the owner switches it on, and only the owner can", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await refuses(c, c.vault.write.setAgentTrading([true], { account: c.user.account }), "no agent"); // no grant yet
    await c.grant();
    assert.equal(await c.vault.read.agentTrading(), false);
    await refuses(c, trade(c), "trading is off");
    await viem.assertions.revertWithCustomError(c.vault.write.setAgentTrading([true], asAgent(c)), c.vault, "NotOwner");
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    assert.equal(await c.vault.read.agentTrading(), true);
  });

  it("the agent swaps on its own, pays the protocol fee, and publishes why", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    const feeBefore = await c.usdg.read.balanceOf([(await c.hub.read.feeRecipient()) as `0x${string}`]);
    await trade(c);
    const events = await c.vault.getEvents.AgentTraded();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.args.note, note);
    assert.equal(events[0]!.args.amountIn, parseUnits("50", 6));
    assert.ok((events[0]!.args.amountOut ?? 0n) > 0n);
    assert.equal(await c.usdg.read.balanceOf([c.vault.address]), parseUnits("9950", 6)); // 50 spent, fee included
    assert.equal((await c.usdg.read.balanceOf([(await c.hub.read.feeRecipient()) as `0x${string}`])) - feeBefore, parseUnits("0.05", 6)); // 0.1% to the protocol
    assert.ok((await c.aapl.read.balanceOf([c.vault.address])) > 0n);
    assert.equal(await c.vault.read.agentDaySpent(), parseEther("50")); // counted against today's allowance
  });

  it("it can also SELL, because the owner turned the switch on", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perDay: parseEther("300") });
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await trade(c, { amount: parseUnits("100", 6) }); // buy about 0.5 AAPL
    await networkHelpers.time.increase(3601);
    const held = await c.aapl.read.balanceOf([c.vault.address]);
    await trade(c, { tokenIn: c.aapl.address, tokenOut: c.usdg.address, amount: held, note: "taking the profit" });
    assert.equal(await c.aapl.read.balanceOf([c.vault.address]), 0n);
  });

  it("keeps every limit the owner gave, on every trade", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100"), perDay: parseEther("150"), minInterval: 3600 });
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await viem.assertions.revertWithCustomError(trade(c, { account: c.stranger }), c.vault, "NotAgent");
    await viem.assertions.revertWithCustomError(trade(c, { account: c.user }), c.vault, "NotAgent"); // the owner trades through execute / their own strategies
    await refuses(c, trade(c, { tokenOut: c.tsla.address }), "token not allowed");
    await refuses(c, trade(c, { amount: parseUnits("101", 6) }), "size");
    await refuses(c, trade(c, { amount: 0n }), "amount");
    await refuses(c, trade(c, { amount: parseUnits("999999", 6) }), "amount"); // more than the vault holds
    await refuses(c, trade(c, { note: "x".repeat(281) }), "note");

    await trade(c, { amount: parseUnits("100", 6) });
    await refuses(c, trade(c, { amount: parseUnits("10", 6) }), "too soon"); // minInterval
    await networkHelpers.time.increase(3601);
    await refuses(c, trade(c, { amount: parseUnits("60", 6) }), "daily limit"); // 100 + 60 > 150
    await trade(c, { amount: parseUnits("50", 6) }); // 150 in all: allowed
  });

  it("shares today's allowance with the agent's strategies, and the protocol's per-trade cap still applies", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ perStrategy: parseEther("100"), perDay: parseEther("120") });
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await c.vault.write.agentCreateStrategy([c.strategy({ amount: parseUnits("100", 6) })], asAgent(c));
    await c.vault.write.execute([0n, "0x"], { account: c.operator.account }); // 100 of today's 120 used by a strategy
    await networkHelpers.time.increase(3601);
    await refuses(c, trade(c, { amount: parseUnits("30", 6) }), "daily limit");
    await c.hub.write.setMaxTradeUsd([parseEther("10")]);
    await refuses(c, trade(c, { amount: parseUnits("15", 6) }), "protocol trade cap");
  });

  it("stops with the grant: expiry, a replaced grant, a revoked agent, a paused vault", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant({ days: 2 });
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await c.vault.write.setPaused([true], { account: c.user.account });
    await refuses(c, trade(c), "paused");
    await c.vault.write.setPaused([false], { account: c.user.account });

    await c.grant({ days: 2 }); // a new grant never inherits the switch
    assert.equal(await c.vault.read.agentTrading(), false);
    await refuses(c, trade(c), "trading is off");

    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await c.vault.write.revokeAgent([false], { account: c.user.account });
    assert.equal(await c.vault.read.agentTrading(), false);
    await viem.assertions.revertWithCustomError(trade(c), c.vault, "NotAgent");

    await c.grant({ days: 1 });
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await networkHelpers.time.increase(2 * DAY);
    await refuses(c, trade(c), "expired");
    await refuses(c, c.vault.write.setAgentTrading([true], { account: c.user.account }), "no agent"); // cannot be switched on with a dead grant
  });

  it("an adapter the protocol does not allow is refused, and the agent still cannot withdraw", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.grant();
    await c.vault.write.setAgentTrading([true], { account: c.user.account });
    await refuses(c, c.vault.write.agentTrade([c.usdg.address, c.aapl.address, parseUnits("10", 6), c.stranger.account.address, "0x", note], asAgent(c)), "adapter");
    await viem.assertions.revertWithCustomError(c.vault.write.withdraw([c.usdg.address, 1n, c.agent.account.address], asAgent(c)), c.vault, "NotOwner");
  });
});
