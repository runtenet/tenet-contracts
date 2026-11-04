// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {TenetVault} from "./TenetVault.sol";

/// @title TenetHub
/// @notice Protocol registry: creates user vaults, keeps the operator and adapter allowlists,
/// the oracle registry and the fee settings. It never holds or moves user funds.
interface IKeeperRegistry {
    function isActive(address keeper) external view returns (bool);
}

contract TenetHub is Ownable2Step {
    struct FeedConfig {
        IPriceFeed feed;
        uint32 maxStaleness; // seconds; a price older than this is unusable
    }

    uint16 public constant MAX_FEE_BPS = 50; // 0.5% cap for each fee

    address public immutable vaultImplementation;

    mapping(address => bool) public isOperator;
    /// @notice Optional open keeper network: bonded keepers may trigger executions too. Zero disables it.
    IKeeperRegistry public keeperRegistry;
    mapping(address => bool) public isAdapter;
    mapping(address => FeedConfig) public feedOf;
    mapping(address => bool) public isVault;
    mapping(address => address[]) internal _vaultsOf;
    address[] public allVaults;

    /// @notice Optional Chainlink L2 sequencer uptime feed. Zero disables the check.
    IPriceFeed public sequencerFeed;
    uint32 public sequencerGracePeriod = 1 hours;

    uint16 public keeperFeeBps = 10; // paid to the executing operator
    uint16 public protocolFeeBps = 10; // paid to feeRecipient
    address public feeRecipient;

    /// @notice Global emergency stop for executions. Withdrawals are never paused.
    bool public executionsPaused;

    /// @notice Hot key that can only *pause* executions. Unpausing is owner-only.
    address public guardian;

    /// @notice Max USD value (1e18) of the input of a single execution. 0 = no limit.
    /// A beta-period brake: it bounds what any one run can move.
    uint256 public maxTradeUsd;

    /// @notice Tokens with an issuer-side pause flag (Robinhood stock tokens): while the token's
    /// `oraclePaused()`/`paused()` is true, or a multiplier change (split, reinvested dividend) is
    /// about to happen or has just happened, the token has no usable price.
    mapping(address => bool) public tokenPauseCheck;
    uint32 public constant CORPORATE_ACTION_LEAD = 1 hours;
    uint32 public constant CORPORATE_ACTION_COOLDOWN = 2 hours;

    event VaultCreated(address indexed owner, address indexed vault);
    event GuardianSet(address indexed guardian);
    event MaxTradeUsdSet(uint256 maxTradeUsd);
    event TokenPauseCheckSet(address indexed token, bool enabled);
    event OperatorSet(address indexed operator, bool allowed);
    event KeeperRegistrySet(address indexed registry);
    event AdapterSet(address indexed adapter, bool allowed);
    event FeedSet(address indexed token, address feed, uint32 maxStaleness);
    event SequencerFeedSet(address feed, uint32 gracePeriod);
    event FeesSet(uint16 keeperFeeBps, uint16 protocolFeeBps, address feeRecipient);
    event ExecutionsPaused(bool paused);

    error FeeTooHigh();
    error ZeroAddress();
    error NotAuthorized();

    constructor(address initialOwner, address feeRecipient_) Ownable(initialOwner) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        vaultImplementation = address(new TenetVault());
    }

    // ---------------------------------------------------------------- vaults

    function createVault() external returns (address vault) {
        vault = Clones.clone(vaultImplementation);
        TenetVault(vault).initialize(msg.sender);
        isVault[vault] = true;
        _vaultsOf[msg.sender].push(vault);
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    function vaultsOf(address owner_) external view returns (address[] memory) {
        return _vaultsOf[owner_];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    // ---------------------------------------------------------------- prices

    /// @notice USD price of one whole `token`, scaled to 1e18.
    /// @return price the price (0 when unusable)
    /// @return ok false when there is no feed, the answer is non-positive or stale, or the sequencer is down
    function getPrice(address token) public view returns (uint256 price, bool ok) {
        FeedConfig memory cfg = feedOf[token];
        if (address(cfg.feed) == address(0) || address(cfg.feed).code.length == 0) return (0, false);
        if (!sequencerUp()) return (0, false);
        if (tokenPauseCheck[token] && _tokenSuspended(token)) return (0, false);

        try cfg.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (0, false);
            if (block.timestamp - updatedAt > cfg.maxStaleness) return (0, false);
            try cfg.feed.decimals() returns (uint8 dec) {
                if (dec > 36) return (0, false);
                price = dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
                return (price, price > 0);
            } catch {
                return (0, false);
            }
        } catch {
            return (0, false);
        }
    }

    /// @dev True when the issuer paused the token's oracle/transfers, or a multiplier change is
    /// imminent or just happened (the feed may lag the new multiplier).
    function _tokenSuspended(address token) internal view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall{gas: 60_000}(abi.encodeWithSignature("oraclePaused()"));
        if (!ok || ret.length < 32) return true; // flagged token that cannot answer: treat as suspended
        if (abi.decode(ret, (bool))) return true;

        (ok, ret) = token.staticcall{gas: 60_000}(abi.encodeWithSignature("paused()"));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return true;

        (bool ok1, bytes memory cur) = token.staticcall{gas: 60_000}(abi.encodeWithSignature("uiMultiplier()"));
        (bool ok2, bytes memory nxt) = token.staticcall{gas: 60_000}(abi.encodeWithSignature("newUIMultiplier()"));
        (bool ok3, bytes memory eff) = token.staticcall{gas: 60_000}(abi.encodeWithSignature("effectiveAt()"));
        if (ok1 && ok2 && ok3 && cur.length >= 32 && nxt.length >= 32 && eff.length >= 32) {
            uint256 effectiveAt = abi.decode(eff, (uint256));
            if (abi.decode(nxt, (uint256)) != abi.decode(cur, (uint256)) && block.timestamp + CORPORATE_ACTION_LEAD >= effectiveAt) {
                return true; // change imminent, or overdue and not yet applied
            }
            if (effectiveAt != 0 && block.timestamp >= effectiveAt && block.timestamp < effectiveAt + CORPORATE_ACTION_COOLDOWN) {
                return true; // just applied: the price feed may still reflect the old multiplier
            }
        }
        return false;
    }

    function sequencerUp() public view returns (bool) {
        if (address(sequencerFeed) == address(0)) return true;
        if (address(sequencerFeed).code.length == 0) return false;
        try sequencerFeed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            // answer 0 = up, 1 = down
            if (answer != 0) return false;
            return block.timestamp - startedAt > sequencerGracePeriod;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- admin

    /// @notice Who may trigger an execution: an allowlisted operator, or an active (bonded) keeper of the registry.
    function canExecute(address who) external view returns (bool) {
        if (isOperator[who]) return true;
        IKeeperRegistry registry = keeperRegistry;
        if (address(registry) == address(0)) return false;
        try registry.isActive(who) returns (bool active) {
            return active;
        } catch {
            return false;
        }
    }

    function setKeeperRegistry(address registry) external onlyOwner {
        keeperRegistry = IKeeperRegistry(registry);
        emit KeeperRegistrySet(registry);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        isAdapter[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function setFeed(address token, address feed, uint32 maxStaleness) external onlyOwner {
        feedOf[token] = FeedConfig(IPriceFeed(feed), maxStaleness);
        emit FeedSet(token, feed, maxStaleness);
    }

    function setSequencerFeed(address feed, uint32 gracePeriod) external onlyOwner {
        sequencerFeed = IPriceFeed(feed);
        sequencerGracePeriod = gracePeriod;
        emit SequencerFeedSet(feed, gracePeriod);
    }

    function setFees(uint16 keeperFeeBps_, uint16 protocolFeeBps_, address feeRecipient_) external onlyOwner {
        if (keeperFeeBps_ > MAX_FEE_BPS || protocolFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        keeperFeeBps = keeperFeeBps_;
        protocolFeeBps = protocolFeeBps_;
        feeRecipient = feeRecipient_;
        emit FeesSet(keeperFeeBps_, protocolFeeBps_, feeRecipient_);
    }

    /// @notice The owner can pause and unpause. The guardian can only pause.
    function setExecutionsPaused(bool paused) external {
        if (msg.sender != owner() && !(paused && msg.sender == guardian)) revert NotAuthorized();
        executionsPaused = paused;
        emit ExecutionsPaused(paused);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setMaxTradeUsd(uint256 maxTradeUsd_) external onlyOwner {
        maxTradeUsd = maxTradeUsd_;
        emit MaxTradeUsdSet(maxTradeUsd_);
    }

    function setTokenPauseCheck(address token, bool enabled) external onlyOwner {
        tokenPauseCheck[token] = enabled;
        emit TokenPauseCheckSet(token, enabled);
    }
}
