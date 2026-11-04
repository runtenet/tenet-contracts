// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentHub {
    function isVault(address vault) external view returns (bool);
}

interface IBurner {
    function burnToken() external view returns (address);
}

interface IAgentVault {
    function owner() external view returns (address);
}

/// @title AgentLicenses
/// @notice Licenses to a published agent. The owner of an agent's vault sells copies of the right to use that agent's goal
/// (the text that tells it what to aim for) for a price in the PROJECT TOKEN: the token the fee burner is set to. Before that
/// token exists nothing can be sold or bought; the moment the owner sets it on the burner, licenses are paid in it. A buyer pays and receives one license;
/// the website unlocks the private goal for whoever holds one, and the buyer starts their OWN agent with it, in THEIR OWN
/// vault, inside THEIR OWN limits.
///
/// Nothing here touches anyone's vault funds: a license is not a share of the seller's vault or of its profits, and the
/// buyer never gets any control over the seller's money. A license is an ordinary ERC-1155 token, so it can be transferred
/// or resold in any wallet or market; the id of a license is the agent's vault address, so one id = one agent.
///
/// The protocol takes `feeBps` of every primary sale (capped at 10%) and sends it to the burner, which burns it: every license
/// sold removes tokens from the supply. Secondary sales are the holders' own business.
contract AgentLicenses is ERC1155, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 1_000;
    uint16 internal constant BPS = 10_000;

    IAgentHub public immutable hub;
    /// @notice The fee burner. Its project token is the currency of every license, and the protocol's cut is sent to it to be burned.
    IBurner public immutable burner;
    uint16 public feeBps;

    struct Series {
        address seller; // the owner of the vault when the series was last set: the one paid
        uint128 price; // in units of the project token (its own decimals)
        uint32 maxSupply; // 0 = no limit
        uint32 sold;
        bool open;
    }

    mapping(address vault => Series) public series;

    event SeriesSet(address indexed vault, address indexed seller, uint128 price, uint32 maxSupply, bool open);
    event Licensed(address indexed vault, address indexed buyer, address indexed seller, uint256 price, uint256 fee);
    event FeeSet(uint16 feeBps);

    error NotAVault();
    error NotVaultOwner();
    error BadSeries();
    error NotForSale();
    error SoldOut();
    error AlreadyLicensed();
    error FeeTooHigh();
    error TokenNotSet();

    constructor(address owner_, address hub_, address burner_, uint16 feeBps_) ERC1155("") Ownable(owner_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        hub = IAgentHub(hub_);
        burner = IBurner(burner_);
        feeBps = feeBps_;
    }

    /// @notice The currency of the licenses: the project token, or the zero address while it does not exist yet.
    function payToken() public view returns (address) {
        return burner.burnToken();
    }

    /// @notice The token id of an agent's license.
    function idOf(address vault) public pure returns (uint256) {
        return uint256(uint160(vault));
    }

    function hasLicense(address account, address vault) external view returns (bool) {
        return balanceOf(account, idOf(vault)) > 0;
    }

    /// @notice The owner of `vault` puts the agent's license on sale (or changes, or closes, the sale).
    /// @param maxSupply how many licenses may ever be sold, 0 = no limit; it cannot go below what is already sold
    function setSeries(address vault, uint128 price, uint32 maxSupply, bool open) external {
        if (!hub.isVault(vault)) revert NotAVault();
        if (IAgentVault(vault).owner() != msg.sender) revert NotVaultOwner();
        Series storage s = series[vault];
        if (open && price == 0) revert BadSeries();
        if (maxSupply != 0 && maxSupply < s.sold) revert BadSeries();
        s.seller = msg.sender;
        s.price = price;
        s.maxSupply = maxSupply;
        s.open = open;
        emit SeriesSet(vault, msg.sender, price, maxSupply, open);
    }

    /// @notice Buy one license of an agent. The buyer approves the project token for the price first.
    function buy(address vault) external nonReentrant {
        address token = payToken();
        if (token == address(0)) revert TokenNotSet();
        Series storage s = series[vault];
        if (!s.open) revert NotForSale();
        if (s.maxSupply != 0 && s.sold >= s.maxSupply) revert SoldOut();
        uint256 id = idOf(vault);
        if (balanceOf(msg.sender, id) > 0) revert AlreadyLicensed();

        s.sold += 1;
        uint256 price = s.price;
        uint256 fee = (price * feeBps) / BPS;
        address seller = s.seller;
        if (fee > 0) IERC20(token).safeTransferFrom(msg.sender, address(burner), fee); // the burner burns what it holds (burnHeld)
        IERC20(token).safeTransferFrom(msg.sender, seller, price - fee);
        _mint(msg.sender, id, 1, "");
        emit Licensed(vault, msg.sender, seller, price, fee);
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @notice Where wallets and markets find the metadata of a license (optional).
    function setURI(string calldata uri_) external onlyOwner {
        _setURI(uri_);
    }
}
