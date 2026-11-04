// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IWrappedEther {
    function deposit() external payable;
}

/// @title FeePool
/// @notice The owner's pool for fees earned outside the protocol (for example the creator fees of a launchpad token).
/// Two rules, nothing else:
///  - When something is DEPOSITED, `burnBps` of it goes at once to the fee burner, which burns it (a project token is burned as it
///    is, any other token is swapped into the project token first). The rest stays here.
///  - What stays here is NOT burned later. The owner can withdraw it whenever they like, and spend it however they decide.
/// Tokens that reach the pool in any other way (a plain transfer) are not touched by the burn: they are simply held.
/// The owner can pay what stays to the people who publish agents (payAuthors): one transaction, many recipients, and every
/// payment is an on-chain event, so anyone can see who was paid, how much and why.
/// The burn share can be changed by the owner, and only ever applies to deposits made afterwards.
contract FeePool is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;

    /// @notice The fee burner that receives the burn share.
    address public immutable burner;
    /// @notice Wrapped ether, so ETH can be deposited in one step.
    address public immutable weth;
    uint16 public burnBps;

    event Deposited(address indexed token, address indexed from, uint256 amount, uint256 burned, uint256 kept);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event BurnBpsSet(uint16 burnBps);
    /// @dev one payment to an author of an agent or playbook, paid from the pool
    event AuthorPaid(address indexed token, address indexed to, uint256 amount, string note);

    error BadShare();
    error NothingToDeposit();
    error BadPayout();

    uint256 public constant MAX_PAYOUTS = 50;

    constructor(address owner_, address burner_, address weth_, uint16 burnBps_) Ownable(owner_) {
        if (burnBps_ > BPS) revert BadShare();
        burner = burner_;
        weth = weth_;
        burnBps = burnBps_;
    }

    /// @notice Put `amount` of `token` into the pool. The caller approves it first.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert NothingToDeposit();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _split(token, msg.sender, amount);
    }

    /// @notice Put ETH into the pool (it is wrapped into WETH).
    function depositEth() external payable nonReentrant {
        if (msg.value == 0) revert NothingToDeposit();
        IWrappedEther(weth).deposit{value: msg.value}();
        _split(weth, msg.sender, msg.value);
    }

    function _split(address token, address from, uint256 amount) internal {
        uint256 burned = (amount * burnBps) / BPS;
        if (burned > 0) IERC20(token).safeTransfer(burner, burned);
        emit Deposited(token, from, amount, burned, amount - burned);
    }

    /// @notice Take `amount` of `token` out of the pool. Only the owner.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Pay authors from the pool: `amounts[i]` of `token` to `to[i]`. Only the owner. `note` says what the payment is for
    /// (for example "week of 2026-11-02, by volume") and is published in every event.
    function payAuthors(address token, address[] calldata to, uint256[] calldata amounts, string calldata note) external onlyOwner nonReentrant {
        if (to.length == 0 || to.length != amounts.length || to.length > MAX_PAYOUTS || bytes(note).length > 200) revert BadPayout();
        for (uint256 i; i < to.length; ++i) {
            if (to[i] == address(0) || amounts[i] == 0) revert BadPayout();
            IERC20(token).safeTransfer(to[i], amounts[i]);
            emit AuthorPaid(token, to[i], amounts[i], note);
        }
    }

    /// @notice The share of every FUTURE deposit that is burned (0 to 100%).
    function setBurnBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert BadShare();
        burnBps = bps;
        emit BurnBpsSet(bps);
    }
}
