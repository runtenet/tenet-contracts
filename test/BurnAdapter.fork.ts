/**
 * The burn through a Pons bonding curve, on a fork of Robinhood Chain mainnet, against the REAL curve of a token launched on Pons today
 * and the REAL Uniswap v4 adapter. Nothing is spent and nothing is written to mainnet.
 *
 *   FORK=1 npx hardhat test test/BurnAdapter.fork.ts --network rhFork
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, erc20Abi, getAddress, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";

const RUN = process.env.FORK === "1";
const dep = JSON.parse(readFileSync(new URL("../deployments/4663.json", import.meta.url), "utf8"));
const WETH: Address = dep.tokens.find((t: any) => t.symbol === "WETH").address;
const USDG: Address = dep.tokens.find((t: any) => t.symbol === "USDG").address;
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

// a token launched on Pons: its own curve contract sells it for native ETH until it graduates
const YIELD: Address = "0x87d0d652115f5d269583a42d9b893d17fc751782";
const YIELD_CURVE: Address = "0xAC9F53F3a4624CB825BC7E31fdB943C5C2dC5cD3";
const VITAL: Address = "0x4806d712121087be3b132f77ed073a65bc5a40b5";
const wethAbi = parseAbi(["function deposit() payable"]);
const curveAbi = parseAbi(["function realQuoteReserve() view returns (uint256)", "function graduationThreshold() view returns (uint256)"]);

const hopsAbi = [
  {
    type: "tuple[]",
    components: [
      { name: "key", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;
const route = (mode: number, payload: Hex): Hex => encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [mode, payload]);

describe("burn through a Pons curve (fork)", { skip: !RUN }, async () => {
  const { viem, networkHelpers } = await network.create({ network: "rhFork" } as never);
  const pc = await viem.getPublicClient();
  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  const setup = async () => {
    await networkHelpers.mine(1); // the fork block itself has no hardfork history: read from a block above it
    const [owner, stranger] = await viem.getWalletClients();
    const adapter = await viem.deployContract("BurnAdapter", [owner.account.address, dep.adapters[0].address, WETH]);
    const burner = await viem.deployContract("FeeBurner", [owner.account.address, adapter.address, 365n * 86400n]);
    await burner.write.setBurner([owner.account.address, true]);
    return { owner, stranger, adapter, burner };
  };

  it("only the owner allows a curve, and only a curve that sells the right token", async () => {
    const { stranger, adapter, burner } = await setup();
    await viem.assertions.revertWithCustomError(adapter.write.setCurve([YIELD_CURVE, true], { account: stranger.account }), adapter, "OwnableUnauthorizedAccount");
    await adapter.write.setCurve([YIELD_CURVE, true]);
    assert.equal(await adapter.read.isCurveAllowed([YIELD_CURVE]), true);

    // the burner asks for VITAL but names YIELD's curve
    await burner.write.setBurnToken([VITAL]);
    const [owner] = await viem.getWalletClients();
    await owner.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.01") });
    await (await viem.getContractAt("TestToken", WETH)).write.transfer([burner.address, parseEther("0.01")]).catch(() => undefined);
    const data = route(1, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [YIELD_CURVE, "0x"]));
    await viem.assertions.revertWithCustomError(burner.write.burn([WETH, parseEther("0.005"), 0n, data]), adapter, "NotThisCurve");

    // a curve nobody allowed
    await adapter.write.setCurve([YIELD_CURVE, false]);
    await burner.write.setBurnToken([YIELD]);
    await viem.assertions.revertWithCustomError(
      burner.write.burn([WETH, parseEther("0.005"), 0n, route(1, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [YIELD_CURVE, "0x"]))]),
      adapter,
      "CurveNotAllowed",
    );
  });

  it("WETH in the burner becomes tokens on the curve and the tokens are burned; the adapter keeps nothing", async () => {
    const { owner, adapter, burner } = await setup();
    await adapter.write.setCurve([YIELD_CURVE, true]);
    await burner.write.setBurnToken([YIELD]);

    await owner.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.02") });
    const weth = await viem.getContractAt("TestToken", WETH);
    await weth.write.transfer([burner.address, parseEther("0.02")]);

    const deadBefore = await bal(YIELD, DEAD);
    const data = route(1, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [YIELD_CURVE, "0x"]));
    await burner.write.burn([WETH, parseEther("0.02"), 1n, data]);

    const burned = await burner.read.totalBurned();
    assert.ok(burned > 0n, "tokens were bought and burned");
    assert.equal((await bal(YIELD, DEAD)) - deadBefore, burned, "all of it went to the dead address");
    assert.equal(await bal(YIELD, burner.address), 0n, "the burner keeps none");
    assert.equal(await bal(WETH, burner.address), 0n, "the burner spent the WETH");
    assert.equal(await bal(YIELD, adapter.address), 0n);
    assert.equal(await bal(WETH, adapter.address), 0n);
    assert.equal(await pc.getBalance({ address: adapter.address }), 0n, "the adapter holds no ETH");
    console.log(`   burned ${Number(burned) / 1e18} YIELD for 0.02 ETH`);
  });

  it("a fee token (USDG) is swapped to WETH along the allowed pools first, then buys on the curve; the old route (mode 0) still works", async () => {
    const { owner, adapter, burner } = await setup();
    await adapter.write.setCurve([YIELD_CURVE, true]);
    await burner.write.setBurnToken([YIELD]);

    // USDG: take what the real burner holds (a few thousandths of a cent is enough to prove the route)
    const real = getAddress(dep.burner);
    const held = await bal(USDG, real);
    if (held === 0n) return console.log("   (the real burner holds no USDG on this fork: skipped)");
    await networkHelpers.setBalance(real, parseEther("1"));
    await networkHelpers.impersonateAccount(real);
    const realW = await viem.getWalletClient(real);
    await realW.writeContract({ address: USDG, abi: erc20Abi, functionName: "transfer", args: [burner.address, held / 2n] }); // half: the next test uses the rest

    const usdgPool = dep.pools.find((p: any) => p.quote === "USDG" && p.symbol === "WETH");
    const pre = encodeAbiParameters(hopsAbi as never, [[{ key: usdgPool.key, hookData: "0x" }]] as never);
    const data = route(1, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [YIELD_CURVE, pre]));
    await burner.write.burn([USDG, held / 2n, 1n, data]);
    assert.ok((await burner.read.totalBurned()) > 0n, "USDG ended as burned tokens");
    assert.equal(await bal(USDG, adapter.address), 0n);
    assert.equal(await bal(WETH, adapter.address), 0n);
    assert.equal(await pc.getBalance({ address: adapter.address }), 0n);

    // the old route through the pools is untouched: a pools route for a token with no pool is refused by the pools adapter, not by us
    const pools = route(0, encodeAbiParameters(hopsAbi as never, [[{ key: usdgPool.key, hookData: "0x" }]] as never));
    await owner.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.001") });
    await assert.rejects(burner.write.burn([WETH, 1n, 0n, pools]));
  });

  it("mode 0 (the pools) passes a swap straight to the Uniswap adapter, exactly as the burner did before", async () => {
    const { adapter } = await setup();
    const real = getAddress(dep.burner);
    const held = await bal(USDG, real);
    if (held === 0n) return console.log("   (the real burner holds no USDG on this fork: skipped)");
    await networkHelpers.setBalance(real, parseEther("1"));
    await networkHelpers.impersonateAccount(real);
    const realW = await viem.getWalletClient(real);
    await realW.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [adapter.address, held] });
    const usdgPool = dep.pools.find((p: any) => p.quote === "USDG" && p.symbol === "WETH");
    const hops = encodeAbiParameters(hopsAbi as never, [[{ key: usdgPool.key, hookData: "0x" }]] as never);
    const before = await bal(WETH, real);
    await realW.writeContract({ address: adapter.address, abi: adapter.abi, functionName: "swap", args: [USDG, WETH, held, 1n, real, route(0, hops)] });
    assert.ok((await bal(WETH, real)) > before, "WETH arrived at the recipient");
    assert.equal(await bal(USDG, adapter.address), 0n);
    assert.equal(await bal(WETH, adapter.address), 0n);
    assert.equal(await adapter.read.isPoolAllowed([usdgPool.poolId]), true, "the admin page reads the pools allowlist through this adapter");
  });

  it("LAST (it fills the curve): a buy that hits the limit gives the unspent ETH back, a minimum that is too high reverts, and a graduated curve is refused", async () => {
    const { owner, adapter, burner } = await setup();
    await adapter.write.setCurve([YIELD_CURVE, true]);
    await burner.write.setBurnToken([YIELD]);
    const weth = await viem.getContractAt("TestToken", WETH);
    const data = route(1, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [YIELD_CURVE, "0x"]));

    await owner.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("30") });
    await weth.write.transfer([burner.address, parseEther("30")]);
    // too high a minimum: refused, nothing moves
    await assert.rejects(burner.write.burn([WETH, parseEther("0.01"), 10n ** 30n, data])); // the curve itself refuses (SlippageExceeded)
    assert.equal(await bal(WETH, burner.address), parseEther("30"));

    // far more than the curve can take: it stops at its limit
    const room = ((await pc.readContract({ address: YIELD_CURVE, abi: curveAbi, functionName: "graduationThreshold" })) as bigint) - ((await pc.readContract({ address: YIELD_CURVE, abi: curveAbi, functionName: "realQuoteReserve" })) as bigint);
    await burner.write.burn([WETH, parseEther("30"), 1n, data]);
    const spent = parseEther("30") - (await bal(WETH, burner.address));
    console.log(`   room on the curve ${Number(room) / 1e18} ETH, spent ${Number(spent) / 1e18} ETH, back in the burner ${Number(await bal(WETH, burner.address)) / 1e18} WETH`);
    assert.ok((await bal(WETH, burner.address)) > 0n, "the part the curve did not take came back");
    assert.equal(await pc.getBalance({ address: adapter.address }), 0n, "the adapter holds no ETH");
    assert.equal(await bal(WETH, adapter.address), 0n);
    // the curve is full now: it graduated, so the adapter refuses it from here on and the keeper must use the pools
    await owner.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.01") });
    await weth.write.transfer([burner.address, parseEther("0.01")]);
    await viem.assertions.revertWithCustomError(burner.write.burn([WETH, parseEther("0.01"), 1n, data]), adapter, "CurveClosed");
    void zeroAddress;
  });
});
