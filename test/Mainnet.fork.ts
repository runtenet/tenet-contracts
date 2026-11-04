/**
 * Runs the real protocol contracts against a fork of Robinhood Chain mainnet:
 * real PoolManager, real Uniswap v4 pools and hooks, real Chainlink feeds, real stock tokens, real WETH.
 * Nothing is spent; the fork is local.
 *
 *   npm run test:fork -w contracts        (or: FORK=1 npx hardhat test test/Mainnet.fork.ts --network rhFork)
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
/** adapterData for a path of one or more pools (each a PoolKey) */
const path = (...keys: any[]) => encodeAbiParameters(hopsAbi, [keys.map((key) => ({ key, hookData: "0x" as const }))]);

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

// A pool the discovery script found and the quote check rejected: its hook returns absurd prices.
const BAIT_KEY = {
  currency0: getAddress("0x322f0929c4625ed5bad873c95208d54e1c003b2d"), // TSLA
  currency1: getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"), // USDG
  fee: 8388608, tickSpacing: 60, hooks: getAddress("0x71d4ced41796986c3b7b800f7af68d1e813640c8"),
};

describe("mainnet fork: UniswapV4Adapter + TenetVault", { skip: !RUN }, async () => {
  const { viem, networkHelpers } = await network.create({ network: "rhFork" } as never);
  const pc = await viem.getPublicClient();

  const token = (sym: string) => (sym === "USDG" ? cfg.usdg : sym === "WETH" ? cfg.weth : cfg.tokens.find((t: any) => t.symbol === sym));
  const poolsOf = (symbol: string, kind: string) => cfg.pools.filter((p: any) => p.symbol === symbol && p.kind === kind);
  const usdgPools = (sym: string) => poolsOf(sym, "stock/USDG");
  const wethPools = (sym: string) => poolsOf(sym, "stock/WETH");
  const wethUsdg = () => poolsOf("WETH", "WETH/USDG");
  const usdg: Address = cfg.usdg.address;
  const weth: Address = cfg.weth.address;

  async function deploy(opts: { allow?: any[] } = {}) {
    const [admin, user, operator, treasury] = await viem.getWalletClients();
    const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
    const adapter = await viem.deployContract("UniswapV4Adapter", [cfg.poolManager, admin.account.address]);

    for (const t of [cfg.usdg, cfg.weth, token("AAPL"), token("TSLA"), token("NVDA")]) {
      await hub.write.setFeed([t.address, t.feed, t.maxStaleness]);
      if (t.kind === "stock") await hub.write.setTokenPauseCheck([t.address, true]);
    }
    await hub.write.setAdapter([adapter.address, true]);
    await hub.write.setOperator([operator.account.address, true]);
    for (const p of opts.allow ?? [...usdgPools("AAPL"), ...usdgPools("NVDA"), ...wethPools("NVDA"), ...wethUsdg()]) await adapter.write.setPool([p.key, true]);

    await hub.write.createVault({ account: user.account });
    const [vaultAddr] = await hub.read.vaultsOf([user.account.address]);
    const vault = await viem.getContractAt("TenetVault", vaultAddr);
    return { hub, adapter, vault, admin, user, operator, treasury };
  }

  /** Move real tokens out of the PoolManager (it holds every pool's reserves) into `to`. */
  async function fund(to: Address, tokenAddr: Address, amount: bigint) {
    const pm = getAddress(cfg.poolManager);
    await networkHelpers.setBalance(pm, parseEther("1"));
    await networkHelpers.impersonateAccount(pm);
    const wallet = await viem.getWalletClient(pm);
    const hash = await wallet.writeContract({ address: tokenAddr, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
    await pc.waitForTransactionReceipt({ hash });
  }

  /** Wrap real ETH with the real WETH contract and send the WETH to `to` (what the website does for "deposit ETH"). */
  async function fundWeth(to: Address, amount: bigint) {
    const [admin] = await viem.getWalletClients();
    await pc.waitForTransactionReceipt({ hash: await admin.writeContract({ address: weth, abi: wethAbi, functionName: "deposit", value: amount }) });
    await pc.waitForTransactionReceipt({ hash: await admin.writeContract({ address: weth, abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });
  }

  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const price = async (hub: any, t: Address) => Number((await hub.read.getPrice([t]))[0] / 10n ** 12n) / 1e6;

  // The aggregator hooks guard against a pool price that drifted from the oracle, so any single pool may refuse at a
  // given moment. The keeper therefore simulates routes in order and sends the first that passes. The tests do the same.
  type Route = { label: string; data: `0x${string}` };
  const label = (p: any) => `${p.symbol}/${p.quote}@${p.key.hooks.slice(0, 8)}`;
  const single = (pools: any[]): Route[] => pools.map((p) => ({ label: label(p), data: path(p.key) }));
  const twoHop = (first: any[], second: any[]): Route[] =>
    first.flatMap((a) => second.map((b) => ({ label: `${label(a)} > ${label(b)}`, data: path(a.key, b.key) })));

  async function execAny(vault: any, operator: any, routes: Route[]) {
    const errors: string[] = [];
    for (const r of routes) {
      try {
        await vault.simulate.execute([0n, r.data], { account: operator.account });
      } catch (e: any) {
        errors.push(`${r.label}: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 70)}`);
        continue;
      }
      await vault.write.execute([0n, r.data], { account: operator.account });
      if (errors.length) console.log(`    (skipped ${errors.length} route(s) that the market refused right now; used ${r.label})`);
      return r.label;
    }
    throw new Error("no route worked: " + errors.join(" | "));
  }

  async function burnAny(burner: any, operator: any, feeToken: Address, amount: bigint, routes: Route[]) {
    const errors: string[] = [];
    for (const r of routes) {
      try {
        await burner.simulate.burn([feeToken, amount, 1n, r.data], { account: operator.account });
      } catch (e: any) {
        errors.push(`${r.label}: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 70)}`);
        continue;
      }
      await burner.write.burn([feeToken, amount, 1n, r.data], { account: operator.account });
      return r.label;
    }
    throw new Error("no burn route worked: " + errors.join(" | "));
  }

  const dca = (adapter: Address, tokenIn: Address, tokenOut: Address, amount: bigint) => ({
    kind: 0, active: true, tokenIn, tokenOut, adapter,
    amount, triggerPrice: 0n, interval: 60, slippageBps: 150, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n,
  });
  const takeProfit = (adapter: Address, tokenIn: Address, tokenOut: Address, amount: bigint) => ({
    kind: 2, active: true, tokenIn, tokenOut, adapter,
    amount, triggerPrice: parseEther("1"), interval: 0, slippageBps: 150, targetBps: 0, driftBps: 0,
    maxRuns: 0, runs: 0, lastRun: 0n, expiresAt: 0n,
  });

  // ------------------------------------------------------------------ USDG <-> stock (single hop)

  it("buys real AAPL with real USDG on every allowlisted pool, within the oracle band", async () => {
    const snapshot = await networkHelpers.takeSnapshot(); // every pool starts from the same fork state
    let worked = 0;
    for (const p of usdgPools("AAPL")) {
      await snapshot.restore();
      const { hub, adapter, vault, user, operator } = await deploy();
      await fund(vault.address, usdg, parseUnits("1000", 6));
      await vault.write.createStrategy([dca(adapter.address, usdg, token("AAPL").address, parseUnits("100", 6))], { account: user.account });

      const before = await bal(token("AAPL").address, vault.address);
      try {
        await vault.simulate.execute([0n, path(p.key)], { account: operator.account });
      } catch (e: any) {
        console.log(`    AAPL via ${p.key.hooks.slice(0, 8)}: refused by the market right now (${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 60)})`);
        continue;
      }
      worked++;
      await vault.write.execute([0n, path(p.key)], { account: operator.account });
      const got = (await bal(token("AAPL").address, vault.address)) - before;

      const paidPx = (100 * (1 - 0.002)) / (Number(got / 10n ** 9n) / 1e9); // minus 0.1% keeper + 0.1% protocol
      const dev = (paidPx / (await price(hub, token("AAPL").address)) - 1) * 100;
      console.log(`    AAPL via ${p.key.hooks.slice(0, 8)}: got ${Number(got) / 1e18} AAPL, ${dev.toFixed(3)}% vs oracle`);
      assert.ok(got > 0n);
      assert.ok(Math.abs(dev) < 1.5, `deviation ${dev}%`);
      assert.equal(await bal(usdg, vault.address), parseUnits("900", 6)); // spent exactly 100
      assert.equal(await bal(usdg, adapter.address), 0n); // the adapter keeps nothing
      assert.equal(await bal(token("AAPL").address, adapter.address), 0n);
    }
    assert.ok(worked >= 1, "at least one AAPL/USDG pool must fill");
  });

  it("sells real AAPL for USDG (take-profit) and leaves nothing in the adapter", async () => {
    const { adapter, vault, user, operator } = await deploy();
    await fund(vault.address, token("AAPL").address, parseEther("2"));
    await vault.write.createStrategy([takeProfit(adapter.address, token("AAPL").address, usdg, parseEther("1"))], { account: user.account });
    assert.equal((await vault.read.checkStrategy([0n])).status, 0);
    await execAny(vault, operator, single(usdgPools("AAPL")));
    const usdgBal = await bal(usdg, vault.address);
    console.log(`    sold 1 AAPL for ${Number(usdgBal) / 1e6} USDG`);
    assert.ok(usdgBal > parseUnits("300", 6));
    assert.equal(await bal(token("AAPL").address, vault.address), parseEther("1"));
    assert.equal(await bal(usdg, adapter.address), 0n);
    assert.equal(await bal(token("AAPL").address, adapter.address), 0n);
  });

  // ------------------------------------------------------------------ paying with ETH (WETH)

  it("buys real NVDA with real WETH straight through a stock/WETH pool", async () => {
    const { hub, adapter, vault, user, operator } = await deploy();
    await fundWeth(vault.address, parseEther("0.3"));
    await vault.write.createStrategy([dca(adapter.address, weth, token("NVDA").address, parseEther("0.04"))], { account: user.account });
    assert.equal((await vault.read.checkStrategy([0n])).status, 0);

    const before = await bal(token("NVDA").address, vault.address);
    await execAny(vault, operator, single(wethPools("NVDA")));
    const got = (await bal(token("NVDA").address, vault.address)) - before;

    const usdSpent = 0.04 * (1 - 0.002) * (await price(hub, weth));
    const dev = (usdSpent / (Number(got / 10n ** 9n) / 1e9) / (await price(hub, token("NVDA").address)) - 1) * 100;
    console.log(`    0.04 WETH -> ${Number(got) / 1e18} NVDA, ${dev.toFixed(3)}% vs oracle`);
    assert.ok(got > 0n);
    assert.ok(Math.abs(dev) < 1.5, `deviation ${dev}%`);
    assert.equal(await bal(weth, vault.address), parseEther("0.3") - parseEther("0.04"));
    assert.equal(await bal(weth, adapter.address), 0n);
  });

  it("buys real AAPL with real WETH in TWO hops (WETH -> USDG -> AAPL) and the middle token never lands anywhere", async () => {
    const { hub, adapter, vault, user, operator } = await deploy();
    await fundWeth(vault.address, parseEther("0.3"));
    await vault.write.createStrategy([dca(adapter.address, weth, token("AAPL").address, parseEther("0.04"))], { account: user.account });

    const before = await bal(token("AAPL").address, vault.address);
    await execAny(vault, operator, twoHop(wethUsdg(), usdgPools("AAPL")));
    const got = (await bal(token("AAPL").address, vault.address)) - before;

    const usdSpent = 0.04 * (1 - 0.002) * (await price(hub, weth));
    const dev = (usdSpent / (Number(got / 10n ** 9n) / 1e9) / (await price(hub, token("AAPL").address)) - 1) * 100;
    console.log(`    0.04 WETH -> ${Number(got) / 1e18} AAPL in two hops, ${dev.toFixed(3)}% vs oracle`);
    assert.ok(got > 0n);
    assert.ok(Math.abs(dev) < 1.5, `deviation ${dev}%`);
    // the intermediate USDG was netted out inside the PoolManager
    assert.equal(await bal(usdg, vault.address), 0n);
    assert.equal(await bal(usdg, adapter.address), 0n);
    assert.equal(await bal(weth, adapter.address), 0n);
    assert.equal(await bal(token("AAPL").address, adapter.address), 0n);
  });

  it("sells real AAPL into ETH in two hops (AAPL -> USDG -> WETH)", async () => {
    const { hub, adapter, vault, user, operator } = await deploy();
    await fund(vault.address, token("AAPL").address, parseEther("2"));
    await vault.write.createStrategy([takeProfit(adapter.address, token("AAPL").address, weth, parseEther("1"))], { account: user.account });
    assert.equal((await vault.read.checkStrategy([0n])).status, 0);

    await execAny(vault, operator, twoHop(usdgPools("AAPL"), wethUsdg()));
    const gotWeth = Number(await bal(weth, vault.address)) / 1e18;
    const expected = ((await price(hub, token("AAPL").address)) / (await price(hub, weth))) * (1 - 0.002);
    const dev = (gotWeth / expected - 1) * 100;
    console.log(`    1 AAPL -> ${gotWeth.toFixed(5)} WETH (${dev.toFixed(3)}% vs oracle)`);
    assert.ok(gotWeth > 0);
    assert.ok(Math.abs(dev) < 1.5, `deviation ${dev}%`);
    assert.equal(await bal(usdg, vault.address), 0n);
    assert.equal(await bal(usdg, adapter.address), 0n);
  });

  it("ETH in, ETH out: wrap with the real WETH, trade, then unwrap what was left", async () => {
    const { adapter, vault, user, operator } = await deploy();
    await fundWeth(vault.address, parseEther("0.2")); // "deposit ETH" = wrap + transfer
    await vault.write.createStrategy([dca(adapter.address, weth, token("NVDA").address, parseEther("0.04"))], { account: user.account });
    await execAny(vault, operator, single(wethPools("NVDA")));

    // "withdraw as ETH" = vault.withdraw(WETH) + WETH.withdraw
    const left = await bal(weth, vault.address);
    assert.equal(left, parseEther("0.16"));
    await vault.write.withdraw([weth, left, user.account.address], { account: user.account });
    const ethBefore = await pc.getBalance({ address: user.account.address });
    const hash = await user.writeContract({ address: weth, abi: wethAbi, functionName: "withdraw", args: [left] });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal((await pc.getBalance({ address: user.account.address })) - ethBefore + gas, left); // the ETH came back
    assert.equal(await bal(weth, user.account.address), 0n);
  });

  // ------------------------------------------------------------------ path validation

  it("rejects malformed paths before any funds move", async () => {
    const aapl = usdgPools("AAPL")[0];
    const { adapter, vault, user, operator } = await deploy({ allow: [aapl, ...wethUsdg(), ...wethPools("NVDA")] });
    await fundWeth(vault.address, parseEther("0.3"));
    await vault.write.createStrategy([dca(adapter.address, weth, token("AAPL").address, parseEther("0.04"))], { account: user.account });
    const run = (data: `0x${string}`) => vault.write.execute([0n, data], { account: operator.account });
    const wu = wethUsdg()[0].key;

    // a hop that does not continue from the previous one (after WETH->USDG the next pool must contain USDG)
    await assert.rejects(run(path(wu, wethPools("NVDA")[0].key)), /PairMismatch/);
    // the path ends on the wrong token (WETH -> USDG only, but the strategy wants AAPL)
    await assert.rejects(run(path(wu)), /PairMismatch/);
    // empty path and too many hops
    await assert.rejects(run(path()), /BadPath/);
    await assert.rejects(run(path(wu, aapl.key, aapl.key, aapl.key)), /BadPath/);
    // the second pool is real but not allowlisted
    await assert.rejects(run(path(wu, usdgPools("AAPL")[1]?.key ?? usdgPools("NVDA")[0].key)), /PoolNotAllowed|PairMismatch/);
    assert.equal(await bal(weth, vault.address), parseEther("0.3")); // nothing moved
  });

  // ------------------------------------------------------------------ fee burner (a real stock token stands in for the not-yet-launched project token)

  const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

  async function burnerFor(c: Awaited<ReturnType<typeof deploy>>, burnToken: Address) {
    const burner = await viem.deployContract("FeeBurner", [c.admin.account.address, c.adapter.address, 365n * 86400n]);
    await burner.write.setBurner([c.operator.account.address, true]);
    await c.hub.write.setFees([10, 10, burner.address]); // the whole protocol fee goes to the burner
    await burner.write.setBurnToken([burnToken]);
    return burner;
  }

  it("burns the protocol fee for real: USDG fee -> real Uniswap pool -> token -> dead address", async () => {
    const c = await deploy();
    const stand = token("AAPL").address as Address;
    const burner = await burnerFor(c, stand);
    const treasuryBefore = await bal(usdg, c.treasury.account.address); // the public test accounts hold some real tokens on mainnet
    await fund(c.vault.address, usdg, parseUnits("2000", 6));
    await c.vault.write.createStrategy([dca(c.adapter.address, usdg, token("NVDA").address, parseUnits("1000", 6))], { account: c.user.account });
    await execAny(c.vault, c.operator, single(usdgPools("NVDA")));

    const fee = await bal(usdg, burner.address);
    assert.equal(fee, parseUnits("1", 6)); // 0.1% of the 1000 USDG trade, all of it in the burner
    assert.equal((await bal(usdg, c.treasury.account.address)) - treasuryBefore, 0n); // nothing for anyone else

    const deadBefore = await bal(stand, DEAD);
    await burnAny(burner, c.operator, usdg, fee, single(usdgPools("AAPL")));
    const burned = (await bal(stand, DEAD)) - deadBefore;

    const valueUsd = (Number(burned) / 1e18) * (await price(c.hub, stand));
    console.log(`    1 USDG fee -> ${Number(burned) / 1e18} AAPL burned (${valueUsd.toFixed(4)} USD)`);
    assert.ok(burned > 0n);
    assert.ok(valueUsd > 0.985 && valueUsd < 1.015, `burned value ${valueUsd}`);
    assert.equal(await burner.read.totalBurned(), burned);
    assert.equal(await bal(usdg, burner.address), 0n); // every cent of the fee was used
    assert.equal(await bal(stand, burner.address), 0n); // and nothing is kept
  });

  it("burns a fee that arrived as ETH through TWO real pools (WETH -> USDG -> token)", async () => {
    const c = await deploy();
    const stand = token("AAPL").address as Address;
    const burner = await burnerFor(c, stand);
    await fundWeth(c.vault.address, parseEther("0.5"));
    await c.vault.write.createStrategy([dca(c.adapter.address, weth, token("NVDA").address, parseEther("0.1"))], { account: c.user.account });
    await execAny(c.vault, c.operator, single(wethPools("NVDA")));

    const fee = await bal(weth, burner.address);
    assert.equal(fee, parseEther("0.0001")); // 0.1% of 0.1 WETH

    const deadBefore = await bal(stand, DEAD);
    await burnAny(burner, c.operator, weth, fee, twoHop(wethUsdg(), usdgPools("AAPL")));
    const burned = (await bal(stand, DEAD)) - deadBefore;
    const valueUsd = (Number(burned) / 1e18) * (await price(c.hub, stand));
    const feeUsd = 0.0001 * (await price(c.hub, weth));
    console.log(`    0.0001 WETH fee (${feeUsd.toFixed(4)}) -> ${Number(burned) / 1e18} AAPL burned (${valueUsd.toFixed(4)})`);
    assert.ok(burned > 0n);
    assert.ok(Math.abs(valueUsd / feeUsd - 1) < 0.03, "two hops stay within about 3% of the fee value");
    assert.equal(await bal(weth, burner.address), 0n);
    assert.equal(await bal(usdg, burner.address), 0n); // the middle token never landed in the burner
  });

  it("the burner only follows allowlisted pools and only for its burner keeper", async () => {
    const c = await deploy({ allow: [usdgPools("NVDA")[0]] });
    const stand = token("AAPL").address as Address;
    const burner = await burnerFor(c, stand);
    await fund(burner.address, usdg, parseUnits("5", 6));
    // the AAPL pool is not on the allowlist
    await assert.rejects(burner.write.burn([usdg, parseUnits("5", 6), 1n, path(usdgPools("AAPL")[0].key)], { account: c.operator.account }), /PoolNotAllowed/);
    // and a stranger cannot burn at all
    await assert.rejects(burner.write.burn([usdg, parseUnits("5", 6), 1n, path(usdgPools("NVDA")[0].key)], { account: c.user.account }), /NotBurner/);
    assert.equal(await bal(usdg, burner.address), parseUnits("5", 6)); // nothing moved
  });

  // ------------------------------------------------------------------ safety

  it("refuses a pool that is not on the allowlist, even a perfectly good one", async () => {
    const { adapter, vault, user, operator } = await deploy();
    await fund(vault.address, usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([dca(adapter.address, usdg, token("AAPL").address, parseUnits("100", 6))], { account: user.account });
    const real = usdgPools("AAPL")[0];
    await adapter.write.setPool([real.key, false]);
    await assert.rejects(vault.write.execute([0n, path(real.key)], { account: operator.account }), /PoolNotAllowed/);
  });

  it("a bait pool that quotes absurd prices cannot hurt the vault: the oracle floor reverts the run", async () => {
    const { adapter, vault, user, operator } = await deploy();
    await adapter.write.setPool([BAIT_KEY, true]); // allowlisted on purpose: the vault must still protect itself
    await fund(vault.address, usdg, parseUnits("1000", 6));
    await vault.write.createStrategy([dca(adapter.address, usdg, token("TSLA").address, parseUnits("100", 6))], { account: user.account });
    assert.equal((await vault.read.checkStrategy([0n])).status, 0);
    await assert.rejects(vault.write.execute([0n, path(BAIT_KEY)], { account: operator.account }));
    assert.equal(await bal(usdg, vault.address), parseUnits("1000", 6)); // untouched
  });

  it("a pair that does not match the pool is rejected", async () => {
    const { adapter, vault, user, operator } = await deploy();
    await fund(vault.address, usdg, parseUnits("1000", 6));
    // strategy buys TSLA but the keeper passes an AAPL pool
    await vault.write.createStrategy([dca(adapter.address, usdg, token("TSLA").address, parseUnits("100", 6))], { account: user.account });
    await assert.rejects(vault.write.execute([0n, path(usdgPools("AAPL")[0].key)], { account: operator.account }), /PairMismatch/);
  });

  it("the live stock tokens and ETH are priced by the oracle and not paused", async () => {
    const { hub } = await deploy();
    for (const sym of ["AAPL", "TSLA", "NVDA", "WETH", "USDG"]) {
      const [p, ok] = await hub.read.getPrice([token(sym).address]);
      console.log(`    ${sym}: $${Number(p / 10n ** 12n) / 1e6} ok=${ok}`);
      assert.equal(ok, true, `${sym} should have a usable price (weekend/stale feed?)`);
    }
  });
});
