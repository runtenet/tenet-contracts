// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title FeeBurner
/// @notice Receives the protocol fee of every trade (it is the hub's fee recipient) and turns ALL of it into
/// the project token, which is then sent to the dead address, where nobody can ever move it again.
///
/// The fee arrives in whatever the trade was paid in (USDG, ETH as WETH, or a stock token), so the burner
/// swaps it through the same allowlisted Uniswap v4 venue the vaults use, along a path that ends in the token.
///
/// Before the token exists the fees simply pile up here: nothing is lost, and on launch day everything that
/// has accumulated can be burned at once. The only way fees can leave this contract is the burn. The single
/// exception is a safety valve: if no token has been set by `noTokenDeadline`, the owner may recover the
/// funds, so a token that never launches cannot lock them forever.
///
/// Who may burn: only addresses the owner allowlisted (the burn keeper). The last leg of a swap ends in the
/// project token, which has no oracle price, so the keeper supplies the minimum output from a live quote;
/// that is why the caller is trusted rather than anyone.
contract FeeBurner is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ISwapAdapter public immutable adapter;
    /// @notice After this time, and only while no token is set, the owner may recover the accumulated fees.
    uint64 public immutable noTokenDeadline;

    /// @notice The project token. Zero until launch. The owner can change it at any time (see `setBurnToken`).
    IERC20 public burnToken;
    mapping(address => bool) public isBurner;
    /// @notice Every token that has ever been the project token here: whatever is left of one can still be burned.
    mapping(address => bool) public wasBurnToken;
    /// @notice Burned so far, per token, in that token's own units.
    mapping(address => uint256) public burnedOf;

    event BurnTokenSet(address indexed token);
    event BurnerSet(address indexed burner, bool allowed);
    event Burned(address indexed feeToken, uint256 feeAmount, uint256 tokensBurned);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error NotBurner();
    error TokenNotSet();
    error SameToken();
    error NotAToken();
    error NotAProjectToken();
    error UseBurnHeld();
    error NothingToBurn();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error RecoveryNotAllowed();

    constructor(address owner_, address adapter_, uint64 noTokenDelay) Ownable(owner_) {
        adapter = ISwapAdapter(adapter_);
        noTokenDeadline = uint64(block.timestamp) + noTokenDelay;
    }

    // ---------------------------------------------------------------- setup

    /// @notice Name the project token, or change it to another one, as often as the owner wants. The pool(s) the new token trades
    /// in must be allowlisted on the adapter. Whatever is left of an earlier token here can still be burned with `burnHeldToken`.
    function setBurnToken(address token) external onlyOwner {
        if (token == address(0) || token.code.length == 0) revert NotAToken();
        if (token == address(burnToken)) revert SameToken();
        burnToken = IERC20(token);
        wasBurnToken[token] = true;
        emit BurnTokenSet(token);
    }

    /// @notice Burned so far of the CURRENT project token.
    function totalBurned() external view returns (uint256) {
        return burnedOf[address(burnToken)];
    }

    function setBurner(address burner, bool allowed) external onlyOwner {
        isBurner[burner] = allowed;
        emit BurnerSet(burner, allowed);
    }

    // ---------------------------------------------------------------- burning

    /// @notice Swap `amount` of an accumulated fee token into the project token and burn what comes out.
    /// @param data adapter route (for the Uniswap adapter: abi.encode(Hop[]) ending in the project token)
    function burn(address feeToken, uint256 amount, uint256 minOut, bytes calldata data) external nonReentrant returns (uint256 burned) {
        if (!isBurner[msg.sender]) revert NotBurner();
        IERC20 token = burnToken;
        if (address(token) == address(0)) revert TokenNotSet();
        if (feeToken == address(token)) revert UseBurnHeld();
        if (amount == 0) revert NothingToBurn();

        uint256 before = token.balanceOf(address(this));
        IERC20(feeToken).forceApprove(address(adapter), amount);
        adapter.swap(feeToken, address(token), amount, minOut, address(this), data);
        IERC20(feeToken).forceApprove(address(adapter), 0);

        // measure what actually arrived (a token with a transfer tax delivers less than the swap says)
        burned = token.balanceOf(address(this)) - before;
        if (burned == 0 || burned < minOut) revert InsufficientOutput(burned, minOut);

        token.safeTransfer(DEAD, burned);
        burnedOf[address(token)] += burned;
        emit Burned(feeToken, amount, burned);
    }

    /// @notice Burn project tokens that were sent here directly. Anyone can call it; no swap, so nothing to sandwich.
    function burnHeld() external nonReentrant returns (uint256 burned) {
        if (address(burnToken) == address(0)) revert TokenNotSet();
        return _burnHeld(address(burnToken));
    }

    /// @notice The same for a token that used to be the project token (for example what was left when the owner switched).
    function burnHeldToken(address token) external nonReentrant returns (uint256 burned) {
        if (!wasBurnToken[token]) revert NotAProjectToken();
        return _burnHeld(token);
    }

    function _burnHeld(address token) private returns (uint256 burned) {
        burned = IERC20(token).balanceOf(address(this));
        if (burned == 0) revert NothingToBurn();
        IERC20(token).safeTransfer(DEAD, burned);
        burnedOf[token] += burned;
        emit Burned(token, 0, burned);
    }

    // ---------------------------------------------------------------- safety valve

    /// @notice Only if no token was set within `noTokenDeadline`: give the accumulated fees back to the owner.
    function recoverIfNoToken(address token, address to) external onlyOwner nonReentrant {
        if (address(burnToken) != address(0) || block.timestamp < noTokenDeadline) revert RecoveryNotAllowed();
        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        emit Recovered(token, to, amount);
    }
}
