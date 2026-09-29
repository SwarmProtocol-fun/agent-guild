// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SwarmTaskBoardLink
 * @notice Task board on Ethereum Sepolia using LINK ERC-20 for payments.
 *         Mirrors the Hedera TaskBoard but replaces native msg.value with
 *         LINK token approve() + transferFrom() pattern.
 */
contract SwarmTaskBoardLink is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable linkToken;

    enum TaskStatus { Open, Claimed, Completed, Expired, Disputed }

    struct Task {
        uint256 taskId;
        address vault;
        string title;
        string description;
        string requiredSkills;
        uint256 deadline;
        uint256 budget;
        address poster;
        address claimedBy;
        bytes32 deliveryHash;
        uint256 createdAt;
        uint8 status;
    }

    Task[] public tasks;

    event TaskPosted(uint256 indexed taskId, address indexed poster, address vault, string title, uint256 budget, uint256 deadline, uint256 timestamp);
    event TaskClaimed(uint256 indexed taskId, address indexed agent, uint256 timestamp);
    event DeliverySubmitted(uint256 indexed taskId, address indexed agent, bytes32 deliveryHash, uint256 timestamp);
    event DeliveryApproved(uint256 indexed taskId, address indexed agent, uint256 payout, uint256 timestamp);
    event DeliveryDisputed(uint256 indexed taskId, address indexed poster, uint256 timestamp);

    constructor(address _linkToken) Ownable(msg.sender) {
        require(_linkToken != address(0), "Invalid LINK address");
        linkToken = IERC20(_linkToken);
    }

    /**
     * @notice Post a new task. Caller must approve() LINK first.
     * @param vault The vault address associated with the task
     * @param title Task title
     * @param description Task description
     * @param requiredSkills Comma-separated required skills
     * @param deadline Unix timestamp deadline
     * @param budgetLink Budget in LINK (18 decimals)
     */
    function postTask(
        address vault,
        string calldata title,
        string calldata description,
        string calldata requiredSkills,
        uint256 deadline,
        uint256 budgetLink
    ) external {
        require(budgetLink > 0, "Budget must be > 0");
        require(deadline > block.timestamp, "Deadline must be in the future");

        linkToken.safeTransferFrom(msg.sender, address(this), budgetLink);

        uint256 taskId = tasks.length;
        tasks.push(Task({
            taskId: taskId,
            vault: vault,
            title: title,
            description: description,
            requiredSkills: requiredSkills,
            deadline: deadline,
            budget: budgetLink,
            poster: msg.sender,
            claimedBy: address(0),
            deliveryHash: bytes32(0),
            createdAt: block.timestamp,
            status: uint8(TaskStatus.Open)
        }));

        emit TaskPosted(taskId, msg.sender, vault, title, budgetLink, deadline, block.timestamp);
    }

    function claimTask(uint256 taskId) external {
        require(taskId < tasks.length, "Invalid task");
        Task storage task = tasks[taskId];
        require(task.status == uint8(TaskStatus.Open), "Not open");
        require(task.deadline > block.timestamp, "Expired");
        require(task.poster != msg.sender, "Cannot claim own task");

        task.claimedBy = msg.sender;
        task.status = uint8(TaskStatus.Claimed);

        emit TaskClaimed(taskId, msg.sender, block.timestamp);
    }

    function submitDelivery(uint256 taskId, bytes32 deliveryHash) external {
        require(taskId < tasks.length, "Invalid task");
        Task storage task = tasks[taskId];
        require(task.status == uint8(TaskStatus.Claimed), "Not claimed");
        require(task.claimedBy == msg.sender, "Not assigned agent");

        task.deliveryHash = deliveryHash;

        emit DeliverySubmitted(taskId, msg.sender, deliveryHash, block.timestamp);
    }

    function approveDelivery(uint256 taskId) external {
        require(taskId < tasks.length, "Invalid task");
        Task storage task = tasks[taskId];
        require(task.status == uint8(TaskStatus.Claimed), "Not claimed");
        require(task.poster == msg.sender, "Only poster can approve");
        require(task.deliveryHash != bytes32(0), "No delivery submitted");

        task.status = uint8(TaskStatus.Completed);

        linkToken.safeTransfer(task.claimedBy, task.budget);

        emit DeliveryApproved(taskId, task.claimedBy, task.budget, block.timestamp);
    }

    function disputeDelivery(uint256 taskId) external {
        require(taskId < tasks.length, "Invalid task");
        Task storage task = tasks[taskId];
        require(task.status == uint8(TaskStatus.Claimed), "Not claimed");
        require(task.poster == msg.sender, "Only poster can dispute");

        task.status = uint8(TaskStatus.Disputed);

        emit DeliveryDisputed(taskId, msg.sender, block.timestamp);
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        require(taskId < tasks.length, "Invalid task");
        return tasks[taskId];
    }

    function getAllTasks() external view returns (Task[] memory) {
        return tasks;
    }

    function getOpenTasks() external view returns (Task[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < tasks.length; i++) {
            if (tasks[i].status == uint8(TaskStatus.Open) && tasks[i].deadline > block.timestamp) {
                count++;
            }
        }

        Task[] memory result = new Task[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < tasks.length; i++) {
            if (tasks[i].status == uint8(TaskStatus.Open) && tasks[i].deadline > block.timestamp) {
                result[idx++] = tasks[i];
            }
        }
        return result;
    }

    function taskCount() external view returns (uint256) {
        return tasks.length;
    }
}
