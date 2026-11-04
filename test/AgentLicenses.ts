import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const { viem, networkHelpers } = await network.create();

const DEAD = "0x000000000000000000000000000000000000dEaD";
const PRICE = parseUnits("100", 18);

/** The licenses are paid in the project token, which is whatever the fee burner is set to. */
async function deploy() {
  const [admin, seller, buyer, other, treasury] = await viem.getWalletClients();
  const hub = await viem.deployContract("TenetHub", [admin.account.address, treasury.account.address]);
  const adapter = await viem.deployContract("TestToken", ["adapter stand-in", "X", 18, 0n, admin.account.address]); // only an address with code
  const burner = await viem.deployContract("FeeBurner", [admin.account.address, adapter.address, 365n * 86400n]);
  const token = await viem.deployContract("TestToken", ["Project", "PRJ", 18, 0n, admin.account.address]);
  await token.write.setMinter([admin.account.address, true]);
  for (const w of [buyer, other]) await token.write.mint([w.account.address, parseUnits("1000", 18)]);

  await hub.write.createVault({ account: seller.account });
  const [vaultAddr] = await hub.read.vaultsOf([seller.account.address]);
  const licenses = await viem.deployContract("AgentLicenses", [admin.account.address, hub.address, burner.address, 500]);
  for (const w of [buyer, other]) await token.write.approve([licenses.address, parseUnits("1000", 18)], { account: w.account });
  return { hub, token, burner, licenses, vault: vaultAddr, admin, seller, buyer, other, treasury };
}
type C = Awaited<ReturnType<typeof deploy>>;
const launch = (c: C) => c.burner.write.setBurnToken([c.token.address]); // what /admin does on launch day

describe("agent licenses", () => {
  it("nothing can be bought before the project token exists, then the licenses use it by themselves", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.seller.account });
    assert.equal(await c.licenses.read.payToken(), "0x0000000000000000000000000000000000000000");
    await viem.assertions.revertWithCustomError(c.licenses.write.buy([c.vault], { account: c.buyer.account }), c.licenses, "TokenNotSet");
    await launch(c);
    assert.equal((await c.licenses.read.payToken()).toLowerCase(), c.token.address.toLowerCase());
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    assert.equal(await c.licenses.read.hasLicense([c.buyer.account.address, c.vault]), true);
  });

  it("only the owner of a real vault puts its agent on sale", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await viem.assertions.revertWithCustomError(c.licenses.write.setSeries([c.vault, PRICE, 10, true], { account: c.buyer.account }), c.licenses, "NotVaultOwner");
    await viem.assertions.revertWithCustomError(c.licenses.write.setSeries([c.buyer.account.address, PRICE, 10, true], { account: c.buyer.account }), c.licenses, "NotAVault");
    await viem.assertions.revertWithCustomError(c.licenses.write.setSeries([c.vault, 0n, 10, true], { account: c.seller.account }), c.licenses, "BadSeries"); // free is not a sale
    await c.licenses.write.setSeries([c.vault, PRICE, 10, true], { account: c.seller.account });
    assert.equal((await c.licenses.read.series([c.vault]))[1], PRICE);
  });

  it("the seller gets the price minus 5%, and that 5% is burned", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await launch(c);
    await c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.seller.account });
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    assert.equal(await c.token.read.balanceOf([c.seller.account.address]), parseUnits("95", 18));
    assert.equal(await c.token.read.balanceOf([c.buyer.account.address]), parseUnits("900", 18));
    assert.equal(await c.token.read.balanceOf([c.burner.address]), parseUnits("5", 18)); // waiting at the burner
    await c.burner.write.burnHeld({ account: c.other.account }); // anyone can press it; the backend does it by itself
    assert.equal(await c.token.read.balanceOf([DEAD]), parseUnits("5", 18));
    assert.equal(await c.burner.read.totalBurned(), parseUnits("5", 18));
    assert.equal(await c.licenses.read.hasLicense([c.other.account.address, c.vault]), false);
    await viem.assertions.revertWithCustomError(c.licenses.write.buy([c.vault], { account: c.buyer.account }), c.licenses, "AlreadyLicensed"); // a second copy is pointless
  });

  it("nothing in the seller's vault is touched by a sale", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await launch(c);
    const vault = await viem.getContractAt("TenetVault", c.vault);
    await c.token.write.mint([c.vault, parseUnits("500", 18)]);
    await c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.seller.account });
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    assert.equal(await c.token.read.balanceOf([c.vault]), parseUnits("500", 18));
    assert.equal((await vault.read.owner()).toLowerCase(), c.seller.account.address.toLowerCase());
  });

  it("respects the cap and the open flag", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await launch(c);
    await viem.assertions.revertWithCustomError(c.licenses.write.buy([c.vault], { account: c.buyer.account }), c.licenses, "NotForSale"); // nothing listed
    await c.licenses.write.setSeries([c.vault, PRICE, 1, true], { account: c.seller.account });
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    await viem.assertions.revertWithCustomError(c.licenses.write.buy([c.vault], { account: c.other.account }), c.licenses, "SoldOut");
    await viem.assertions.revertWithCustomError(c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.buyer.account }), c.licenses, "NotVaultOwner");
    await c.licenses.write.setSeries([c.vault, PRICE, 2, true], { account: c.seller.account }); // raise the cap
    await c.licenses.write.setSeries([c.vault, PRICE, 2, false], { account: c.seller.account }); // close the sale
    await viem.assertions.revertWithCustomError(c.licenses.write.buy([c.vault], { account: c.other.account }), c.licenses, "NotForSale");
  });

  it("a license can be passed on or resold: the new holder has it, the old one does not", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await launch(c);
    await c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.seller.account });
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    const id = await c.licenses.read.idOf([c.vault]);
    await c.licenses.write.safeTransferFrom([c.buyer.account.address, c.other.account.address, id, 1n, "0x"], { account: c.buyer.account });
    assert.equal(await c.licenses.read.hasLicense([c.other.account.address, c.vault]), true);
    assert.equal(await c.licenses.read.hasLicense([c.buyer.account.address, c.vault]), false);
  });

  it("the protocol fee is capped and only its owner changes it", async () => {
    const c = await networkHelpers.loadFixture(deploy);
    await launch(c);
    await viem.assertions.revertWithCustomError(c.licenses.write.setFee([1001], { account: c.admin.account }), c.licenses, "FeeTooHigh");
    await viem.assertions.revertWithCustomError(c.licenses.write.setFee([100], { account: c.seller.account }), c.licenses, "OwnableUnauthorizedAccount");
    await c.licenses.write.setFee([0], { account: c.admin.account });
    await c.licenses.write.setSeries([c.vault, PRICE, 0, true], { account: c.seller.account });
    await c.licenses.write.buy([c.vault], { account: c.buyer.account });
    assert.equal(await c.token.read.balanceOf([c.seller.account.address]), PRICE); // no fee: the seller gets all of it
    assert.equal(await c.token.read.balanceOf([c.burner.address]), 0n);
  });
});
