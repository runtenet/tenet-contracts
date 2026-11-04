// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice The part of a Pons bonding curve the burner needs. A token launched on Pons trades on its OWN curve contract (paid in native
/// ETH) until it has raised enough, and only then graduates into a Uniswap v4 pool.
interface IPonsCurve {
    function token() external view returns (address);
    function graduated() external view returns (bool);
    function isNativeQuote() external view returns (bool);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
}

/// @title BurnAdapter
/// @notice The venue of the fee burner. It buys the project token by TWO routes, chosen in `data`:
///   mode 0 (POOLS): exactly what the burner did before: along allowlisted Uniswap v4 pools (the `pools` adapter does the swap).
///   mode 1 (CURVE): on the token's Pons bonding curve, with native ETH. The input may be WETH (unwrapped here) or another fee token
///                   (USDG, a stock): it is first swapped to WETH along the allowlisted pools (`pre` route), then the ETH buys on the curve.
/// So the burn works from the first minute of a token launched on Pons, before it has any Uniswap pool, and switches to the pools by
/// itself once the token graduates (the keeper picks the mode; this contract only refuses a curve that is no longer a curve).
///
/// A curve is used only after the owner allowlisted it (one transaction in /admin, like a pool), and only if it really sells the token the
/// burner asked for: `curve.token() == tokenOut`, not graduated, quoted in native ETH. The `minAmountOut` is checked on what the
/// recipient actually received, for the whole route.
/// Nothing is kept here: the adapter ends every swap with no tokens and no ETH (leftovers go to the recipient).
///
/// `data` = abi.encode(uint8 mode, bytes payload)
///   mode 0: payload = the route of the pools adapter (abi.encode(Hop[]))
///   mode 1: payload = abi.encode(address curve, bytes pre), `pre` empty when the input already is WETH
contract BurnAdapter is ISwapAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant POOLS = 0;
    uint8 public constant CURVE = 1;

    /// @notice The Uniswap v4 adapter whose pools the burner already uses.
    ISwapAdapter public immutable pools;
    address public immutable weth;

    mapping(address curve => bool) public isCurveAllowed;

    event CurveSet(address indexed curve, address indexed token, bool allowed);

    error BadMode();
    error CurveNotAllowed(address curve);
    error NotThisCurve();
    error CurveClosed();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error UnexpectedEther();
    error BadInput();

    constructor(address owner_, address pools_, address weth_) Ownable(owner_) {
        if (pools_ == address(0) || weth_ == address(0)) revert BadInput();
        pools = ISwapAdapter(pools_);
        weth = weth_;
    }

    /// @dev ETH arrives from WETH (an unwrap) and from an allowed curve (what it does not spend when a buy reaches its limit).
    receive() external payable {
        if (msg.sender != weth && !isCurveAllowed[msg.sender]) revert UnexpectedEther();
    }

    /// @notice Allow (or stop allowing) a Pons curve as a place to buy the project token.
    function setCurve(address curve, bool allowed) external onlyOwner {
        if (curve == address(0) || curve.code.length == 0) revert BadInput();
        isCurveAllowed[curve] = allowed;
        emit CurveSet(curve, IPonsCurve(curve).token(), allowed);
    }

    /// @notice The pools adapter's allowlist, so the admin page reads one place for both routes.
    function isPoolAllowed(bytes32 poolId) external view returns (bool) {
        (bool ok, bytes memory ret) = address(pools).staticcall(abi.encodeWithSignature("isPoolAllowed(bytes32)", poolId));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external nonReentrant returns (uint256 amountOut) {
        (uint8 mode, bytes memory payload) = abi.decode(data, (uint8, bytes));
        if (tokenIn == tokenOut || amountIn == 0 || recipient == address(0)) revert BadInput();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        if (mode == POOLS) {
            IERC20(tokenIn).forceApprove(address(pools), amountIn);
            amountOut = pools.swap(tokenIn, tokenOut, amountIn, minAmountOut, recipient, payload);
            IERC20(tokenIn).forceApprove(address(pools), 0);
        } else if (mode == CURVE) {
            amountOut = _buyOnCurve(tokenIn, tokenOut, amountIn, minAmountOut, recipient, payload);
        } else {
            revert BadMode();
        }
    }

    function _buyOnCurve(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, bytes memory payload)
        private
        returns (uint256 got)
    {
        (address curve, bytes memory pre) = abi.decode(payload, (address, bytes));
        if (!isCurveAllowed[curve]) revert CurveNotAllowed(curve);
        IPonsCurve c = IPonsCurve(curve);
        if (c.token() != tokenOut || !c.isNativeQuote()) revert NotThisCurve();
        if (c.graduated()) revert CurveClosed();

        // 1. get WETH: it is the input, or it is bought with the input along the allowlisted pools
        uint256 eth = amountIn;
        if (tokenIn != weth) {
            uint256 before = IERC20(weth).balanceOf(address(this));
            IERC20(tokenIn).forceApprove(address(pools), amountIn);
            pools.swap(tokenIn, weth, amountIn, 0, address(this), pre);
            IERC20(tokenIn).forceApprove(address(pools), 0);
            eth = IERC20(weth).balanceOf(address(this)) - before;
        }
        if (eth == 0) revert BadInput();

        // 2. WETH -> ETH -> the curve sends the tokens straight to the recipient
        IWETH9(weth).withdraw(eth);
        uint256 tokensBefore = IERC20(tokenOut).balanceOf(recipient);
        c.buy{value: eth}(eth, minAmountOut, recipient);
        got = IERC20(tokenOut).balanceOf(recipient) - tokensBefore;
        if (got == 0 || got < minAmountOut) revert InsufficientOutput(got, minAmountOut);

        // 3. a buy that reaches the curve's limit does not spend all of it: whatever is left goes back as WETH
        uint256 left = address(this).balance;
        if (left > 0) {
            IWETH9(weth).deposit{value: left}();
            IERC20(weth).safeTransfer(recipient, left);
        }
    }
}
