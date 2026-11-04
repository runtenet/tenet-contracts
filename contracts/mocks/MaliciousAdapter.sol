// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @notice Test-only venue that takes the input and returns a fraction of what it claims.
contract MaliciousAdapter is ISwapAdapter {
    function swap(address tokenIn, address, uint256 amountIn, uint256 minAmountOut, address, bytes calldata)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        return minAmountOut; // lies: sends nothing
    }
}
