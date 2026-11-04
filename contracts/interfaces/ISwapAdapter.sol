// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A venue the vault can trade through. The vault approves exactly `amountIn`,
/// the adapter pulls it and sends at least `minAmountOut` of `tokenOut` to `recipient`.
/// The vault never trusts the return value: it measures its own balances.
interface ISwapAdapter {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external returns (uint256 amountOut);
}
