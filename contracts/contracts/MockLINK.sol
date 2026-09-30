// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockLINK
 * @notice Mock LINK token for testing/demo purposes on EVM testnets
 */
contract MockLINK is ERC20 {
    constructor() ERC20("Chainlink Token", "LINK") {
        // Mint 1 million LINK to deployer for testing
        _mint(msg.sender, 1_000_000 * 10**18);
    }

    /**
     * @notice Mint new tokens (for testing only)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
