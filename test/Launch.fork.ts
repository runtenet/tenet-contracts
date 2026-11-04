/**
 * Launch rehearsal on a fork of Robinhood Chain mainnet, against the REAL deployed TENET contracts (nothing is spent, nothing is
 * written to mainnet). The owner, the robot and a seller are impersonated; a stand-in token plays the project token.
 *
 *   FORK=1 npx hardhat test test/Launch.fork.ts --network rhFork
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, getAddress, parseEther, parseUnits, type Address } from "viem";

const RUN = process.env.FORK === "1";
const dep = JSON.parse(readFileSync(new URL("../deployments/4663.json", import.meta.url), "utf8"));
const WETH: Address = dep.tokens.find((t: any) => t.symbol === "WETH").address;

describe("launch rehearsal on the real deployment (fork)", { skip: !RUN }, async () => {
  const { viem, networkHelpers } = await network.create({ network: "rhFork" } as never);
  const pc = await viem.getPublicClient();

  const as = async (who: Address) => {
    await networkHelpers.setBalance(who, parseEther("10"));
    await networkHelpers.impersonateAccount(who);
    return viem.getWalletClient(who);
  };
  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  it("connect the token, put an agent on sale, buy a license, pay the hour, withdraw", async () => {
    await networkHelpers.mine(1); // the fork block itself has no hardfork history: read from a block above it
    // the contracts that hold the token (burner, licenses, hourly payouts in ETH), deployed on the fork against the real hub, adapter and WETH
    const [deployerW] = await viem.getWalletClients();
    const burner = await viem.deployContract("FeeBurner", [deployerW.account.address, dep.adapters[0].address, 365n * 86400n]);
    const licenses = await viem.deployContract("AgentLicenses", [deployerW.account.address, dep.hub, burner.address, 500]);
    const payouts = await viem.deployContract("AuthorPayouts", [deployerW.account.address, WETH, dep.hub, dep.adapters[0].address, licenses.address, burner.address]);
    const hub = await viem.getContractAt("TenetHub", dep.hub);

    const owner = getAddress(await burner.read.owner()); // the deployer of the fork copy
    const payer = getAddress(dep.operator);
    await payouts.write.setPayer([payer]);
    assert.equal(await burner.read.burnToken(), "0x0000000000000000000000000000000000000000", "no token yet on the real burner");

    const ownerW = await as(owner);
    const payerW = await as(payer);

    // 1. the stand-in for the token launched on Pons, minted to a seller and a buyer
    const [, , sellerFallback, buyerW] = await viem.getWalletClients();
    const token = await viem.deployContract("TestToken", ["Launch", "TNT", 18, 0n, owner]);
    await token.write.setMinter([owner, true], { account: ownerW.account });
    // the real test seller: the owner of the real vault of the published agent
    const [sellerAddr] = [getAddress("0x65Be11f8cAC91360090fBB67f7cC58D735F49a81")];
    const [vault] = await hub.read.vaultsOf([sellerAddr]);
    assert.ok(vault, "the test wallet has a real vault");
    const sellerW = await as(sellerAddr);
    void sellerFallback;

    const supply = parseEther("1000000");
    await token.write.mint([sellerAddr, supply / 1000n * 2n], { account: ownerW.account }); // 0.2%: above the 0.05% gate
    await token.write.mint([buyerW.account.address, parseEther("5000")], { account: ownerW.account });
    await token.write.mint([owner, supply - supply / 1000n * 2n - parseEther("5000")], { account: ownerW.account });

    // 2. "Connect the token" in /admin = burner.setBurnToken. The owner can change it again as often as they like.
    await burner.write.setBurnToken([token.address], { account: ownerW.account });
    assert.equal(getAddress(await burner.read.burnToken()), getAddress(token.address));
    await viem.assertions.revertWithCustomError(burner.write.setBurnToken([token.address], { account: ownerW.account }), burner, "SameToken");
    const other = await viem.deployContract("TestToken", ["Other", "OTH", 18, 0n, owner]);
    await burner.write.setBurnToken([other.address], { account: ownerW.account });
    assert.equal(getAddress(await burner.read.burnToken()), getAddress(other.address));
    await burner.write.setBurnToken([token.address], { account: ownerW.account });
    assert.equal(getAddress(await burner.read.burnToken()), getAddress(token.address));

    // 3. the author puts the agent on sale
    await licenses.write.setSeries([vault!, parseEther("100"), 0, true], { account: sellerW.account });

    // 4. someone buys the license: 5% of the price goes to the burner, the rest to the seller
    await token.write.approve([licenses.address, parseEther("100")], { account: buyerW.account });
    const sellerBefore = await bal(token.address, sellerAddr);
    await licenses.write.buy([vault!], { account: buyerW.account });
    assert.equal(await licenses.read.hasLicense([buyerW.account.address, vault!]), true);
    assert.equal(await bal(token.address, burner.address), parseEther("5"), "5% waits at the burner");
    assert.equal((await bal(token.address, sellerAddr)) - sellerBefore, parseEther("95"));
    await burner.write.burnHeld(); // anyone can burn it
    assert.equal(await bal(token.address, burner.address), 0n);
    assert.equal(await burner.read.totalBurned(), parseEther("5"));

    // 5. ETH arrives in the authors' pool (sent straight in: it is wrapped by the contract)
    await deployerW.sendTransaction({ to: payouts.address, value: parseEther("2") });
    const poolBefore = await bal(WETH, payouts.address);
    assert.equal(poolBefore, parseEther("2"));

    // 6. the robot pays the hour: 10% of the pool, as plain ETH, to the seller, who holds the gate amount
    assert.equal(await payouts.read.holdsEnough([sellerAddr]), true);
    const got0 = await pc.getBalance({ address: sellerAddr });
    await networkHelpers.time.increase(3600);
    await payouts.write.payout([[vault!]], { account: payerW.account });
    assert.equal((await pc.getBalance({ address: sellerAddr })) - got0, (poolBefore * 1000n) / 10_000n);
    console.log(`    paid ${Number((await pc.getBalance({ address: sellerAddr })) - got0) / 1e18} ETH of a ${Number(poolBefore) / 1e18} ETH pool`);

    // 7. a second payout in the same hour is refused; a seller without the share is not paid
    await viem.assertions.revertWithCustomError(payouts.write.payout([[vault!]], { account: payerW.account }), payouts, "TooEarly");
    await token.write.transfer([owner, await bal(token.address, sellerAddr)], { account: sellerW.account });
    await networkHelpers.time.increase(3600);
    await viem.assertions.revertWithCustomError(payouts.write.payout([[vault!]], { account: payerW.account }), payouts, "NobodyToPay");

    // 8. the owner takes the rest of the pool out
    const left = await bal(WETH, payouts.address);
    const ownerWeth = await bal(WETH, deployerW.account.address);
    await payouts.write.withdraw([WETH, left, deployerW.account.address]);
    assert.equal((await bal(WETH, deployerW.account.address)) - ownerWeth, left);
    assert.equal(await bal(WETH, payouts.address), 0n);
  });
});
