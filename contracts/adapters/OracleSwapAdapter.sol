// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

interface IHubPrices {
    function getPrice(address token) external view returns (uint256 price, bool ok);
}

interface IMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @notice Testnet venue: fills any swap between TestTokens at the hub's oracle price minus a spread,
/// by burning the input and minting the output. Infinite liquidity, deterministic prices.
/// Never deploy on mainnet.
contract OracleSwapAdapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    IHubPrices public immutable hub;
    uint16 public spreadBps = 10;

    error OracleUnavailable();
    error InsufficientOutput(uint256 out, uint256 minOut);

    constructor(address hub_, address owner_) Ownable(owner_) {
        hub = IHubPrices(hub_);
    }

    function setSpread(uint16 spreadBps_) external onlyOwner {
        require(spreadBps_ <= 500, "spread");
        spreadBps = spreadBps_;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (uint256 pIn, bool okIn) = hub.getPrice(tokenIn);
        (uint256 pOut, bool okOut) = hub.getPrice(tokenOut);
        if (!okIn || !okOut) revert OracleUnavailable();
        uint256 usd = Math.mulDiv(amountIn, pIn, 10 ** IERC20Metadata(tokenIn).decimals());
        uint256 out = Math.mulDiv(usd, 10 ** IERC20Metadata(tokenOut).decimals(), pOut);
        return (out * (10_000 - spreadBps)) / 10_000;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata
    ) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IMintBurn(tokenIn).burn(address(this), amountIn);
        IMintBurn(tokenOut).mint(recipient, amountOut);
    }
}
