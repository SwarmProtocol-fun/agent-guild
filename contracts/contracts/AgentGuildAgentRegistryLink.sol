// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SwarmAgentRegistryLink
 * @notice Agent registry on Ethereum Sepolia with ASN identity and credit scoring.
 *         Mirrors the Hedera AgentRegistry but adds on-chain ASN + credit fields.
 */
contract SwarmAgentRegistryLink is Ownable {
    struct Agent {
        address agentAddress;
        string name;
        string skills;
        string asn;
        uint256 feeRate;
        uint16 creditScore;
        uint8 trustScore;
        bool active;
        uint256 registeredAt;
    }

    mapping(address => Agent) public agents;
    address[] public agentList;
    mapping(string => address) public asnToAgent;

    event AgentRegistered(address indexed agentAddress, string name, string asn, uint256 timestamp);
    event AgentDeactivated(address indexed agentAddress, uint256 timestamp);
    event SkillsUpdated(address indexed agentAddress, string newSkills, uint256 timestamp);
    event CreditUpdated(address indexed agentAddress, uint16 creditScore, uint8 trustScore, uint256 timestamp);

    constructor() Ownable(msg.sender) {}

    function registerAgent(
        string calldata name,
        string calldata skills,
        string calldata asn,
        uint256 feeRate
    ) external {
        require(!agents[msg.sender].active, "Already registered");
        require(bytes(asn).length > 0, "ASN required");
        require(asnToAgent[asn] == address(0), "ASN already taken");

        agents[msg.sender] = Agent({
            agentAddress: msg.sender,
            name: name,
            skills: skills,
            asn: asn,
            feeRate: feeRate,
            creditScore: 680,
            trustScore: 50,
            active: true,
            registeredAt: block.timestamp
        });

        agentList.push(msg.sender);
        asnToAgent[asn] = msg.sender;

        emit AgentRegistered(msg.sender, name, asn, block.timestamp);
    }

    function registerAgentFor(
        address agentAddr,
        string calldata name,
        string calldata skills,
        string calldata asn,
        uint256 feeRate
    ) external onlyOwner {
        require(!agents[agentAddr].active, "Already registered");
        require(bytes(asn).length > 0, "ASN required");
        require(asnToAgent[asn] == address(0), "ASN already taken");

        agents[agentAddr] = Agent({
            agentAddress: agentAddr,
            name: name,
            skills: skills,
            asn: asn,
            feeRate: feeRate,
            creditScore: 680,
            trustScore: 50,
            active: true,
            registeredAt: block.timestamp
        });

        agentList.push(agentAddr);
        asnToAgent[asn] = agentAddr;

        emit AgentRegistered(agentAddr, name, asn, block.timestamp);
    }

    function updateSkills(string calldata newSkills) external {
        require(agents[msg.sender].active, "Not registered");
        agents[msg.sender].skills = newSkills;
        emit SkillsUpdated(msg.sender, newSkills, block.timestamp);
    }

    function updateCredit(
        address agentAddr,
        uint16 creditScore,
        uint8 trustScore
    ) external onlyOwner {
        require(agents[agentAddr].active, "Not registered");
        require(creditScore >= 300 && creditScore <= 900, "Credit 300-900");
        require(trustScore <= 100, "Trust 0-100");

        agents[agentAddr].creditScore = creditScore;
        agents[agentAddr].trustScore = trustScore;

        emit CreditUpdated(agentAddr, creditScore, trustScore, block.timestamp);
    }

    function deactivateAgent() external {
        require(agents[msg.sender].active, "Not registered");
        agents[msg.sender].active = false;
        emit AgentDeactivated(msg.sender, block.timestamp);
    }

    function getAgent(address agentAddr) external view returns (Agent memory) {
        return agents[agentAddr];
    }

    function getAgentByASN(string calldata asn) external view returns (Agent memory) {
        address addr = asnToAgent[asn];
        require(addr != address(0), "ASN not found");
        return agents[addr];
    }

    function isRegistered(address agentAddr) external view returns (bool) {
        return agents[agentAddr].active;
    }

    function agentCount() external view returns (uint256) {
        return agentList.length;
    }

    function getAllAgents() external view returns (Agent[] memory) {
        Agent[] memory result = new Agent[](agentList.length);
        for (uint256 i = 0; i < agentList.length; i++) {
            result[i] = agents[agentList[i]];
        }
        return result;
    }
}
