// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Chainlink-compatible feed whose answer is pushed by its owner (the backend's
/// price relayer mirrors mainnet Chainlink prices into these on testnet).
contract TestPriceFeed is Ownable {
    uint8 public immutable decimals;
    string public description;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(uint8 decimals_, string memory description_, int256 initialAnswer, address owner_) Ownable(owner_) {
        decimals = decimals_;
        description = description_;
        _set(initialAnswer);
    }

    function setAnswer(int256 answer) external onlyOwner {
        _set(answer);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _set(int256 answer) private {
        _roundId += 1;
        _answer = answer;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer, _roundId, block.timestamp);
    }
}
