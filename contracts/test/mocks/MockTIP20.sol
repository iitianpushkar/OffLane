// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test double for a TIP-20 token: standard ERC-20 semantics, but
/// hardcoded to 6 decimals like real TIP-20 tokens on Tempo. Also simulates
/// the *symptom* of TIP-403 receive-policy blocking on `transfer`: if `to`
/// is marked `blocked`, the call still returns `true` (matching the real
/// protocol behavior — see src/interfaces/IReceivePolicyGuard.sol) but the
/// funds land at the real ReceivePolicyGuard address instead of `to`.
///
/// This does NOT call into ReceivePolicyGuard's real `claim`/`balanceOf` —
/// Foundry's `tempo = true` test EVM emulates that precompile for real (see
/// ChannelManager.t.sol), and it only understands genuine receipts created
/// by a real TIP-403-policy-respecting TIP-20 token, which this mock isn't.
/// This mock is only good for testing ChannelManager's *detection* of a
/// redirected payout (balance-delta check in `_payout`), not a full
/// block-then-claim round trip — that needs a live Tempo network.
contract MockTIP20 is ERC20 {
    address internal constant GUARD = 0xB10C000000000000000000000000000000000000;

    mapping(address => bool) public blocked;

    constructor() ERC20("Mock pathUSD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) {
            _transfer(msg.sender, GUARD, amount);
            return true;
        }

        return super.transfer(to, amount);
    }
}
