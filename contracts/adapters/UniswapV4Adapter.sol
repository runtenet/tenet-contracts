// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @title UniswapV4Adapter
/// @notice Swaps ERC-20 -> ERC-20 straight through the Uniswap v4 PoolManager (no router, no Permit2),
/// along a path of one to MAX_HOPS pools, e.g. WETH -> USDG -> AAPL, all inside ONE unlock: the
/// intermediate token never leaves the PoolManager (flash accounting nets it out).
///
/// Only pools the owner has allowlisted can be used, so a keeper cannot route a vault's funds through
/// an arbitrary (possibly malicious) hook. Even on allowlisted pools the vault enforces the
/// oracle-based minimum output for the whole path, so a bad fill reverts the whole execution.
///
/// `data` = abi.encode(Hop[] hops). The keeper picks the best allowed path off chain.
contract UniswapV4Adapter is ISwapAdapter, IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 public constant MAX_HOPS = 3;

    IPoolManager public immutable poolManager;

    /// @notice keccak256(abi.encode(PoolKey)) == the v4 PoolId.
    mapping(bytes32 => bool) public isPoolAllowed;

    struct Hop {
        PoolKey key;
        bytes hookData;
    }

    struct SwapData {
        Hop[] hops;
        bool[] zeroForOne;
        uint256 amountIn;
        address recipient;
    }

    event PoolSet(bytes32 indexed poolId, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bool allowed);

    error PoolNotAllowed(bytes32 poolId);
    error BadPath();
    error PairMismatch();
    error NotPoolManager();
    error BadDelta();
    error OverSpent(uint256 owed, uint256 available);
    error InsufficientOutput(uint256 out, uint256 minOut);

    constructor(address poolManager_, address owner_) Ownable(owner_) {
        poolManager = IPoolManager(poolManager_);
    }

    function setPool(PoolKey calldata key, bool allowed) external onlyOwner {
        bytes32 id = keccak256(abi.encode(key));
        isPoolAllowed[id] = allowed;
        emit PoolSet(
            id,
            Currency.unwrap(key.currency0),
            Currency.unwrap(key.currency1),
            key.fee,
            key.tickSpacing,
            address(key.hooks),
            allowed
        );
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external nonReentrant returns (uint256 amountOut) {
        Hop[] memory hops = abi.decode(data, (Hop[]));
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS || tokenIn == tokenOut) revert BadPath();

        // validate the whole path before touching any funds: every pool allowed, every hop continues the last
        bool[] memory zeroForOne = new bool[](n);
        address current = tokenIn;
        for (uint256 i = 0; i < n; i++) {
            PoolKey memory key = hops[i].key;
            bytes32 id = keccak256(abi.encode(key));
            if (!isPoolAllowed[id]) revert PoolNotAllowed(id);

            address c0 = Currency.unwrap(key.currency0);
            address c1 = Currency.unwrap(key.currency1);
            if (current == c0) {
                zeroForOne[i] = true;
                current = c1;
            } else if (current == c1) {
                current = c0;
            } else {
                revert PairMismatch();
            }
        }
        if (current != tokenOut) revert PairMismatch();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        bytes memory result = poolManager.unlock(abi.encode(SwapData({hops: hops, zeroForOne: zeroForOne, amountIn: amountIn, recipient: recipient})));
        amountOut = abi.decode(result, (uint256));
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory d = abi.decode(raw, (SwapData));

        uint256 amount = d.amountIn; // what the next hop spends
        uint256 firstOwed; // what we owe the PoolManager of the very first input
        Currency firstIn;

        for (uint256 i = 0; i < d.hops.length; i++) {
            PoolKey memory key = d.hops[i].key;
            bool z = d.zeroForOne[i];

            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: z,
                    amountSpecified: -int256(amount), // exact input
                    sqrtPriceLimitX96: z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                d.hops[i].hookData
            );

            int128 inDelta = z ? delta.amount0() : delta.amount1();
            int128 outDelta = z ? delta.amount1() : delta.amount0();
            // the swapper owes the input (<= 0) and is owed the output (>= 0)
            if (inDelta > 0 || outDelta < 0) revert BadDelta();

            uint256 owedIn = uint256(uint128(-inDelta));
            if (owedIn > amount) revert OverSpent(owedIn, amount);

            Currency cIn = z ? key.currency0 : key.currency1;
            if (i == 0) {
                firstOwed = owedIn;
                firstIn = cIn;
            } else if (owedIn < amount) {
                // a partial fill on a middle hop leaves part of the intermediate token credited to us: pay it out
                poolManager.take(cIn, d.recipient, amount - owedIn);
            }
            amount = uint256(uint128(outDelta));
        }

        // settle the first input, then take the final output
        if (firstOwed > 0) {
            poolManager.sync(firstIn);
            IERC20(Currency.unwrap(firstIn)).safeTransfer(address(poolManager), firstOwed);
            poolManager.settle();
        }
        uint256 last = d.hops.length - 1;
        Currency cOut = d.zeroForOne[last] ? d.hops[last].key.currency1 : d.hops[last].key.currency0;
        if (amount > 0) poolManager.take(cOut, d.recipient, amount);

        // partial fill of the first hop: hand back what the pool did not take
        if (d.amountIn > firstOwed) IERC20(Currency.unwrap(firstIn)).safeTransfer(d.recipient, d.amountIn - firstOwed);

        return abi.encode(amount);
    }
}
