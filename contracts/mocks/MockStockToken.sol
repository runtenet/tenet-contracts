// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestToken} from "./TestToken.sol";

/// @notice Test-only stock token exposing the issuer flags Robinhood stock tokens have.
contract MockStockToken is TestToken {
    bool public oraclePaused;
    bool public paused;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;

    constructor(string memory name_, string memory symbol_, address owner_) TestToken(name_, symbol_, 18, 5e18, owner_) {}

    function setFlags(bool oraclePaused_, bool paused_) external {
        oraclePaused = oraclePaused_;
        paused = paused_;
    }

    function setMultiplier(uint256 current, uint256 next, uint256 effective) external {
        uiMultiplier = current;
        newUIMultiplier = next;
        effectiveAt = effective;
    }
}
