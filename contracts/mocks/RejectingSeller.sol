// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IHubLike {
    function createVault() external returns (address vault);
}

interface ILicensesLike {
    function setSeries(address vault, uint128 price, uint32 maxSupply, bool open) external;
}

/// @notice Test-only: a seller that owns a vault, has put its agent on sale, and cannot receive plain ETH (no receive function).
contract RejectingSeller {
    function sell(address hub, address licenses, uint128 price) external returns (address vault) {
        vault = IHubLike(hub).createVault();
        ILicensesLike(licenses).setSeries(vault, price, 0, true);
    }

    /// @dev a vault is a clone owned by this contract, so the owner can still take the WETH it was paid in
    function take(address token, address to) external {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok);
        uint256 amount = abi.decode(data, (uint256));
        (ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok);
    }
}
