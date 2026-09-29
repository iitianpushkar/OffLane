// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Tempo's TIP-1020 signature-verification precompile
/// (https://tips.sh/1020), deployed at a fixed system address. Verifies
/// secp256k1, P256, and WebAuthn signatures — so channel participants can
/// sign states with a passkey/Tempo Wallet, not just a raw private key —
/// without this contract needing its own verification logic per scheme.
/// `recover`/`verify` both revert on a malformed signature; only `verify`
/// returns `false` (rather than reverting) for a well-formed signature from
/// the wrong signer.
interface ITempoSignatureVerifier {
    error InvalidFormat();
    error InvalidSignature();

    function recover(bytes32 hash, bytes calldata signature) external view returns (address signer);
    function verify(address signer, bytes32 hash, bytes calldata signature) external view returns (bool);
}
