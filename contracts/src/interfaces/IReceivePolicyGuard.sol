// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Tempo's ReceivePolicyGuard (TIP-1028, https://tips.sh/1028),
/// deployed at a fixed system address. When a TIP-403 receive policy blocks
/// an inbound TIP-20 transfer, the transfer call still succeeds, but the
/// funds land here instead of the intended recipient, keyed by a
/// `ClaimReceiptV1` witness. The authorized claimer (the receiver's
/// configured recovery authority, or the transfer's `originator` if none is
/// set) can later call `claim` to release the funds — see
/// ChannelManager.rescueBlockedPayout.
interface IReceivePolicyGuard {
    enum InboundKind {
        TRANSFER,
        MINT
    }

    enum BlockedReason {
        NONE,
        TOKEN_FILTER,
        RECEIVE_POLICY
    }

    struct ClaimReceiptV1 {
        uint8 version;
        address token;
        address recoveryAuthority;
        address originator;
        address recipient;
        uint64 blockedAt;
        uint64 blockedNonce;
        BlockedReason blockedReason;
        InboundKind kind;
        bytes32 memo;
    }

    function balanceOf(bytes calldata receipt) external view returns (uint256 amount);
    function claim(address to, bytes calldata receipt) external;
    function burnBlockedReceipt(bytes calldata receipt) external;
}
