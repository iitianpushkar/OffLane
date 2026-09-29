// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test double for a TIP-20 token: standard ERC-20 semantics, but
/// hardcoded to 6 decimals like real TIP-20 tokens on Tempo.
contract MockTIP20 is ERC20 {
    constructor() ERC20("Mock pathUSD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
