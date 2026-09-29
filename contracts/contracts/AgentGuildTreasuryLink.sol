// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SwarmTreasuryLink
 * @notice Treasury contract tracking LINK token balances.
 *         Mirrors the Hedera AgentTreasury but uses LINK ERC-20.
 *         Revenue is split into compute, growth, and reserve buckets.
 */
contract SwarmTreasuryLink is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable linkToken;

    uint256 public totalRevenue;
    uint256 public computeBalance;
    uint256 public growthBalance;
    uint256 public reserveBalance;
    address public agentAddress;

    // Revenue split: 50% compute, 30% growth, 20% reserve
    uint256 public constant COMPUTE_BPS = 5000;
    uint256 public constant GROWTH_BPS = 3000;
    uint256 public constant RESERVE_BPS = 2000;

    event RevenueDeposited(address indexed from, uint256 amount, uint256 timestamp);
    event Withdrawn(address indexed to, uint256 amount, uint256 timestamp);
    event AgentAddressUpdated(address indexed newAgent, uint256 timestamp);

    constructor(address _linkToken) Ownable(msg.sender) {
        require(_linkToken != address(0), "Invalid LINK address");
        linkToken = IERC20(_linkToken);
    }

    function setAgentAddress(address _agentAddress) external onlyOwner {
        agentAddress = _agentAddress;
        emit AgentAddressUpdated(_agentAddress, block.timestamp);
    }

    /**
     * @notice Deposit LINK revenue. Caller must approve() first.
     * @param amount Amount of LINK to deposit (18 decimals)
     */
    function depositRevenue(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");

        linkToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 computeShare = (amount * COMPUTE_BPS) / 10000;
        uint256 growthShare = (amount * GROWTH_BPS) / 10000;
        uint256 reserveShare = amount - computeShare - growthShare;

        totalRevenue += amount;
        computeBalance += computeShare;
        growthBalance += growthShare;
        reserveBalance += reserveShare;

        emit RevenueDeposited(msg.sender, amount, block.timestamp);
    }

    function getPnL() external view returns (
        uint256 _totalRevenue,
        uint256 _computeBalance,
        uint256 _growthBalance,
        uint256 _reserveBalance
    ) {
        return (totalRevenue, computeBalance, growthBalance, reserveBalance);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid address");
        uint256 contractBalance = linkToken.balanceOf(address(this));
        require(amount <= contractBalance, "Insufficient balance");

        linkToken.safeTransfer(to, amount);

        emit Withdrawn(to, amount, block.timestamp);
    }
}
