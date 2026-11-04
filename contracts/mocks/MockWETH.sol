// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestToken} from "./TestToken.sol";

/// @notice Test-only wrapped ether with the WETH9 interface (deposit / withdraw / receive) plus the
/// faucet and minter hooks of TestToken, so the test DEX adapter can trade it like any other token.
contract MockWETH is TestToken {
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error EthTransferFailed();

    constructor(address owner_) TestToken("Test Wrapped Ether", "tWETH", 18, 1e18, owner_) {}

    receive() external payable {
        _deposit();
    }

    function deposit() external payable {
        _deposit();
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    function _deposit() private {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }
}
