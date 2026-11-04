// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

interface IPriceHub {
    function getPrice(address token) external view returns (uint256 price, bool ok);
}

interface ILicenses {
    function series(address vault) external view returns (address seller, uint128 price, uint32 maxSupply, uint32 sold, bool open);
}

interface IBurnToken {
    function burnToken() external view returns (address);
}

interface IWrappedEther {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title AuthorPayouts
/// @notice Holds the authors' share of the protocol fee (70%) and pays it out every hour, on its own, to everyone who has an
/// agent on sale. The pool is held as wrapped ether and paid out as plain ETH (WETH only for a wallet that cannot take ETH).
///
/// 1. Fees arrive in whatever the trade was paid in. A converter swaps them into the reward token (WETH) through the allowlisted
///    venue; this contract checks the result against the oracle price, so the converter cannot give the money away in a bad swap.
///    ETH sent straight to this contract is wrapped into the pool, so ETH from anywhere (Pons creator fees) can be put in.
/// 2. Once an hour the payer (a robot) calls `payout` with the vaults of the agents on sale. The CONTRACT checks every one of them:
///    the license sale must be open on AgentLicenses, one share per seller, and (when the project token exists and the gate is on)
///    the seller must hold the minimum share of its supply. It then pays `payoutBps` (10% by default) of the pool, split EQUALLY
///    between the qualifying sellers. The payer chooses nobody's amount and cannot name anyone who is not on sale.
/// 3. Because only a tenth of the pool leaves each hour, the pool rolls on: what is not paid now is paid in the next hours.
///
/// The owner can pause the payouts and can WITHDRAW from the pool at any time. The payer can only start an hourly payout.
contract AuthorPayouts is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 100;

    IERC20 public immutable rewardToken;
    uint8 public immutable rewardDecimals;
    IPriceHub public immutable hub;
    ISwapAdapter public immutable adapter;
    ILicenses public immutable licenses;
    /// @notice The fee burner: its project token (when set) is what sellers must hold to be paid.
    IBurnToken public immutable burner;

    /// @notice The share of the pool paid out each hour, in bps.
    uint16 public payoutBps = 1_000;
    /// @notice The shortest time between two payouts. A bit under an hour, so an hourly robot is never "too early".
    uint64 public minInterval = 55 minutes;
    /// @notice The share of the project token's supply a seller must hold to be paid; 0 turns the gate off.
    uint16 public gateBps = 5;
    uint16 public maxConvertSlippageBps = 300;
    uint64 public lastPayout;
    address public payer;
    mapping(address => bool) public isConverter;
    bool public paused;

    event Converted(address indexed feeToken, uint256 amountIn, uint256 amountOut);
    event Funded(address indexed from, uint256 amount);
    /// @dev one payment of one hourly round to one seller
    event PaidOut(uint256 indexed round, address indexed to, address indexed vault, uint256 amount);
    event Round(uint256 indexed round, uint256 pool, uint256 paid, uint256 recipients);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event PayerSet(address indexed payer);
    event ConverterSet(address indexed converter, bool allowed);
    event PausedSet(bool paused);
    event ParamsSet(uint16 payoutBps, uint64 minInterval, uint16 gateBps, uint16 maxConvertSlippageBps);

    error NotPayer();
    error NotConverter();
    error PausedError();
    error NoPrice();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error TooEarly();
    error BadParam();
    error WrongToken();
    error NobodyToPay();

    uint256 public round;

    /// @notice ETH sent here goes into the pool (wrapped). ETH coming back from the WETH contract is not re-wrapped.
    receive() external payable {
        if (msg.sender == address(rewardToken)) return;
        IWrappedEther(address(rewardToken)).deposit{value: msg.value}();
        emit Funded(msg.sender, msg.value);
    }

    /// @param rewardToken_ wrapped ether: the pool is held in it and paid out as ETH
    constructor(address owner_, address rewardToken_, address hub_, address adapter_, address licenses_, address burner_) Ownable(owner_) {
        rewardToken = IERC20(rewardToken_);
        rewardDecimals = IERC20Metadata(rewardToken_).decimals();
        hub = IPriceHub(hub_);
        adapter = ISwapAdapter(adapter_);
        licenses = ILicenses(licenses_);
        burner = IBurnToken(burner_);
    }

    // ---------------------------------------------------------------- setup

    function setPayer(address who) external onlyOwner {
        payer = who;
        emit PayerSet(who);
    }

    function setConverter(address who, bool allowed) external onlyOwner {
        isConverter[who] = allowed;
        emit ConverterSet(who, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setParams(uint16 payoutBps_, uint64 minInterval_, uint16 gateBps_, uint16 slippageBps) external onlyOwner {
        if (payoutBps_ == 0 || payoutBps_ > BPS || minInterval_ < 10 minutes || minInterval_ > 7 days || gateBps_ > 1_000 || slippageBps > 1_000) revert BadParam();
        payoutBps = payoutBps_;
        minInterval = minInterval_;
        gateBps = gateBps_;
        maxConvertSlippageBps = slippageBps;
        emit ParamsSet(payoutBps_, minInterval_, gateBps_, slippageBps);
    }

    /// @notice Take `amount` of `token` out of the pool. Only the owner.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
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

    // ---------------------------------------------------------------- the hourly payout

    /// @notice The share of the pool the next payout would pay out in all.
    function nextAmount() public view returns (uint256) {
        return (rewardToken.balanceOf(address(this)) * payoutBps) / BPS;
    }

    /// @notice Whether `seller` holds enough of the project token to be paid (always true while the gate is off or there is no token).
    function holdsEnough(address seller) public view returns (bool) {
        if (gateBps == 0) return true;
        address token = burner.burnToken();
        if (token == address(0)) return true;
        return IERC20(token).balanceOf(seller) >= (IERC20(token).totalSupply() * gateBps) / BPS;
    }

    /// @notice Pay this hour's round: `nextAmount()` split equally between the sellers of the given vaults. A vault counts only when its
    /// license sale is open and its seller holds the gate amount; one seller counts once however many vaults they list.
    /// Vaults that do not qualify are skipped, and the call reverts only when nobody qualifies.
    function payout(address[] calldata vaults) external nonReentrant returns (uint256 recipients) {
        if (msg.sender != payer) revert NotPayer();
        if (paused) revert PausedError();
        if (block.timestamp < uint256(lastPayout) + minInterval) revert TooEarly();
        if (vaults.length == 0 || vaults.length > MAX_RECIPIENTS) revert BadParam();

        address[] memory sellers = new address[](vaults.length);
        address[] memory chosen = new address[](vaults.length);
        for (uint256 i; i < vaults.length; ++i) {
            (address seller,,,, bool open) = licenses.series(vaults[i]);
            if (!open || seller == address(0) || !holdsEnough(seller)) continue;
            bool seen;
            for (uint256 j; j < recipients; ++j) {
                if (sellers[j] == seller) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;
            sellers[recipients] = seller;
            chosen[recipients] = vaults[i];
            ++recipients;
        }
        if (recipients == 0) revert NobodyToPay();

        uint256 pool = rewardToken.balanceOf(address(this));
        uint256 each = (pool * payoutBps) / BPS / recipients;
        if (each == 0) revert NobodyToPay();

        uint256 id = ++round;
        lastPayout = uint64(block.timestamp);
        IWrappedEther(address(rewardToken)).withdraw(each * recipients);
        for (uint256 k; k < recipients; ++k) {
            (bool sent,) = sellers[k].call{value: each, gas: 50_000}("");
            if (!sent) {
                // a wallet that cannot take ETH gets the same amount as WETH instead
                IWrappedEther(address(rewardToken)).deposit{value: each}();
                rewardToken.safeTransfer(sellers[k], each);
            }
            emit PaidOut(id, sellers[k], chosen[k], each);
        }
        emit Round(id, pool, each * recipients, recipients);
    }
}
