// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Tempo's Account Keychain precompile
/// (https://docs.tempo.xyz/developers/docs/protocol/transactions/AccountKeychain),
/// fixed system address. Lets an account's root key delegate a scoped
/// "access key" with a real expiry and revocation, managed entirely by
/// Tempo's protocol rather than by this contract.
///
/// Only the read surface is declared here — ChannelManager only ever
/// *queries* whether a signer is a currently-active access key of a channel
/// participant (`getKey`); provisioning/revoking keys is something
/// participants do directly against this precompile from their own wallet,
/// entirely outside this contract.
interface IAccountKeychain {
    enum SignatureType {
        Secp256k1,
        P256,
        WebAuthn
    }

    struct KeyInfo {
        SignatureType signatureType;
        address keyId;
        uint64 expiry;
        bool enforceLimits;
        bool isRevoked;
    }

    function getKey(address account, address keyId) external view returns (KeyInfo memory);
}
