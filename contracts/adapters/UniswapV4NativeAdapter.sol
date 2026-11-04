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

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title UniswapV4NativeAdapter
/// @notice The same job as UniswapV4Adapter (ERC-20 -> ERC-20 along one to MAX_HOPS allowlisted Uniswap v4 pools,
/// inside one unlock), plus pools whose one side is the chain's NATIVE ETH (currency address(0)), such as the pools a
/// Pons token graduates into. Callers and the project token only ever see ERC-20s: where the path meets a native pool
/// the adapter turns WETH into ETH (or back) on the spot, so a route like USDG -> WETH -> [native ETH / TOKEN] works.
///
/// Rules of the conversion (checked before any funds move):
///  - a hop whose pool holds native ETH may follow a WETH leg (or start from WETH): the adapter unwraps first;
///  - a hop whose pool holds WETH may follow a native leg: the adapter wraps first;
///  - the path must END in an ERC-20 equal to `tokenOut` (a native output is refused).
/// Nothing is kept: the adapter ends every swap with no tokens and no ETH.
///
/// `data` = abi.encode(Hop[] hops), exactly as for UniswapV4Adapter.
contract UniswapV4NativeAdapter is ISwapAdapter, IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 public constant MAX_HOPS = 3;

    IPoolManager public immutable poolManager;
    address public immutable weth;

    /// @notice keccak256(abi.encode(PoolKey)) == the v4 PoolId.
    mapping(bytes32 => bool) public isPoolAllowed;

    struct Hop {
        PoolKey key;
        bytes hookData;
    }

    uint8 private constant NONE = 0;
    uint8 private constant UNWRAP = 1; // the credit from the previous leg is WETH, this pool wants native ETH
    uint8 private constant WRAP = 2; // the credit from the previous leg is native ETH, this pool wants WETH

    struct SwapData {
        Hop[] hops;
        bool[] zeroForOne;
        uint8[] conv;
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
    error UnexpectedEther();

    constructor(address poolManager_, address owner_, address weth_) Ownable(owner_) {
        poolManager = IPoolManager(poolManager_);
        weth = weth_;
    }

    /// @dev ETH arrives only from the PoolManager (a `take` of native) and from WETH (an unwrap).
    receive() external payable {
        if (msg.sender != address(poolManager) && msg.sender != weth) revert UnexpectedEther();
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
        if (n == 0 || n > MAX_HOPS || tokenIn == tokenOut || tokenIn == address(0) || tokenOut == address(0)) revert BadPath();

        // validate the whole path before touching any funds: every pool allowed, every hop continues the last
        bool[] memory zeroForOne = new bool[](n);
        uint8[] memory conv = new uint8[](n);
        address current = tokenIn; // what the previous leg left us with: an ERC-20, or address(0) for native ETH
        for (uint256 i = 0; i < n; i++) {
            PoolKey memory key = hops[i].key;
            bytes32 id = keccak256(abi.encode(key));
            if (!isPoolAllowed[id]) revert PoolNotAllowed(id);

            address c0 = Currency.unwrap(key.currency0);
            address c1 = Currency.unwrap(key.currency1);
            if (current != c0 && current != c1) {
                if (current == weth && (c0 == address(0) || c1 == address(0))) {
                    conv[i] = UNWRAP;
                    current = address(0);
                } else if (current == address(0) && (c0 == weth || c1 == weth)) {
                    conv[i] = WRAP;
                    current = weth;
                } else {
                    revert PairMismatch();
                }
            }
            if (current == c0) {
                zeroForOne[i] = true;
                current = c1;
            } else {
                current = c0;
            }
        }
        if (current != tokenOut) revert PairMismatch();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        bytes memory result = poolManager.unlock(
            abi.encode(SwapData({hops: hops, zeroForOne: zeroForOne, conv: conv, amountIn: amountIn, recipient: recipient}))
        );
        amountOut = abi.decode(result, (uint256));
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory d = abi.decode(raw, (SwapData));

        // a path that starts at WETH and meets a native pool first: hold ETH for the first input
        if (d.conv[0] == UNWRAP) IWETH(weth).withdraw(d.amountIn);

        uint256 amount = d.amountIn; // what the next hop spends
        uint256 firstOwed; // what we owe the PoolManager of the very first input
        Currency firstIn;
        Currency prevOut; // the currency the previous hop credited to us

        for (uint256 i = 0; i < d.hops.length; i++) {
            PoolKey memory key = d.hops[i].key;
            bool z = d.zeroForOne[i];

            if (i > 0 && d.conv[i] != NONE) {
                // the previous leg's output is credited in `prevOut`: take it, convert, and settle the other form back
                poolManager.take(prevOut, address(this), amount);
                if (d.conv[i] == UNWRAP) {
                    IWETH(weth).withdraw(amount);
                    poolManager.settle{value: amount}();
                } else {
                    IWETH(weth).deposit{value: amount}();
                    poolManager.sync(Currency.wrap(weth));
                    IERC20(weth).safeTransfer(address(poolManager), amount);
                    poolManager.settle();
                }
            }

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
                // a partial fill on a middle hop leaves part of the intermediate currency credited to us: pay it out
                _payOut(cIn, d.recipient, amount - owedIn);
            }
            prevOut = z ? key.currency1 : key.currency0;
            amount = uint256(uint128(outDelta));
        }

        // settle the first input, then take the final output (an ERC-20: the path validation guarantees it)
        if (firstOwed > 0) {
            if (Currency.unwrap(firstIn) == address(0)) {
                poolManager.settle{value: firstOwed}();
            } else {
                poolManager.sync(firstIn);
                IERC20(Currency.unwrap(firstIn)).safeTransfer(address(poolManager), firstOwed);
                poolManager.settle();
            }
        }
        if (amount > 0) poolManager.take(prevOut, d.recipient, amount);

        // partial fill of the first hop: hand back what the pool did not take, as the ERC-20 the caller gave us
        if (d.amountIn > firstOwed) {
            uint256 rest = d.amountIn - firstOwed;
            if (Currency.unwrap(firstIn) == address(0)) {
                IWETH(weth).deposit{value: rest}();
                IERC20(weth).safeTransfer(d.recipient, rest);
            } else {
                IERC20(Currency.unwrap(firstIn)).safeTransfer(d.recipient, rest);
            }
        }

        return abi.encode(amount);
    }

    /// @dev Pay `amount` of a credited currency to `to`; native ETH is wrapped first so the recipient only ever gets ERC-20.
    function _payOut(Currency c, address to, uint256 amount) private {
        if (Currency.unwrap(c) == address(0)) {
            poolManager.take(c, address(this), amount);
            IWETH(weth).deposit{value: amount}();
            IERC20(weth).safeTransfer(to, amount);
        } else {
            poolManager.take(c, to, amount);
        }
    }
}
