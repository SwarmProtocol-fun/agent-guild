// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title SwarmAgentIdentityNFT
 * @notice Dynamic NFT representing agent identity and reputation on Swarm Protocol
 *
 * Features:
 * - One NFT per agent address (soulbound to agent wallet)
 * - Dynamic metadata that updates with credit score changes
 * - Immutable ASN (Agent Social Number) identifier
 * - Visual badge tier (Bronze/Silver/Gold/Platinum)
 * - On-chain verification of agent reputation
 *
 * For Hedera Hackathon 2026 — AI & Agents Track + OpenClaw Bounty
 */
contract SwarmAgentIdentityNFT is ERC721, Ownable {
    using Strings for uint256;

    // ══════════════════════════════════════════════════════════════════════
    // Storage
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Base URI for metadata API (points to Swarm backend)
    string public baseURI;

    /// @notice Counter for token IDs
    uint256 private _tokenIdCounter;

    /// @notice Mapping from agent address to token ID
    mapping(address => uint256) public agentToTokenId;

    /// @notice Mapping from token ID to agent address
    mapping(uint256 => address) public tokenIdToAgent;

    /// @notice Mapping from token ID to agent data
    mapping(uint256 => AgentIdentity) public agentIdentities;

    /// @notice Agent identity stored on-chain
    struct AgentIdentity {
        string asn;              // Immutable ASN identifier
        uint16 creditScore;      // 300-900 credit score
        uint8 trustScore;        // 0-100 trust score
        uint256 registeredAt;    // Registration timestamp
        uint256 lastUpdated;     // Last metadata update
    }

    // ══════════════════════════════════════════════════════════════════════
    // Events
    // ══════════════════════════════════════════════════════════════════════

    event AgentNFTMinted(address indexed agent, uint256 indexed tokenId, string asn, uint256 timestamp);
    event ReputationUpdated(uint256 indexed tokenId, uint16 creditScore, uint8 trustScore, uint256 timestamp);
    event BaseURIUpdated(string newBaseURI, uint256 timestamp);

    // ══════════════════════════════════════════════════════════════════════
    // Constructor
    // ══════════════════════════════════════════════════════════════════════

    constructor(string memory initialBaseURI) ERC721("Swarm Agent Identity", "SWARM-AGENT") Ownable(msg.sender) {
        baseURI = initialBaseURI;
        _tokenIdCounter = 1; // Start token IDs at 1
    }

    // ══════════════════════════════════════════════════════════════════════
    // Core Functions
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @notice Mint agent identity NFT (called by AgentRegistry on registration)
     * @param agent Agent wallet address
     * @param asn Unique Agent Social Number
     * @param initialCreditScore Starting credit score (default: 680)
     * @param initialTrustScore Starting trust score (default: 50)
     */
    function mintAgentNFT(
        address agent,
        string memory asn,
        uint16 initialCreditScore,
        uint8 initialTrustScore
    ) external onlyOwner returns (uint256) {
        require(agent != address(0), "Invalid agent address");
        require(agentToTokenId[agent] == 0, "Agent already has NFT");
        require(bytes(asn).length > 0, "ASN required");

        uint256 tokenId = _tokenIdCounter++;

        // Mint NFT to agent
        _safeMint(agent, tokenId);

        // Store mappings
        agentToTokenId[agent] = tokenId;
        tokenIdToAgent[tokenId] = agent;

        // Store identity data
        agentIdentities[tokenId] = AgentIdentity({
            asn: asn,
            creditScore: initialCreditScore,
            trustScore: initialTrustScore,
            registeredAt: block.timestamp,
            lastUpdated: block.timestamp
        });

        emit AgentNFTMinted(agent, tokenId, asn, block.timestamp);
        return tokenId;
    }

    /**
     * @notice Update agent reputation scores (triggers metadata refresh)
     * @param agent Agent address
     * @param newCreditScore Updated credit score (300-900)
     * @param newTrustScore Updated trust score (0-100)
     */
    function updateReputation(
        address agent,
        uint16 newCreditScore,
        uint8 newTrustScore
    ) external onlyOwner {
        uint256 tokenId = agentToTokenId[agent];
        require(tokenId != 0, "Agent has no NFT");
        require(newCreditScore >= 300 && newCreditScore <= 900, "Invalid credit score");
        require(newTrustScore <= 100, "Invalid trust score");

        AgentIdentity storage identity = agentIdentities[tokenId];
        identity.creditScore = newCreditScore;
        identity.trustScore = newTrustScore;
        identity.lastUpdated = block.timestamp;

        emit ReputationUpdated(tokenId, newCreditScore, newTrustScore, block.timestamp);
    }

    /**
     * @notice Batch update multiple agents' reputations (gas-efficient)
     * @param agents Array of agent addresses
     * @param creditScores Array of credit scores
     * @param trustScores Array of trust scores
     */
    function batchUpdateReputation(
        address[] calldata agents,
        uint16[] calldata creditScores,
        uint8[] calldata trustScores
    ) external onlyOwner {
        require(agents.length == creditScores.length, "Array length mismatch");
        require(agents.length == trustScores.length, "Array length mismatch");

        for (uint256 i = 0; i < agents.length; i++) {
            uint256 tokenId = agentToTokenId[agents[i]];
            if (tokenId != 0) {
                AgentIdentity storage identity = agentIdentities[tokenId];
                identity.creditScore = creditScores[i];
                identity.trustScore = trustScores[i];
                identity.lastUpdated = block.timestamp;

                emit ReputationUpdated(tokenId, creditScores[i], trustScores[i], block.timestamp);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // View Functions
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get token ID for an agent
     */
    function getTokenId(address agent) external view returns (uint256) {
        return agentToTokenId[agent];
    }

    /**
     * @notice Get full agent identity data
     */
    function getAgentIdentity(uint256 tokenId) external view returns (AgentIdentity memory) {
        require(tokenIdToAgent[tokenId] != address(0), "Token does not exist");
        return agentIdentities[tokenId];
    }

    /**
     * @notice Check if agent has minted NFT
     */
    function hasNFT(address agent) external view returns (bool) {
        return agentToTokenId[agent] != 0;
    }

    /**
     * @notice Get reputation tier for display (Bronze/Silver/Gold/Platinum)
     */
    function getReputationTier(uint256 tokenId) external view returns (string memory) {
        AgentIdentity memory identity = agentIdentities[tokenId];
        if (identity.creditScore >= 850) return "Platinum";
        if (identity.creditScore >= 700) return "Gold";
        if (identity.creditScore >= 550) return "Silver";
        return "Bronze";
    }

    // ══════════════════════════════════════════════════════════════════════
    // Metadata (ERC721)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @notice Returns dynamic metadata URI
     * @dev Points to Swarm API which returns real-time credit score data
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(tokenIdToAgent[tokenId] != address(0), "Token does not exist");

        // Return API endpoint that generates dynamic metadata
        // Format: https://swarmprotocol.fun/api/nft/agent/{agentAddress}/metadata.json
        address agent = tokenIdToAgent[tokenId];
        return string(abi.encodePacked(
            baseURI,
            "/",
            Strings.toHexString(uint160(agent), 20)
        ));
    }

    /**
     * @notice Update base URI for metadata (admin only)
     */
    function setBaseURI(string memory newBaseURI) external onlyOwner {
        baseURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI, block.timestamp);
    }

    /**
     * @notice Returns base URI
     */
    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Transfer Restrictions (Soulbound-like behavior)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @notice Override transfer to prevent NFT trading (reputation is non-transferable)
     * @dev Allows initial mint and admin recovery, but blocks user-to-user transfers
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Allow minting (from == address(0))
        if (from == address(0)) {
            return super._update(to, tokenId, auth);
        }

        // Allow admin burns/recovery (to == address(0) or owner is calling)
        if (to == address(0) || auth == owner()) {
            return super._update(to, tokenId, auth);
        }

        // Block all user-to-user transfers (soulbound to agent wallet)
        revert("SwarmAgentIdentityNFT: non-transferable");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Admin Recovery (in case agent loses wallet access)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency recovery: transfer NFT to new agent wallet
     * @dev Only owner can call, for wallet recovery scenarios
     */
    function emergencyTransfer(uint256 tokenId, address newAgent) external onlyOwner {
        require(newAgent != address(0), "Invalid new agent");
        require(agentToTokenId[newAgent] == 0, "New agent already has NFT");

        address oldAgent = tokenIdToAgent[tokenId];
        require(oldAgent != address(0), "Token does not exist");

        // Update mappings
        delete agentToTokenId[oldAgent];
        agentToTokenId[newAgent] = tokenId;
        tokenIdToAgent[tokenId] = newAgent;

        // Transfer NFT
        _transfer(oldAgent, newAgent, tokenId);
    }
}
