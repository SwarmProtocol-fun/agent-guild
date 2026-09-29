// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SwarmASNRegistry
 * @notice On-chain Agent Social Number (ASN) identity + credit registry.
 *         Stores ASN records, credit scores, and task completion history.
 *         Format: ASN-SWM-YYYY-HHHH-HHHH-CC
 */
contract SwarmASNRegistry is Ownable {
    struct ASNRecord {
        string asn;
        address owner;
        string agentName;
        string agentType;
        uint16 creditScore;
        uint8 trustScore;
        uint256 tasksCompleted;
        uint256 totalVolumeWei;
        uint256 registeredAt;
        uint256 lastActive;
        bool active;
    }

    mapping(string => ASNRecord) public records;
    mapping(address => string) public ownerToASN;
    string[] public allASNs;

    event ASNRegistered(string asn, address indexed owner, string agentName, uint256 timestamp);
    event CreditUpdated(string asn, uint16 creditScore, uint8 trustScore, uint256 timestamp);
    event TaskCompleted(string asn, uint256 newTotal, uint256 volume, uint256 timestamp);

    constructor() Ownable(msg.sender) {}

    function registerASN(
        string calldata asn,
        string calldata agentName,
        string calldata agentType
    ) external {
        require(bytes(asn).length > 0, "ASN required");
        require(records[asn].owner == address(0), "ASN already registered");
        require(bytes(ownerToASN[msg.sender]).length == 0, "Address already has ASN");

        records[asn] = ASNRecord({
            asn: asn,
            owner: msg.sender,
            agentName: agentName,
            agentType: agentType,
            creditScore: 680,
            trustScore: 50,
            tasksCompleted: 0,
            totalVolumeWei: 0,
            registeredAt: block.timestamp,
            lastActive: block.timestamp,
            active: true
        });

        ownerToASN[msg.sender] = asn;
        allASNs.push(asn);

        emit ASNRegistered(asn, msg.sender, agentName, block.timestamp);
    }

    function registerASNFor(
        address owner,
        string calldata asn,
        string calldata agentName,
        string calldata agentType
    ) external onlyOwner {
        require(bytes(asn).length > 0, "ASN required");
        require(records[asn].owner == address(0), "ASN already registered");
        require(bytes(ownerToASN[owner]).length == 0, "Address already has ASN");

        records[asn] = ASNRecord({
            asn: asn,
            owner: owner,
            agentName: agentName,
            agentType: agentType,
            creditScore: 680,
            trustScore: 50,
            tasksCompleted: 0,
            totalVolumeWei: 0,
            registeredAt: block.timestamp,
            lastActive: block.timestamp,
            active: true
        });

        ownerToASN[owner] = asn;
        allASNs.push(asn);

        emit ASNRegistered(asn, owner, agentName, block.timestamp);
    }

    function updateCredit(
        string calldata asn,
        uint16 creditScore,
        uint8 trustScore
    ) external onlyOwner {
        require(records[asn].active, "ASN not active");
        require(creditScore >= 300 && creditScore <= 900, "Credit 300-900");
        require(trustScore <= 100, "Trust 0-100");

        records[asn].creditScore = creditScore;
        records[asn].trustScore = trustScore;
        records[asn].lastActive = block.timestamp;

        emit CreditUpdated(asn, creditScore, trustScore, block.timestamp);
    }

    function recordTaskCompletion(
        string calldata asn,
        uint256 volumeWei
    ) external onlyOwner {
        require(records[asn].active, "ASN not active");

        records[asn].tasksCompleted += 1;
        records[asn].totalVolumeWei += volumeWei;
        records[asn].lastActive = block.timestamp;

        emit TaskCompleted(asn, records[asn].tasksCompleted, volumeWei, block.timestamp);
    }

    function getRecord(string calldata asn) external view returns (ASNRecord memory) {
        return records[asn];
    }

    function getRecordByOwner(address owner) external view returns (ASNRecord memory) {
        string memory asn = ownerToASN[owner];
        require(bytes(asn).length > 0, "No ASN for address");
        return records[asn];
    }

    function totalRecords() external view returns (uint256) {
        return allASNs.length;
    }

    function getAllRecords() external view returns (ASNRecord[] memory) {
        ASNRecord[] memory result = new ASNRecord[](allASNs.length);
        for (uint256 i = 0; i < allASNs.length; i++) {
            result[i] = records[allASNs[i]];
        }
        return result;
    }
}
