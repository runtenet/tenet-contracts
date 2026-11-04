// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title KeeperRegistry
/// @notice Lets anyone run a keeper. A keeper locks the project token as a bond; while the bond is at least
/// `minStake`, the hub accepts it as an operator and it earns the keeper fee of every execution it triggers.
///
/// What a keeper can do is already tiny: it can only trigger strategies exactly as their owners signed them,
/// at prices the oracle bounds, for a fee the hub caps. The bond is therefore not a hostage for stolen funds
/// (a keeper cannot touch funds); it is the price of admission that keeps the network from filling with
/// throwaway wallets, and it ties the token to the work.
///
/// The owner cannot take a bond. The owner can only ban an address (it stops being a keeper), and the bond
/// of a banned keeper can still be withdrawn after the delay.
contract KeeperRegistry is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant UNSTAKE_DELAY = 7 days;

    /// @notice The bond token (the project token). Zero until launch. The owner can change it at any time (see `setStakeToken`).
    IERC20 public stakeToken;
    uint256 public minStake;

    mapping(address => uint256) public stakeOf;
    /// @notice The token a keeper's bond is held in. A keeper bonded in an earlier token stays inactive until it withdraws and bonds again.
    mapping(address => address) public stakedToken;
    /// @notice When the keeper asked to leave. Zero while it is staying.
    mapping(address => uint64) public leavingSince;
    mapping(address => bool) public banned;
    /// @notice Bonded per token, in that token's own units.
    mapping(address => uint256) public totalStakedOf;

    event StakeTokenSet(address indexed token);
    event MinStakeSet(uint256 minStake);
    event Staked(address indexed keeper, uint256 amount, uint256 total);
    event LeaveRequested(address indexed keeper, uint64 withdrawableAt);
    event LeaveCancelled(address indexed keeper);
    event Withdrawn(address indexed keeper, uint256 amount);
    event BanSet(address indexed keeper, bool banned);

    error SameToken();
    error BondedInOldToken();
    error TokenNotSet();
    error NotAToken();
    error NothingStaked();
    error NotLeaving();
    error TooEarly();
    error ZeroAmount();

    constructor(address owner_, uint256 minStake_) Ownable(owner_) {
        minStake = minStake_;
    }

    // ---------------------------------------------------------------- setup

    /// @notice Name the bond token, or change it to another one, as often as the owner wants. Bonds already placed stay withdrawable
    /// in the token they were made in; those keepers become inactive until they withdraw and bond again in the new token.
    function setStakeToken(address token) external onlyOwner {
        if (token == address(0) || token.code.length == 0) revert NotAToken();
        if (token == address(stakeToken)) revert SameToken();
        stakeToken = IERC20(token);
        emit StakeTokenSet(token);
    }

    function setMinStake(uint256 amount) external onlyOwner {
        minStake = amount;
        emit MinStakeSet(amount);
    }

    /// @notice Stop an address from acting as a keeper. Its bond stays its own.
    function setBanned(address keeper, bool value) external onlyOwner {
        banned[keeper] = value;
        emit BanSet(keeper, value);
    }

    // ---------------------------------------------------------------- keepers

    /// @notice Bonded in the CURRENT bond token.
    function totalStaked() external view returns (uint256) {
        return totalStakedOf[address(stakeToken)];
    }

    /// @notice True while `keeper` may trigger executions: bonded at least `minStake`, not leaving, not banned.
    function isActive(address keeper) external view returns (bool) {
        if (address(stakeToken) == address(0) || banned[keeper] || leavingSince[keeper] != 0) return false;
        if (stakedToken[keeper] != address(stakeToken)) return false; // bonded in an earlier token
        return stakeOf[keeper] >= minStake && stakeOf[keeper] > 0;
    }

    function stake(uint256 amount) external nonReentrant {
        if (address(stakeToken) == address(0)) revert TokenNotSet();
        if (amount == 0) revert ZeroAmount();
        if (stakeOf[msg.sender] > 0 && stakedToken[msg.sender] != address(stakeToken)) revert BondedInOldToken(); // withdraw it first
        uint256 before = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakeToken.balanceOf(address(this)) - before; // a taxed token delivers less
        stakeOf[msg.sender] += received;
        stakedToken[msg.sender] = address(stakeToken);
        totalStakedOf[address(stakeToken)] += received;
        if (leavingSince[msg.sender] != 0) {
            leavingSince[msg.sender] = 0; // adding to the bond means staying
            emit LeaveCancelled(msg.sender);
        }
        emit Staked(msg.sender, received, stakeOf[msg.sender]);
    }

    /// @notice Leave the network. The keeper stops being a keeper at once; the bond is claimable after the delay.
    function requestLeave() external {
        if (stakeOf[msg.sender] == 0) revert NothingStaked();
        leavingSince[msg.sender] = uint64(block.timestamp);
        emit LeaveRequested(msg.sender, uint64(block.timestamp) + UNSTAKE_DELAY);
    }

    function cancelLeave() external {
        if (leavingSince[msg.sender] == 0) revert NotLeaving();
        leavingSince[msg.sender] = 0;
        emit LeaveCancelled(msg.sender);
    }

    function withdraw() external nonReentrant {
        uint64 since = leavingSince[msg.sender];
        if (since == 0) revert NotLeaving();
        if (block.timestamp < uint256(since) + UNSTAKE_DELAY) revert TooEarly();
        uint256 amount = stakeOf[msg.sender];
        if (amount == 0) revert NothingStaked();
        address token = stakedToken[msg.sender];
        stakeOf[msg.sender] = 0;
        leavingSince[msg.sender] = 0;
        totalStakedOf[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
