// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

interface IPriceHub {
    function getPrice(address token) external view returns (uint256 price, bool ok);
}

/// @title EpochRewards
/// @notice Holds the rewards share of the protocol fee and pays it out, once a week, to the authors of
/// strategies that people actually use.
///
/// 1. Fees arrive in whatever the trade was paid in. A keeper converts them to the reward token (USDG)
///    through the allowlisted venue; the contract itself checks the result against the oracle prices,
///    so the keeper cannot give the money away in a bad swap.
/// 2. Each week the publisher posts a Merkle root of "who gets how much" for that epoch. The total must be
///    covered by the money held here. The root becomes claimable only after `claimDelay`, and until then
///    the owner can cancel it: a wrong list is caught before anyone can be paid from it.
/// 3. Each author claims their own amount with a proof. Whatever is not claimed within `claimWindow` can be
///    swept back into the pool, for later epochs.
///
/// The owner cannot take the money out and cannot change an epoch after it is claimable. The publisher can
/// only post lists, never move funds.
contract EpochRewards is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Epoch {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint64 claimableAt;
        bool cancelled;
        bool swept;
    }

    IERC20 public immutable rewardToken;
    uint8 public immutable rewardDecimals;
    IPriceHub public immutable hub;
    ISwapAdapter public immutable adapter;

    uint64 public claimDelay = 24 hours;
    uint64 public claimWindow = 8 weeks;
    /// @notice Largest shortfall against the oracle price accepted when converting a fee, in bps.
    uint16 public maxConvertSlippageBps = 300;

    address public publisher;
    mapping(address => bool) public isConverter;
    bool public paused;

    uint256 public nextEpoch = 1;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    /// @notice Reward token promised to published epochs and not yet claimed or swept.
    uint256 public committed;

    event Converted(address indexed feeToken, uint256 amountIn, uint256 amountOut);
    event Published(uint256 indexed epoch, bytes32 root, uint256 total, uint64 claimableAt);
    event Cancelled(uint256 indexed epoch);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event Swept(uint256 indexed epoch, uint256 amount);
    event PublisherSet(address indexed publisher);
    event ConverterSet(address indexed converter, bool allowed);
    event PausedSet(bool paused);
    event ParamsSet(uint64 claimDelay, uint64 claimWindow, uint16 maxConvertSlippageBps);

    error NotPublisher();
    error NotConverter();
    error PausedError();
    error NoPrice();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error NotEnoughFunds();
    error BadEpoch();
    error NotClaimable();
    error AlreadyClaimed();
    error BadProof();
    error TooEarly();
    error BadParam();
    error WrongToken();

    constructor(address owner_, address rewardToken_, address hub_, address adapter_) Ownable(owner_) {
        rewardToken = IERC20(rewardToken_);
        rewardDecimals = IERC20Metadata(rewardToken_).decimals();
        hub = IPriceHub(hub_);
        adapter = ISwapAdapter(adapter_);
    }

    // ---------------------------------------------------------------- setup

    function setPublisher(address who) external onlyOwner {
        publisher = who;
        emit PublisherSet(who);
    }

    function setConverter(address who, bool allowed) external onlyOwner {
        isConverter[who] = allowed;
        emit ConverterSet(who, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setParams(uint64 claimDelay_, uint64 claimWindow_, uint16 slippageBps) external onlyOwner {
        if (claimDelay_ > 7 days || claimWindow_ < 1 weeks || claimWindow_ > 52 weeks || slippageBps > 1000) revert BadParam();
        claimDelay = claimDelay_;
        claimWindow = claimWindow_;
        maxConvertSlippageBps = slippageBps;
        emit ParamsSet(claimDelay_, claimWindow_, slippageBps);
    }

    // ---------------------------------------------------------------- converting fees

    /// @notice Swap `amount` of a fee token into the reward token. The result must be within
    /// `maxConvertSlippageBps` of the oracle value, on top of the caller's own `minOut`.
    function convert(address feeToken, uint256 amount, uint256 minOut, bytes calldata data) external nonReentrant returns (uint256 got) {
        if (!isConverter[msg.sender]) revert NotConverter();
        if (feeToken == address(rewardToken)) revert WrongToken();

        (uint256 pIn, bool okIn) = hub.getPrice(feeToken);
        (uint256 pOut, bool okOut) = hub.getPrice(address(rewardToken));
        if (!okIn || !okOut) revert NoPrice();

        // oracle value of the input, expressed in reward-token units
        uint256 expected = (amount * pIn * 10 ** rewardDecimals) / (pOut * 10 ** IERC20Metadata(feeToken).decimals());
        uint256 floor = (expected * (10_000 - maxConvertSlippageBps)) / 10_000;
        if (minOut < floor) minOut = floor;

        uint256 before = rewardToken.balanceOf(address(this));
        IERC20(feeToken).forceApprove(address(adapter), amount);
        adapter.swap(feeToken, address(rewardToken), amount, minOut, address(this), data);
        IERC20(feeToken).forceApprove(address(adapter), 0);

        got = rewardToken.balanceOf(address(this)) - before;
        if (got < minOut) revert InsufficientOutput(got, minOut);
        emit Converted(feeToken, amount, got);
    }

    // ---------------------------------------------------------------- epochs

    /// @notice Reward token held and not promised to any published epoch.
    function available() public view returns (uint256) {
        uint256 bal = rewardToken.balanceOf(address(this));
        return bal > committed ? bal - committed : 0;
    }

    function publish(bytes32 root, uint256 total) external returns (uint256 id) {
        if (msg.sender != publisher) revert NotPublisher();
        if (paused) revert PausedError();
        if (root == bytes32(0) || total == 0 || total > type(uint128).max) revert BadParam();
        if (total > available()) revert NotEnoughFunds();

        id = nextEpoch++;
        uint64 at = uint64(block.timestamp) + claimDelay;
        epochs[id] = Epoch({root: root, total: uint128(total), claimed: 0, claimableAt: at, cancelled: false, swept: false});
        committed += total;
        emit Published(id, root, total, at);
    }

    /// @notice Withdraw a posted list before it becomes claimable (the list was wrong).
    function cancel(uint256 id) external onlyOwner {
        Epoch storage e = epochs[id];
        if (e.root == bytes32(0) || e.cancelled || e.swept || block.timestamp >= e.claimableAt) revert BadEpoch();
        e.cancelled = true;
        committed -= e.total;
        emit Cancelled(id);
    }

    function claim(uint256 id, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (paused) revert PausedError();
        Epoch storage e = epochs[id];
        if (e.root == bytes32(0) || e.cancelled || e.swept || block.timestamp < e.claimableAt) revert NotClaimable();
        if (hasClaimed[id][account]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(id, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, e.root, leaf)) revert BadProof();
        if (uint256(e.claimed) + amount > e.total) revert BadProof();

        hasClaimed[id][account] = true;
        e.claimed += uint128(amount);
        committed -= amount;
        rewardToken.safeTransfer(account, amount);
        emit Claimed(id, account, amount);
    }

    /// @notice After the claim window, return what nobody claimed to the pool (it funds later epochs).
    function sweep(uint256 id) external {
        Epoch storage e = epochs[id];
        if (e.root == bytes32(0) || e.cancelled || e.swept) revert BadEpoch();
        if (block.timestamp < uint256(e.claimableAt) + claimWindow) revert TooEarly();
        e.swept = true;
        uint256 left = e.total - e.claimed;
        committed -= left;
        emit Swept(id, left);
    }
}
