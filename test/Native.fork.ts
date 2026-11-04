/**
 * The native-ETH adapter against the REAL Pons pool on a fork of Robinhood Chain mainnet.
 * A token that graduated from Pons trades in a Uniswap v4 pool whose one side is native ETH (currency address(0)) and
 * whose hook is Pons's. The fee burner must be able to buy such a token with USDG or WETH fees.
 *
 *   FORK=1 npx hardhat test test/Native.fork.ts --network rhFork
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, erc20Abi, getAddress, parseEther, parseUnits, zeroAddress, type Address } from "viem";

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
const path = (...keys: any[]) => encodeAbiParameters(hopsAbi, [keys.map((key) => ({ key, hookData: "0x" as const }))]);

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

// A token that graduated from Pons (found on chain): ORBIX, in a pool against NATIVE ETH, with the shared Pons hook.
const ORBIX: Address = getAddress("0x60633794df09856b339eea8bd741d749596b5230");
const PONS_HOOK: Address = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
const ORBIX_NATIVE = { currency0: zeroAddress, currency1: ORBIX, fee: 0, tickSpacing: 200, hooks: PONS_HOOK };

describe("mainnet fork: UniswapV4NativeAdapter + FeeBurner on a real Pons pool", { skip: !RUN }, async () => {
  const { viem, networkHelpers } = await network.create({ network: "rhFork" } as never);
  const pc = await viem.getPublicClient();
  const usdg: Address = cfg.usdg.address;
  const weth: Address = cfg.weth.address;
  const wethUsdg = cfg.pools.find((p: any) => p.kind === "WETH/USDG");

  async function setup() {
    const [admin, operator] = await viem.getWalletClients();
    const adapter = await viem.deployContract("UniswapV4NativeAdapter", [cfg.poolManager, admin.account.address, weth]);
    await adapter.write.setPool([wethUsdg.key, true]);
    await adapter.write.setPool([ORBIX_NATIVE, true]);
    const burner = await viem.deployContract("FeeBurner", [admin.account.address, adapter.address, 365n * 86400n]);
    await burner.write.setBurner([operator.account.address, true]);
    await burner.write.setBurnToken([ORBIX]);
    return { admin, operator, adapter, burner };
  }

  async function fund(to: Address, token: Address, amount: bigint) {
    const pm = getAddress(cfg.poolManager);
    await networkHelpers.setBalance(pm, parseEther("1"));
    await networkHelpers.impersonateAccount(pm);
    const wallet = await viem.getWalletClient(pm);
    await pc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });
  }
  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

  const noLeftovers = async (adapter: Address) => {
    assert.equal(await pc.getBalance({ address: adapter }), 0n, "the adapter kept ETH");
    for (const t of [usdg, weth, ORBIX]) assert.equal(await bal(t, adapter), 0n, "the adapter kept a token");
  };

  it("burns a WETH fee straight into the native-ETH pool (unwrap first)", async () => {
    const { operator, adapter, burner } = await setup();
    const [admin] = await viem.getWalletClients();
    await pc.waitForTransactionReceipt({ hash: await admin.writeContract({ address: weth, abi: wethAbi, functionName: "deposit", value: parseEther("0.01") }) });
    await pc.waitForTransactionReceipt({ hash: await admin.writeContract({ address: weth, abi: erc20Abi, functionName: "transfer", args: [burner.address, parseEther("0.01")] }) });

    const before = await bal(ORBIX, DEAD);
    await burner.write.burn([weth, parseEther("0.01"), 1n, path(ORBIX_NATIVE)], { account: operator.account });
    const burned = (await bal(ORBIX, DEAD)) - before;
    console.log(`    0.01 WETH fee -> ${Number(burned) / 1e18} ORBIX burned`);
    assert.ok(burned > 0n);
    assert.equal(await burner.read.totalBurned(), burned);
    assert.equal(await bal(weth, burner.address), 0n);
    await noLeftovers(adapter.address);
  });

  it("burns a USDG fee through TWO pools: USDG -> WETH, then WETH -> native ETH -> ORBIX", async () => {
    const { operator, adapter, burner } = await setup();
    await fund(burner.address, usdg, parseUnits("20", 6));

    const before = await bal(ORBIX, DEAD);
    await burner.write.burn([usdg, parseUnits("20", 6), 1n, path(wethUsdg.key, ORBIX_NATIVE)], { account: operator.account });
    const burned = (await bal(ORBIX, DEAD)) - before;
    console.log(`    20 USDG fee -> ${Number(burned) / 1e18} ORBIX burned`);
    assert.ok(burned > 0n);
    assert.equal(await bal(usdg, burner.address), 0n);
    await noLeftovers(adapter.address);
  });

  it("refuses what it must refuse", async () => {
    const { operator, adapter, burner } = await setup();
    await fund(burner.address, usdg, parseUnits("5", 6));

    // a native pool that was never allowed
    const other = { ...ORBIX_NATIVE, tickSpacing: 60 };
    await assert.rejects(burner.write.burn([usdg, parseUnits("5", 6), 1n, path(wethUsdg.key, other)], { account: operator.account }), /PoolNotAllowed/);
    // USDG cannot jump into the native pool without WETH in between
    await assert.rejects(burner.write.burn([usdg, parseUnits("5", 6), 1n, path(ORBIX_NATIVE)], { account: operator.account }), /PairMismatch/);
    // a path that ends in native ETH is refused (the output must be an ERC-20)
    await assert.rejects(adapter.write.swap([weth, zeroAddress, 1n, 1n, operator.account.address, path(ORBIX_NATIVE)], { account: operator.account }), /BadPath/);
    // nobody can push ETH into the adapter
    await assert.rejects(operator.sendTransaction({ to: adapter.address, value: 1n }), /UnexpectedEther/);
    // a minimum the swap cannot meet reverts and nothing moves
    await assert.rejects(burner.write.burn([usdg, parseUnits("5", 6), 10n ** 30n, path(wethUsdg.key, ORBIX_NATIVE)], { account: operator.account }));
    assert.equal(await bal(usdg, burner.address), parseUnits("5", 6));
    await noLeftovers(adapter.address);
  });
});
