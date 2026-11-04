// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeSplitter
/// @notice The hub's fee recipient. Every protocol fee lands here and is divided between two places:
/// a share (`burnBps`) goes to the FeeBurner, which turns it into the project token and burns it, and
/// the rest goes to EpochRewards, which pays it to strategy authors whose strategies people really use.
///
/// Anyone can call `split(token)`: it only moves money between the two fixed destinations, so there is
/// nothing to protect. The owner can change the share, never the destinations.
contract FeeSplitter is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BPS = 10_000;

    address public immutable burner;
    address public immutable rewards;
    /// @notice Share of each fee that is burned, in basis points (3000 = 30%).
    uint16 public burnBps;

    event Split(address indexed token, uint256 toBurner, uint256 toRewards);
    event BurnBpsSet(uint16 burnBps);

    error BadShare();
    error BadAddress();

    constructor(address owner_, address burner_, address rewards_, uint16 burnBps_) Ownable(owner_) {
        if (burner_ == address(0) || rewards_ == address(0)) revert BadAddress();
        if (burnBps_ > MAX_BPS) revert BadShare();
        burner = burner_;
        rewards = rewards_;
        burnBps = burnBps_;
    }

    function setBurnBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert BadShare();
        burnBps = bps;
        emit BurnBpsSet(bps);
    }

    /// @notice Divide everything of `token` held here.
    function split(address token) public returns (uint256 toBurner, uint256 toRewards) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return (0, 0);
        toBurner = (balance * burnBps) / MAX_BPS;
        toRewards = balance - toBurner;
        if (toBurner > 0) IERC20(token).safeTransfer(burner, toBurner);
        if (toRewards > 0) IERC20(token).safeTransfer(rewards, toRewards);
        emit Split(token, toBurner, toRewards);
    }

    function splitMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) split(tokens[i]);
    }
}
