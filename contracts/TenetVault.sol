// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

interface ITenetHub {
    function canExecute(address) external view returns (bool);
    function isAdapter(address) external view returns (bool);
    function executionsPaused() external view returns (bool);
    function getPrice(address token) external view returns (uint256 price, bool ok);
    function maxTradeUsd() external view returns (uint256);
    function keeperFeeBps() external view returns (uint16);
    function protocolFeeBps() external view returns (uint16);
    function feeRecipient() external view returns (address);
}

/// @title TenetVault
/// @notice One user's vault. The owner deposits tokens and sets strategies; allowlisted operators
/// execute them when their conditions hold. Every trade is bounded by the oracle price and the
/// strategy's slippage, so an operator can only choose *when* to run inside the owner's rules.
/// The owner can withdraw any token at any time, whatever the pause state.
contract TenetVault is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        DCA, // buy tokenOut with `amount` of tokenIn every `interval`; optional max buy price
        StopLoss, // sell `amount` of tokenIn once its price <= triggerPrice
        TakeProfit, // sell `amount` of tokenIn once its price >= triggerPrice
        Rebalance // keep tokenOut at targetBps of the pair's value, trade when drift > driftBps
    }

    /// @dev Why a strategy is or is not ready. Mirrored in the backend and the web app.
    enum Status {
        Ready,
        Inactive,
        Paused,
        Expired,
        MaxRuns,
        TooEarly,
        PriceNotMet,
        NoBalance,
        OracleUnavailable,
        InBand,
        AdapterNotAllowed,
        OverTradeLimit, // the run would exceed the protocol's per-trade cap (hub.maxTradeUsd)
        OverAgentLimit // an agent-made strategy would go beyond the limits its owner gave the agent
    }

    struct Strategy {
        Kind kind;
        bool active;
        address tokenIn; // DCA: what you pay with; SL/TP: what you sell; Rebalance: the stable side
        address tokenOut; // DCA: what you buy; SL/TP: what you receive; Rebalance: the risk side
        address adapter;
        uint256 amount; // DCA: per run; SL/TP: amount to sell (max = whole balance); Rebalance: max USD (1e18) per run, 0 = no cap
        uint256 triggerPrice; // USD 1e18. DCA: max buy price (0 = any); SL/TP: trigger on tokenIn's price
        uint32 interval; // DCA / Rebalance: min seconds between runs
        uint16 slippageBps; // max shortfall vs the oracle-implied output
        uint16 targetBps; // Rebalance only
        uint16 driftBps; // Rebalance only
        uint32 maxRuns; // 0 = unlimited (SL/TP are always single-shot)
        uint32 runs;
        uint64 lastRun;
        uint64 expiresAt; // 0 = never
    }

    struct Plan {
        Status status;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 priceIn;
        uint256 priceOut;
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    uint32 public constant MIN_INTERVAL = 60;
    uint16 internal constant BPS = 10_000;

    /// @notice What the owner lets an AI agent do in this vault. The agent can create and cancel ITS OWN strategies inside
    /// these limits and nothing else: it cannot withdraw, cannot touch the owner's strategies, cannot change its own limits.
    /// The limits are checked again every time one of its strategies runs, so lowering them takes effect at once.
    struct AgentGrant {
        address agent;
        uint64 expiresAt;
        uint128 maxUsdPerStrategy; // USD 1e18: the most one run of one agent strategy may move
        uint128 maxUsdPerDay; // USD 1e18: the most all agent strategies together may move in one UTC day
        uint32 maxActive; // how many agent strategies may be active at once
        uint32 minInterval; // the shortest interval the agent may set (seconds)
        uint16 maxSlippageBps;
    }

    uint32 public constant MAX_AGENT_ACTIVE = 50;
    uint8 public constant MAX_AGENT_TOKENS = 40;
    uint64 public constant MAX_AGENT_TERM = 90 days;
    /// @dev how many chunks an agent's "close the whole position" may take at most
    uint32 internal constant MAX_CLOSEOUT_RUNS = 100;
    /// @dev what is left of a position after a close-out chunk counts as nothing (USD 1e18)
    uint256 internal constant DUST_USD = 1e18;

    AgentGrant public agentGrant;
    address[] internal _agentTokens;
    mapping(address => bool) public agentToken;
    mapping(uint256 => bool) public agentMade;
    uint32 public agentActive;
    uint64 public agentDay;
    uint128 public agentDaySpent;
    /// @notice The owner's switch for DIRECT trading: with it on, the agent may swap on its own (see agentTrade), still inside
    /// the same grant limits. Off by default, and switched off again whenever the grant is replaced or revoked.
    bool public agentTrading;
    uint64 public agentLastTrade;

    ITenetHub public hub;
    address public owner;
    bool public paused;
    Strategy[] internal _strategies;

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event StrategyCreated(uint256 indexed id, Kind kind, address tokenIn, address tokenOut);
    event StrategyCancelled(uint256 indexed id);
    event AgentSet(address indexed agent, uint64 expiresAt, uint128 maxUsdPerStrategy, uint128 maxUsdPerDay, uint32 maxActive);
    event AgentRevoked(uint256 strategiesCancelled);
    event AgentTradingSet(bool on);
    /// @dev one direct trade by the agent, with the reason it gave: this is the public record of what the agent did and why
    event AgentTraded(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 priceIn,
        uint256 priceOut,
        uint256 protocolFee,
        string note
    );
    event AgentStrategyCreated(uint256 indexed id);
    event StrategyCompleted(uint256 indexed id);
    event VaultPaused(bool paused);
    event StrategyExecuted(
        uint256 indexed id,
        address indexed operator,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 priceIn,
        uint256 priceOut,
        uint256 keeperFee,
        uint256 protocolFee
    );

    error NotOwner();
    error NotOperator();
    error InvalidStrategy(string reason);
    error NotReady(Status status);
    error UnknownStrategy();
    error SlippageExceeded(uint256 received, uint256 minimum);
    error OverSpent(uint256 spent, uint256 allowed);
    error NotAgent();
    error AgentLimit(string reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        hub = ITenetHub(msg.sender);
        owner = owner_;
    }

    // ---------------------------------------------------------------- funds

    function deposit(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    /// @notice Always available to the owner, even when the vault or the protocol is paused.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit VaultPaused(paused_);
    }

    // ---------------------------------------------------------------- strategies

    function createStrategy(Strategy calldata s) external onlyOwner returns (uint256 id) {
        return _create(s, false);
    }

    /// @param closeOut an agent's stop-loss / take-profit with amount "everything": it runs in chunks until the position is gone
    function _create(Strategy calldata s, bool closeOut) internal returns (uint256 id) {
        _validate(s);
        Strategy memory stored = s;
        stored.active = true;
        stored.runs = 0;
        stored.lastRun = 0;
        if (s.kind == Kind.StopLoss || s.kind == Kind.TakeProfit) stored.maxRuns = closeOut ? MAX_CLOSEOUT_RUNS : 1;
        _strategies.push(stored);
        id = _strategies.length - 1;
        emit StrategyCreated(id, s.kind, s.tokenIn, s.tokenOut);
    }

    function cancelStrategy(uint256 id) external onlyOwner {
        if (id >= _strategies.length) revert UnknownStrategy();
        _deactivate(id);
    }

    /// @dev Turns a strategy off and keeps the agent's count of active strategies right.
    function _deactivate(uint256 id) internal {
        Strategy storage st = _strategies[id];
        if (st.active && agentMade[id]) agentActive -= 1;
        st.active = false;
        emit StrategyCancelled(id);
    }

    // ---------------------------------------------------------------- the agent

    /// @notice Let `agent` manage strategies inside these limits for a while. Replaces any earlier grant.
    function setAgent(
        address agent,
        uint64 expiresAt,
        uint128 maxUsdPerStrategy,
        uint128 maxUsdPerDay,
        uint32 maxActive,
        uint32 minInterval,
        uint16 maxSlippageBps,
        address[] calldata tokens
    ) external onlyOwner {
        if (agent == address(0) || agent == owner) revert AgentLimit("agent");
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_AGENT_TERM) revert AgentLimit("term");
        if (maxUsdPerStrategy == 0 || maxUsdPerDay < maxUsdPerStrategy) revert AgentLimit("amounts");
        if (maxActive == 0 || maxActive > MAX_AGENT_ACTIVE) revert AgentLimit("active");
        if (minInterval < MIN_INTERVAL) revert AgentLimit("interval");
        if (maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS) revert AgentLimit("slippage");
        if (tokens.length < 2 || tokens.length > MAX_AGENT_TOKENS) revert AgentLimit("tokens");

        _clearAgentTokens();
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0) || agentToken[tokens[i]]) revert AgentLimit("tokens");
            agentToken[tokens[i]] = true;
            _agentTokens.push(tokens[i]);
        }
        agentGrant = AgentGrant(agent, expiresAt, maxUsdPerStrategy, maxUsdPerDay, maxActive, minInterval, maxSlippageBps);
        _stopTrading(); // a new grant never inherits the direct-trading switch: turn it on again on purpose
        emit AgentSet(agent, expiresAt, maxUsdPerStrategy, maxUsdPerDay, maxActive);
    }

    /// @notice Take the agent's powers away at once. Optionally stop everything it made too.
    function revokeAgent(bool cancelItsStrategies) external onlyOwner {
        uint256 stopped;
        if (cancelItsStrategies) {
            for (uint256 i; i < _strategies.length; ++i) {
                if (agentMade[i] && _strategies[i].active) {
                    _strategies[i].active = false;
                    emit StrategyCancelled(i);
                    ++stopped;
                }
            }
            agentActive = 0;
        }
        delete agentGrant;
        _clearAgentTokens();
        _stopTrading();
        emit AgentRevoked(stopped);
    }

    function _stopTrading() internal {
        if (agentTrading) {
            agentTrading = false;
            emit AgentTradingSet(false);
        }
    }

    /// @notice Let the agent trade directly (not only through rules), or take that away again. Needs a live agent grant.
    function setAgentTrading(bool on) external onlyOwner {
        if (on && (agentGrant.agent == address(0) || block.timestamp > agentGrant.expiresAt)) revert AgentLimit("no agent");
        agentTrading = on;
        emit AgentTradingSet(on);
    }

    /// @notice The agent swaps on its own initiative. Every limit the owner gave it applies to each trade: allowed tokens only,
    /// at most maxUsdPerStrategy per trade and maxUsdPerDay per day (shared with its strategies), no more often than minInterval,
    /// never past the protocol's per-trade cap, and never below the oracle price minus maxSlippageBps. It still cannot withdraw.
    /// @param note why the agent trades; at most 280 bytes, published in the event
    function agentTrade(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address adapter,
        bytes calldata adapterData,
        string calldata note
    ) external nonReentrant returns (uint256 amountOut) {
        AgentGrant memory g = agentGrant;
        if (g.agent == address(0) || msg.sender != g.agent) revert NotAgent();
        if (!agentTrading) revert AgentLimit("trading is off");
        if (block.timestamp > g.expiresAt) revert AgentLimit("expired");
        if (paused || hub.executionsPaused()) revert AgentLimit("paused");
        if (tokenIn == tokenOut || !agentToken[tokenIn] || !agentToken[tokenOut]) revert AgentLimit("token not allowed");
        if (!hub.isAdapter(adapter)) revert AgentLimit("adapter");
        if (bytes(note).length > 280) revert AgentLimit("note");
        if (agentLastTrade != 0 && block.timestamp < uint256(agentLastTrade) + g.minInterval) revert AgentLimit("too soon");
        if (amountIn == 0 || amountIn > IERC20(tokenIn).balanceOf(address(this))) revert AgentLimit("amount");

        (uint256 priceIn, bool okIn) = hub.getPrice(tokenIn);
        (uint256 priceOut, bool okOut) = hub.getPrice(tokenOut);
        if (!okIn || !okOut) revert AgentLimit("price");
        uint256 usd = _value(tokenIn, amountIn, priceIn);
        if (usd > g.maxUsdPerStrategy) revert AgentLimit("size");
        uint256 cap = hub.maxTradeUsd();
        if (cap != 0 && usd > cap) revert AgentLimit("protocol trade cap");
        uint256 spentToday = (block.timestamp / 1 days == agentDay) ? agentDaySpent : 0;
        if (spentToday + usd > g.maxUsdPerDay) revert AgentLimit("daily limit");

        // effects first
        _agentSpend(usd);
        agentLastTrade = uint64(block.timestamp);

        uint256 protocolFee = (amountIn * hub.protocolFeeBps()) / BPS;
        uint256 swapAmount = amountIn - protocolFee;
        uint256 minOut = (_quote(tokenIn, tokenOut, swapAmount, priceIn, priceOut) * (BPS - g.maxSlippageBps)) / BPS;

        amountOut = _swap(adapter, tokenIn, tokenOut, swapAmount, minOut, adapterData);
        if (protocolFee > 0) IERC20(tokenIn).safeTransfer(hub.feeRecipient(), protocolFee);

        emit AgentTraded(tokenIn, tokenOut, amountIn, amountOut, priceIn, priceOut, protocolFee, note);
    }

    function agentTokens() external view returns (address[] memory) {
        return _agentTokens;
    }

    /// @notice The agent creates a strategy of its own, inside the owner's limits.
    function agentCreateStrategy(Strategy calldata s) external returns (uint256 id) {
        AgentGrant memory g = agentGrant;
        if (g.agent == address(0) || msg.sender != g.agent) revert NotAgent();
        if (block.timestamp > g.expiresAt) revert AgentLimit("expired");
        if (agentActive >= g.maxActive) revert AgentLimit("too many active strategies");
        if (!agentToken[s.tokenIn] || !agentToken[s.tokenOut]) revert AgentLimit("token not allowed");
        if (s.slippageBps > g.maxSlippageBps) revert AgentLimit("slippage");
        bool oneShot = s.kind == Kind.StopLoss || s.kind == Kind.TakeProfit;
        if (!oneShot && s.interval < g.minInterval) revert AgentLimit("interval");

        // the size of one run, in USD
        bool closeOut = oneShot && s.amount == type(uint256).max; // "sell everything", done in chunks (see _plan)
        uint256 usd;
        if (closeOut) {
            usd = 0; // each chunk is cut down to the limits when it runs
        } else if (s.kind == Kind.Rebalance) {
            if (s.amount == 0) revert AgentLimit("size"); // a rebalance must carry its own cap
            usd = s.amount;
        } else {
            if (s.amount == type(uint256).max) revert AgentLimit("size"); // a repeating buy needs a real amount
            (uint256 priceIn, bool ok) = hub.getPrice(s.tokenIn);
            if (!ok) revert AgentLimit("price");
            usd = _value(s.tokenIn, s.amount, priceIn);
        }
        if (usd > g.maxUsdPerStrategy) revert AgentLimit("size");

        id = _create(s, closeOut);
        agentMade[id] = true;
        agentActive += 1;
        emit AgentStrategyCreated(id);
    }

    /// @notice The agent stops a strategy it made.
    function agentCancelStrategy(uint256 id) external {
        address agent = agentGrant.agent;
        if (agent == address(0) || msg.sender != agent) revert NotAgent();
        if (id >= _strategies.length) revert UnknownStrategy();
        if (!agentMade[id]) revert AgentLimit("not an agent strategy");
        _deactivate(id);
    }

    function _clearAgentTokens() internal {
        for (uint256 i; i < _agentTokens.length; ++i) delete agentToken[_agentTokens[i]];
        delete _agentTokens;
    }

    /// @dev Counts the value of an agent run against today's allowance.
    function _agentSpend(uint256 usd) internal {
        uint64 day = uint64(block.timestamp / 1 days);
        if (day != agentDay) {
            agentDay = day;
            agentDaySpent = 0;
        }
        agentDaySpent += uint128(usd);
    }

    function strategyCount() external view returns (uint256) {
        return _strategies.length;
    }

    function getStrategy(uint256 id) external view returns (Strategy memory) {
        if (id >= _strategies.length) revert UnknownStrategy();
        return _strategies[id];
    }

    function getStrategies() external view returns (Strategy[] memory) {
        return _strategies;
    }

    /// @notice What `execute` would do right now, and why it would not.
    function checkStrategy(uint256 id) external view returns (Plan memory) {
        if (id >= _strategies.length) revert UnknownStrategy();
        return _plan(id, _strategies[id]);
    }

    // ---------------------------------------------------------------- execution

    /// @notice Run a strategy. Callable by an allowlisted operator or the owner.
    /// @param adapterData venue-specific routing data, opaque to the vault
    function execute(uint256 id, bytes calldata adapterData) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != owner && !hub.canExecute(msg.sender)) revert NotOperator();
        if (id >= _strategies.length) revert UnknownStrategy();

        Strategy storage s = _strategies[id];
        Plan memory p = _plan(id, s);
        if (p.status != Status.Ready) revert NotReady(p.status);

        // effects first
        s.runs += 1;
        s.lastRun = uint64(block.timestamp);
        bool completed = s.maxRuns != 0 && s.runs >= s.maxRuns;
        if (completed) {
            s.active = false;
            if (agentMade[id]) agentActive -= 1;
        }
        if (agentMade[id]) _agentSpend(_value(p.tokenIn, p.amountIn, p.priceIn));

        uint256 keeperFee = msg.sender == owner ? 0 : (p.amountIn * hub.keeperFeeBps()) / BPS;
        uint256 protocolFee = (p.amountIn * hub.protocolFeeBps()) / BPS;
        uint256 swapAmount = p.amountIn - keeperFee - protocolFee;

        uint256 minOut = _quote(p.tokenIn, p.tokenOut, swapAmount, p.priceIn, p.priceOut);
        minOut = (minOut * (BPS - s.slippageBps)) / BPS;

        amountOut = _swap(s.adapter, p.tokenIn, p.tokenOut, swapAmount, minOut, adapterData);

        if (keeperFee > 0) IERC20(p.tokenIn).safeTransfer(msg.sender, keeperFee);
        if (protocolFee > 0) IERC20(p.tokenIn).safeTransfer(hub.feeRecipient(), protocolFee);

        emit StrategyExecuted(
            id, msg.sender, p.tokenIn, p.tokenOut, p.amountIn, amountOut, p.priceIn, p.priceOut, keeperFee, protocolFee
        );
        if (!completed && agentMade[id] && s.amount == type(uint256).max) {
            uint256 left = IERC20(p.tokenIn).balanceOf(address(this));
            if (left == 0 || _value(p.tokenIn, left, p.priceIn) < DUST_USD) {
                s.active = false;
                agentActive -= 1;
                completed = true;
            }
        }
        if (completed) emit StrategyCompleted(id);
    }

    function _swap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata adapterData
    ) internal returns (uint256 received) {
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(adapter, amountIn);
        ISwapAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut, address(this), adapterData);
        IERC20(tokenIn).forceApprove(adapter, 0);

        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > amountIn) revert OverSpent(spent, amountIn);
        received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < minOut) revert SlippageExceeded(received, minOut);
    }

    // ---------------------------------------------------------------- planning

    function _plan(uint256 id, Strategy memory s) internal view returns (Plan memory p) {
        p.tokenIn = s.tokenIn;
        p.tokenOut = s.tokenOut;

        if (!s.active) return _status(p, Status.Inactive);
        if (paused || hub.executionsPaused()) return _status(p, Status.Paused);
        if (s.expiresAt != 0 && block.timestamp > s.expiresAt) return _status(p, Status.Expired);
        if (s.maxRuns != 0 && s.runs >= s.maxRuns) return _status(p, Status.MaxRuns);
        if (!hub.isAdapter(s.adapter)) return _status(p, Status.AdapterNotAllowed);
        if (s.lastRun != 0 && block.timestamp < uint256(s.lastRun) + s.interval) return _status(p, Status.TooEarly);

        bool okIn;
        bool okOut;
        (p.priceIn, okIn) = hub.getPrice(s.tokenIn);
        (p.priceOut, okOut) = hub.getPrice(s.tokenOut);
        if (!okIn || !okOut) return _status(p, Status.OracleUnavailable);

        uint256 balIn = IERC20(s.tokenIn).balanceOf(address(this));

        if (s.kind == Kind.DCA) {
            if (s.triggerPrice != 0 && p.priceOut > s.triggerPrice) return _status(p, Status.PriceNotMet);
            if (balIn < s.amount) return _status(p, Status.NoBalance);
            p.amountIn = s.amount;
        } else if (s.kind == Kind.StopLoss || s.kind == Kind.TakeProfit) {
            bool hit = s.kind == Kind.StopLoss ? p.priceIn <= s.triggerPrice : p.priceIn >= s.triggerPrice;
            if (!hit) return _status(p, Status.PriceNotMet);
            if (balIn == 0) return _status(p, Status.NoBalance);
            p.amountIn = Math.min(s.amount, balIn);
        } else {
            p = _planRebalance(s, p, balIn);
            if (p.status != Status.Ready) return p;
        }

        if (p.amountIn == 0) return _status(p, Status.NoBalance);

        if (agentMade[id] && s.amount == type(uint256).max && (s.kind == Kind.StopLoss || s.kind == Kind.TakeProfit)) {
            // an agent closing a whole position: sell it a chunk at a time, never more than one run, today's allowance or the protocol's cap
            AgentGrant memory cg = agentGrant;
            if (cg.agent == address(0) || block.timestamp > cg.expiresAt) return _status(p, Status.Expired);
            uint256 limitUsd = cg.maxUsdPerStrategy;
            uint256 hubCap = hub.maxTradeUsd();
            if (hubCap != 0 && hubCap < limitUsd) limitUsd = hubCap;
            uint256 spentToday = (block.timestamp / 1 days == agentDay) ? agentDaySpent : 0;
            uint256 leftToday = cg.maxUsdPerDay > spentToday ? cg.maxUsdPerDay - spentToday : 0;
            if (leftToday < limitUsd) limitUsd = leftToday;
            uint256 chunk = _amountFor(p.tokenIn, limitUsd, p.priceIn);
            if (chunk == 0) return _status(p, Status.OverAgentLimit);
            if (chunk < p.amountIn) p.amountIn = chunk;
        }

        uint256 cap = hub.maxTradeUsd();
        if (cap != 0 && _value(p.tokenIn, p.amountIn, p.priceIn) > cap) return _status(p, Status.OverTradeLimit);

        if (agentMade[id]) {
            // an agent's strategy only runs while its grant is alive, and always inside the owner's limits as they are NOW
            AgentGrant memory g = agentGrant;
            if (g.agent == address(0) || block.timestamp > g.expiresAt) return _status(p, Status.Expired);
            if (!agentToken[s.tokenIn] || !agentToken[s.tokenOut]) return _status(p, Status.OverAgentLimit);
            uint256 v = _value(p.tokenIn, p.amountIn, p.priceIn);
            uint256 spent = (block.timestamp / 1 days == agentDay) ? agentDaySpent : 0;
            if (v > g.maxUsdPerStrategy || spent + v > g.maxUsdPerDay) return _status(p, Status.OverAgentLimit);
        }

        p.status = Status.Ready;
    }

    /// @dev tokenIn = stable side (A), tokenOut = risk side (B). The trade direction is decided here.
    function _planRebalance(Strategy memory s, Plan memory p, uint256 balA) internal view returns (Plan memory) {
        uint256 priceA = p.priceIn;
        uint256 priceB = p.priceOut;
        uint256 balB = IERC20(s.tokenOut).balanceOf(address(this));
        uint256 valA = _value(s.tokenIn, balA, priceA);
        uint256 valB = _value(s.tokenOut, balB, priceB);
        uint256 total = valA + valB;
        if (total == 0) return _status(p, Status.NoBalance);

        uint256 weightB = (valB * BPS) / total;
        uint256 targetValB = (total * s.targetBps) / BPS;
        uint256 tradeValue;

        if (weightB > uint256(s.targetBps) + s.driftBps) {
            // too much risk: sell B for A
            tradeValue = valB - targetValB;
            if (s.amount != 0) tradeValue = Math.min(tradeValue, s.amount);
            p.tokenIn = s.tokenOut;
            p.tokenOut = s.tokenIn;
            p.priceIn = priceB;
            p.priceOut = priceA;
            p.amountIn = Math.min(_amountFor(s.tokenOut, tradeValue, priceB), balB);
        } else if (weightB + s.driftBps < s.targetBps) {
            // too little risk: buy B with A
            tradeValue = targetValB - valB;
            if (s.amount != 0) tradeValue = Math.min(tradeValue, s.amount);
            p.amountIn = Math.min(_amountFor(s.tokenIn, tradeValue, priceA), balA);
        } else {
            return _status(p, Status.InBand);
        }
        return p;
    }

    function _validate(Strategy calldata s) internal view {
        if (s.tokenIn == address(0) || s.tokenOut == address(0) || s.tokenIn == s.tokenOut) {
            revert InvalidStrategy("tokens");
        }
        if (!hub.isAdapter(s.adapter)) revert InvalidStrategy("adapter");
        if (s.slippageBps > MAX_SLIPPAGE_BPS) revert InvalidStrategy("slippage");
        (, bool okIn) = hub.getPrice(s.tokenIn);
        (, bool okOut) = hub.getPrice(s.tokenOut);
        if (!okIn || !okOut) revert InvalidStrategy("oracle");
        if (s.expiresAt != 0 && s.expiresAt <= block.timestamp) revert InvalidStrategy("expiry");

        if (s.kind == Kind.DCA) {
            if (s.amount == 0) revert InvalidStrategy("amount");
            if (s.interval < MIN_INTERVAL) revert InvalidStrategy("interval");
        } else if (s.kind == Kind.StopLoss || s.kind == Kind.TakeProfit) {
            if (s.amount == 0) revert InvalidStrategy("amount");
            if (s.triggerPrice == 0) revert InvalidStrategy("trigger");
        } else {
            if (s.targetBps == 0 || s.targetBps >= BPS) revert InvalidStrategy("target");
            if (s.driftBps == 0 || s.driftBps >= BPS) revert InvalidStrategy("drift");
            if (s.interval < MIN_INTERVAL) revert InvalidStrategy("interval");
        }
    }

    // ---------------------------------------------------------------- math

    function _status(Plan memory p, Status st) private pure returns (Plan memory) {
        p.status = st;
        p.amountIn = 0;
        return p;
    }

    /// @dev USD value (1e18) of `amount` raw units.
    function _value(address token, uint256 amount, uint256 price) internal view returns (uint256) {
        return Math.mulDiv(amount, price, 10 ** IERC20Metadata(token).decimals());
    }

    /// @dev Raw units of `token` worth `usd` (1e18).
    function _amountFor(address token, uint256 usd, uint256 price) internal view returns (uint256) {
        return Math.mulDiv(usd, 10 ** IERC20Metadata(token).decimals(), price);
    }

    /// @dev Oracle-implied output for `amountIn` of tokenIn.
    function _quote(address tokenIn, address tokenOut, uint256 amountIn, uint256 priceIn, uint256 priceOut)
        internal
        view
        returns (uint256)
    {
        return _amountFor(tokenOut, _value(tokenIn, amountIn, priceIn), priceOut);
    }
}
