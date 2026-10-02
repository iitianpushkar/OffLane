// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITIP20} from "./interfaces/ITIP20.sol";
import {ITempoSignatureVerifier} from "./interfaces/ITempoSignatureVerifier.sol";
import {IReceivePolicyGuard} from "./interfaces/IReceivePolicyGuard.sol";

/// @title ChannelManager
/// @notice Two-party, bidirectional, collateralized state-channel contract for
/// the Tempo off-chain payment network (see ../DESIGN.md and
/// ../../Tempo Off-Chain Payment & Encrypted Messaging Network — Technical
/// Architecture.pdf). Tempo smart contracts — not the relay — hold channel
/// collateral and enforce settlement; the relay only transports signed state.
///
/// @dev Design notes (see ../DESIGN.md for the full reasoning):
/// - No native gas token on Tempo: all collateral moves via TIP-20
///   `transferFrom`/`transfer`, never `msg.value`. There are no `payable`
///   functions in this contract.
/// - Storage is expensive on Tempo (~250,000 gas per new 32-byte slot vs
///   ~20,000 on Ethereum), so `Channel` is packed into 4 slots. See the
///   field-by-field slot comments below.
/// - `ChannelIntent` (the open/join agreement) is never stored on-chain in
///   full — only its EIP-712 struct hash (via `channelId`) and the derived
///   `Channel` accounting fields are. Any function that needs the full
///   intent again (`joinChannel`, `cancelUnjoined`) takes it as calldata and
///   re-derives `channelId` from it; a forged intent simply fails to match
///   any stored channel, so this is safe without storing the intent twice.
/// - Every balance-changing action (`cooperativeClose`, `initiateClose`,
///   `challenge`) requires BOTH participants' signatures over a
///   `ChannelState`. There is no single-signer unilateral claim: a
///   "challenge" is just presenting a strictly newer, still mutually-signed
///   state than the one used to start the close. This is simpler than a
///   single-challenger-signature scheme because every valid state was
///   agreed by both parties at the moment it was signed off-chain.
/// - Channel intents require direct participant signatures because an
///   account-wide delegate must not be able to choose an arbitrary deposit.
///   Automated state signing uses a root-signed `ChannelCapability` that
///   binds one delegate to one channel, peer, token, baseline balance and
///   maximum net spend. The capability is supplied only during enforcement,
///   so it costs no per-channel storage. It deliberately remains valid as
///   settlement evidence after the key is expired or revoked elsewhere:
///   otherwise revocation could destroy a participant's ability to enforce
///   an honestly signed earlier state.
contract ChannelManager is EIP712, ReentrancyGuard {
    // =========================================================================
    //                                Constants
    // =========================================================================

    uint8 public constant PROTOCOL_VERSION = 1;
    uint32 public constant MIN_CHALLENGE_DURATION = 1 hours;
    uint32 public constant MAX_CHALLENGE_DURATION = 30 days;

    /// @dev Tempo's TIP-1020 signature-verification precompile (https://tips.sh/1020).
    ITempoSignatureVerifier internal constant SIGNATURE_VERIFIER =
        ITempoSignatureVerifier(0x5165300000000000000000000000000000000000);

    /// @dev Tempo's ReceivePolicyGuard (https://tips.sh/1028), fixed system address.
    IReceivePolicyGuard internal constant RECEIVE_POLICY_GUARD =
        IReceivePolicyGuard(0xB10C000000000000000000000000000000000000);

    bytes32 private constant CHANNEL_INTENT_TYPEHASH = keccak256(
        "ChannelIntent(uint8 protocolVersion,address participantA,address participantB,address token,uint128 depositA,uint128 depositB,uint32 challengeDuration,uint32 validUntil,uint256 salt)"
    );

    bytes32 private constant CHANNEL_STATE_TYPEHASH =
        keccak256("ChannelState(bytes32 channelId,uint64 nonce,uint128 balanceA,uint128 balanceB,bytes32 appDataHash)");

    bytes32 private constant CHANNEL_CAPABILITY_TYPEHASH = keccak256(
        "ChannelCapability(uint8 protocolVersion,bytes32 channelId,address participant,address delegatedSigner,address counterparty,address token,uint128 baselineBalance,uint128 maxNetSpend,uint256 capabilityNonce)"
    );

    // =========================================================================
    //                                  Types
    // =========================================================================

    enum Status {
        VOID, // no channel at this id
        PENDING, // opened by A, awaiting B's join
        OPEN, // fully funded, off-chain payments happening
        CLOSING // unilateral close initiated, challenge window running
    }

    /// @notice Off-chain agreement both participants sign before any deposit.
    /// Never stored on-chain in full — see contract-level dev note.
    struct ChannelIntent {
        uint8 protocolVersion;
        address participantA;
        address participantB;
        address token; // TIP-20 collateral token
        uint128 depositA;
        uint128 depositB;
        uint32 challengeDuration; // seconds
        uint32 validUntil; // unix timestamp; join/open must happen before this
        uint256 salt; // uniqueness, so identical-parameter channels don't collide
    }

    /// @notice A signed off-chain (or on-chain close/challenge) balance state.
    /// `chainId`/`verifyingContract` from the architecture spec are enforced
    /// via the EIP-712 domain separator instead of being duplicated as
    /// fields here.
    struct ChannelState {
        bytes32 channelId;
        uint64 nonce; // strictly increasing per channel
        uint128 balanceA;
        uint128 balanceB;
        bytes32 appDataHash; // opaque hash binding e.g. an encrypted message reference
    }

    /// @notice Root-signed authority for an automated key to sign states for
    /// one participant in one channel. `maxNetSpend` limits how far the
    /// participant's enforced balance may fall below `baselineBalance`.
    struct ChannelCapability {
        uint8 protocolVersion;
        bytes32 channelId;
        address participant;
        address delegatedSigner;
        address counterparty;
        address token;
        uint128 baselineBalance;
        uint128 maxNetSpend;
        uint256 capabilityNonce;
    }

    /// @notice State signature plus optional root-signed capability. An empty
    /// `capabilitySignature` means `stateSignature` must be from the participant
    /// account itself. A non-empty one enables the constrained delegate path.
    struct StateAuthorization {
        bytes stateSignature;
        ChannelCapability capability;
        bytes capabilitySignature;
    }

    /// @dev Packed into 4 storage slots (32 bytes each):
    ///   slot0: participantA(20) + challengeDuration(4) + status(1) + validUntil(4)
    ///   slot1: participantB(20) + nonce(8)
    ///   slot2: token(20) + challengeExpireAt(8)
    ///   slot3: balanceA(16) + balanceB(16)
    struct Channel {
        address participantA;
        uint32 challengeDuration;
        Status status;
        uint32 validUntil;
        address participantB;
        uint64 nonce;
        address token;
        uint64 challengeExpireAt;
        uint128 balanceA;
        uint128 balanceB;
    }

    // =========================================================================
    //                                 Storage
    // =========================================================================

    mapping(bytes32 channelId => Channel) private _channels;

    /// @dev Permanent replay protection for signed channel intents. `_channels`
    /// is deleted when a channel settles or is cancelled, so checking its
    /// status alone would allow the same still-valid intent and signature to
    /// reopen the same channel and pull a fresh deposit from an outstanding
    /// token allowance.
    mapping(bytes32 channelId => bool) private _usedChannelIds;

    /// @dev Tracks payouts that a TIP-403 receive policy redirected to
    /// ReceivePolicyGuard instead of delivering, so they're never silently
    /// lost. Cleared once `rescueBlockedPayout` successfully claims them.
    /// Survives channel deletion — keyed independently of `_channels`.
    mapping(bytes32 channelId => mapping(address participant => uint128 amount)) private _blockedPayouts;

    // =========================================================================
    //                                 Events
    // =========================================================================

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed participantA,
        address indexed participantB,
        address token,
        uint128 depositA,
        uint128 depositB,
        uint32 challengeDuration,
        uint32 validUntil
    );
    event ChannelJoined(bytes32 indexed channelId, uint128 depositB);
    event ChannelCancelled(bytes32 indexed channelId);
    event CloseInitiated(
        bytes32 indexed channelId, uint64 nonce, uint128 balanceA, uint128 balanceB, uint64 challengeExpireAt
    );
    event StateChallenged(
        bytes32 indexed channelId, uint64 nonce, uint128 balanceA, uint128 balanceB, uint64 challengeExpireAt
    );
    event ChannelSettled(bytes32 indexed channelId, uint128 payoutA, uint128 payoutB);
    event PayoutBlocked(bytes32 indexed channelId, address indexed participant, address token, uint128 amount);
    event BlockedPayoutRescued(
        bytes32 indexed channelId, address indexed participant, address token, uint256 amount, address to
    );

    // =========================================================================
    //                                 Errors
    // =========================================================================

    error InvalidProtocolVersion();
    error InvalidParticipants();
    error InvalidToken();
    error InvalidChallengeDuration();
    error IntentExpired();
    error IntentNotYetValid();
    error ChannelAlreadyExists();
    error ChannelNotPending();
    error ChannelNotOpen();
    error ChannelNotClosing();
    error InvalidSignature();
    error InvalidCapability();
    error CapabilitySpendExceeded();
    error StaleNonce();
    error NotNewerNonce();
    error BalanceSumMismatch();
    error ChallengeWindowActive();
    error ChallengeWindowExpired();
    error TransferFailed();
    error ReceiptMismatch();
    error NotAuthorizedToRedirect();
    error NoBlockedPayout();

    // =========================================================================
    //                               Constructor
    // =========================================================================

    constructor() EIP712("Tempo.ChannelManager", "1") {}

    // =========================================================================
    //                          Lifecycle: open / join
    // =========================================================================

    /// @notice Opens a channel: verifies A's signature over `intent`, pulls
    /// A's deposit via TIP-20, and marks the channel PENDING until B joins.
    function openChannel(ChannelIntent calldata intent, bytes calldata signatureA)
        external
        nonReentrant
        returns (bytes32 channelId)
    {
        if (intent.protocolVersion != PROTOCOL_VERSION) revert InvalidProtocolVersion();
        if (
            intent.participantA == address(0) || intent.participantB == address(0)
                || intent.participantA == intent.participantB
        ) {
            revert InvalidParticipants();
        }
        if (intent.token == address(0)) revert InvalidToken();
        if (intent.challengeDuration < MIN_CHALLENGE_DURATION || intent.challengeDuration > MAX_CHALLENGE_DURATION) {
            revert InvalidChallengeDuration();
        }
        if (block.timestamp >= intent.validUntil) revert IntentExpired();

        channelId = _computeChannelId(intent);
        if (_usedChannelIds[channelId]) revert ChannelAlreadyExists();

        if (!_isValidDirectSignature(_hashIntent(intent), signatureA, intent.participantA)) {
            revert InvalidSignature();
        }

        Channel storage ch = _channels[channelId];
        _usedChannelIds[channelId] = true;
        ch.participantA = intent.participantA;
        ch.participantB = intent.participantB;
        ch.token = intent.token;
        ch.challengeDuration = intent.challengeDuration;
        ch.validUntil = intent.validUntil;
        ch.status = Status.PENDING;
        ch.balanceA = intent.depositA;
        // ch.nonce, ch.balanceB, ch.challengeExpireAt default to 0

        if (intent.depositA > 0) {
            // `from` is `intent.participantA`, not `msg.sender`, so this
            // contract can be called by a relay on A's behalf. This is safe
            // because A's signature over `intent` was already verified
            // above, and TIP-20's own allowance system still requires A to
            // have separately approved this contract — a relay can submit
            // the call, but cannot conjure A's consent or allowance.
            // forge-lint: disable-next-line(arbitrary-send-erc20)
            if (!ITIP20(intent.token).transferFrom(intent.participantA, address(this), intent.depositA)) {
                revert TransferFailed();
            }
        }

        emit ChannelOpened(
            channelId,
            intent.participantA,
            intent.participantB,
            intent.token,
            intent.depositA,
            intent.depositB,
            intent.challengeDuration,
            intent.validUntil
        );
    }

    /// @notice Joins a pending channel: verifies B's signature over the same
    /// `intent` used at open, pulls B's deposit, and marks the channel OPEN.
    function joinChannel(ChannelIntent calldata intent, bytes calldata signatureB) external nonReentrant {
        bytes32 channelId = _computeChannelId(intent);
        Channel storage ch = _channels[channelId];
        if (ch.status != Status.PENDING) revert ChannelNotPending();
        if (block.timestamp >= intent.validUntil) revert IntentExpired();

        if (!_isValidDirectSignature(_hashIntent(intent), signatureB, intent.participantB)) {
            revert InvalidSignature();
        }

        ch.status = Status.OPEN;
        ch.balanceB = intent.depositB;

        if (intent.depositB > 0) {
            // Same reasoning as in openChannel: `from` is `intent.participantB`,
            // authorized by B's own signature over `intent`, verified above,
            // plus B's own separate TIP-20 allowance to this contract.
            // forge-lint: disable-next-line(arbitrary-send-erc20)
            if (!ITIP20(intent.token).transferFrom(intent.participantB, address(this), intent.depositB)) {
                revert TransferFailed();
            }
        }

        emit ChannelJoined(channelId, intent.depositB);
    }

    /// @notice Refunds A's deposit if B never joined before `intent.validUntil`.
    /// Permissionless: anyone can call, funds always return to the stored
    /// participant A regardless of caller.
    function cancelUnjoined(ChannelIntent calldata intent) external nonReentrant {
        bytes32 channelId = _computeChannelId(intent);
        Channel storage ch = _channels[channelId];
        if (ch.status != Status.PENDING) revert ChannelNotPending();
        if (block.timestamp < ch.validUntil) revert IntentNotYetValid();

        address token = ch.token;
        address participantA = ch.participantA;
        uint128 refund = ch.balanceA;

        delete _channels[channelId];

        _payout(token, participantA, refund, channelId);

        emit ChannelCancelled(channelId);
    }

    // =========================================================================
    //                        Lifecycle: close / dispute
    // =========================================================================

    /// @notice Immediately settles and pays out a mutually-signed final state.
    /// Works from OPEN (normal path) or CLOSING (either party can short-circuit
    /// an in-progress unilateral close back to an immediate cooperative one).
    function cooperativeClose(ChannelState calldata state, bytes calldata signatureA, bytes calldata signatureB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[state.channelId];
        if (ch.status != Status.OPEN && ch.status != Status.CLOSING) revert ChannelNotOpen();
        _requireValidTransition(ch, state, _directAuthorization(signatureA), _directAuthorization(signatureB));

        _settle(state.channelId, ch, state.balanceA, state.balanceB);
    }

    /// @notice Capability-aware cooperative close. Each participant may use
    /// either a direct account signature or a constrained delegated signer.
    function cooperativeCloseWithCapabilities(
        ChannelState calldata state,
        StateAuthorization calldata authorizationA,
        StateAuthorization calldata authorizationB
    ) external nonReentrant {
        Channel storage ch = _channels[state.channelId];
        if (ch.status != Status.OPEN && ch.status != Status.CLOSING) revert ChannelNotOpen();
        _requireValidTransition(ch, state, authorizationA, authorizationB);

        _settle(state.channelId, ch, state.balanceA, state.balanceB);
    }

    /// @notice Starts a unilateral close with the latest mutually-signed state
    /// either party has. Opens a challenge window during which the
    /// counterparty can present a strictly newer mutually-signed state.
    function initiateClose(ChannelState calldata state, bytes calldata signatureA, bytes calldata signatureB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[state.channelId];
        if (ch.status != Status.OPEN) revert ChannelNotOpen();
        _requireValidTransition(ch, state, _directAuthorization(signatureA), _directAuthorization(signatureB));

        _startClose(ch, state);
    }

    /// @notice Capability-aware unilateral-close initiation.
    function initiateCloseWithCapabilities(
        ChannelState calldata state,
        StateAuthorization calldata authorizationA,
        StateAuthorization calldata authorizationB
    ) external nonReentrant {
        Channel storage ch = _channels[state.channelId];
        if (ch.status != Status.OPEN) revert ChannelNotOpen();
        _requireValidTransition(ch, state, authorizationA, authorizationB);

        _startClose(ch, state);
    }

    function _startClose(Channel storage ch, ChannelState calldata state) internal {
        ch.nonce = state.nonce;
        ch.balanceA = state.balanceA;
        ch.balanceB = state.balanceB;
        ch.status = Status.CLOSING;
        // Safe: block.timestamp doesn't exceed type(uint64).max until year 2554.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 expireAt = uint64(block.timestamp) + ch.challengeDuration;
        ch.challengeExpireAt = expireAt;

        emit CloseInitiated(state.channelId, state.nonce, state.balanceA, state.balanceB, expireAt);
    }

    /// @notice Presents a strictly newer mutually-signed state during the
    /// challenge window, overriding a stale `initiateClose` and resetting the
    /// window so the counterparty has a fair chance to respond in turn.
    function challenge(ChannelState calldata newerState, bytes calldata signatureA, bytes calldata signatureB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[newerState.channelId];
        if (ch.status != Status.CLOSING) revert ChannelNotClosing();
        if (block.timestamp > ch.challengeExpireAt) revert ChallengeWindowExpired();
        if (newerState.nonce <= ch.nonce) revert NotNewerNonce();
        _requireValidSignaturesAndBalance(
            ch, newerState, _directAuthorization(signatureA), _directAuthorization(signatureB)
        );

        _recordChallenge(ch, newerState);
    }

    /// @notice Capability-aware challenge with a strictly newer state.
    function challengeWithCapabilities(
        ChannelState calldata newerState,
        StateAuthorization calldata authorizationA,
        StateAuthorization calldata authorizationB
    ) external nonReentrant {
        Channel storage ch = _channels[newerState.channelId];
        if (ch.status != Status.CLOSING) revert ChannelNotClosing();
        if (block.timestamp > ch.challengeExpireAt) revert ChallengeWindowExpired();
        if (newerState.nonce <= ch.nonce) revert NotNewerNonce();
        _requireValidSignaturesAndBalance(ch, newerState, authorizationA, authorizationB);

        _recordChallenge(ch, newerState);
    }

    function _recordChallenge(Channel storage ch, ChannelState calldata newerState) internal {
        ch.nonce = newerState.nonce;
        ch.balanceA = newerState.balanceA;
        ch.balanceB = newerState.balanceB;
        // Safe: block.timestamp doesn't exceed type(uint64).max until year 2554.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 expireAt = uint64(block.timestamp) + ch.challengeDuration;
        ch.challengeExpireAt = expireAt;

        emit StateChallenged(newerState.channelId, newerState.nonce, newerState.balanceA, newerState.balanceB, expireAt);
    }

    /// @notice Pays out the last recorded state once the challenge window has
    /// passed with no successful challenge. Permissionless keeper function.
    function finalizeClose(bytes32 channelId) external nonReentrant {
        Channel storage ch = _channels[channelId];
        if (ch.status != Status.CLOSING) revert ChannelNotClosing();
        if (block.timestamp <= ch.challengeExpireAt) revert ChallengeWindowActive();

        _settle(channelId, ch, ch.balanceA, ch.balanceB);
    }

    // =========================================================================
    //                                  Views
    // =========================================================================

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    function computeChannelId(ChannelIntent calldata intent) external view returns (bytes32) {
        return _computeChannelId(intent);
    }

    /// @notice Whether this channel id has ever been opened. This remains true
    /// after settlement or cancellation so relays can distinguish an unused id
    /// from a completed channel whose live storage has been deleted.
    function isChannelIdUsed(bytes32 channelId) external view returns (bool) {
        return _usedChannelIds[channelId];
    }

    /// @notice Amount still owed to `participant` from `channelId` that was
    /// redirected to ReceivePolicyGuard rather than delivered directly. See
    /// `rescueBlockedPayout`.
    function getBlockedPayout(bytes32 channelId, address participant) external view returns (uint128) {
        return _blockedPayouts[channelId][participant];
    }

    // =========================================================================
    //                                Internal
    // =========================================================================

    /// @dev Validates a candidate state against stored channel state (nonce
    /// not stale, total balance conserved) and both participants' signatures.
    /// Does not mutate storage.
    function _requireValidTransition(
        Channel storage ch,
        ChannelState calldata state,
        StateAuthorization memory authorizationA,
        StateAuthorization memory authorizationB
    ) internal view {
        if (state.nonce < ch.nonce) revert StaleNonce();
        _requireValidSignaturesAndBalance(ch, state, authorizationA, authorizationB);
    }

    function _requireValidSignaturesAndBalance(
        Channel storage ch,
        ChannelState calldata state,
        StateAuthorization memory authorizationA,
        StateAuthorization memory authorizationB
    ) internal view {
        if (uint256(state.balanceA) + uint256(state.balanceB) != uint256(ch.balanceA) + uint256(ch.balanceB)) {
            revert BalanceSumMismatch();
        }

        bytes32 digest = _hashState(state);
        _requireParticipantAuthorization(
            ch, state, digest, authorizationA, ch.participantA, ch.participantB, state.balanceA
        );
        _requireParticipantAuthorization(
            ch, state, digest, authorizationB, ch.participantB, ch.participantA, state.balanceB
        );
    }

    function _requireParticipantAuthorization(
        Channel storage ch,
        ChannelState calldata state,
        bytes32 stateDigest,
        StateAuthorization memory authorization,
        address participant,
        address counterparty,
        uint128 participantBalance
    ) internal view {
        if (authorization.capabilitySignature.length == 0) {
            if (!_isValidDirectSignature(stateDigest, authorization.stateSignature, participant)) {
                revert InvalidSignature();
            }
            return;
        }

        ChannelCapability memory capability = authorization.capability;
        if (
            capability.protocolVersion != PROTOCOL_VERSION || capability.channelId != state.channelId
                || capability.participant != participant || capability.delegatedSigner == address(0)
                || capability.counterparty != counterparty || capability.token != ch.token
                || capability.maxNetSpend > capability.baselineBalance
                || capability.baselineBalance > uint256(state.balanceA) + uint256(state.balanceB)
        ) {
            revert InvalidCapability();
        }

        (bool stateSignatureValid, address stateSigner) = _recoverSigner(stateDigest, authorization.stateSignature);
        if (!stateSignatureValid || stateSigner != capability.delegatedSigner) revert InvalidSignature();

        if (!_isValidDirectSignature(_hashCapability(capability), authorization.capabilitySignature, participant)) {
            revert InvalidCapability();
        }

        uint128 minimumBalance = capability.baselineBalance - capability.maxNetSpend;
        if (participantBalance < minimumBalance) revert CapabilitySpendExceeded();
    }

    function _directAuthorization(bytes calldata signature)
        internal
        pure
        returns (StateAuthorization memory authorization)
    {
        authorization.stateSignature = signature;
    }

    /// @dev Pays out `payoutA`/`payoutB`, deletes the channel (storage
    /// refund), and emits ChannelSettled. Effects before interactions: reads
    /// everything needed from storage, deletes it, then calls out to the
    /// token last.
    function _settle(bytes32 channelId, Channel storage ch, uint128 payoutA, uint128 payoutB) internal {
        address token = ch.token;
        address participantA = ch.participantA;
        address participantB = ch.participantB;

        delete _channels[channelId];

        _payout(token, participantA, payoutA, channelId);
        _payout(token, participantB, payoutB, channelId);

        emit ChannelSettled(channelId, payoutA, payoutB);
    }

    /// @dev Sends `amount` of `token` to `to`, but does not blindly trust a
    /// truthy return value as proof of delivery: a TIP-403 receive policy on
    /// `to` can make the TIP-20 call return `true` while silently
    /// redirecting the funds to Tempo's ReceivePolicyGuard instead
    /// (https://tips.sh/1028). Comparing `to`'s balance before/after detects
    /// that redirect; any shortfall is tracked in `_blockedPayouts` instead
    /// of being lost, and can later be claimed back via
    /// `rescueBlockedPayout` once the receipt is known (by indexing the
    /// token's `TransferBlocked` event) — this contract is very likely the
    /// authorized claimer, since it's the `transfer` call's `msg.sender`
    /// (the receipt's `originator`), and most receivers never configure a
    /// receive policy's recovery authority away from that default.
    /// @dev The `_blockedPayouts` write below necessarily happens after the
    /// external `transfer` call — the whole point is recording what that
    /// call's *outcome* was, so the write can't be reordered ahead of it the
    /// way a plain CEI pattern would. This is safe from reentrancy because
    /// every caller of `_payout` (`_settle`, `cancelUnjoined`) is reached
    /// only through a `nonReentrant`-guarded external function, so no
    /// callback during `transfer` can re-enter any state-changing function
    /// on this contract regardless of call ordering within `_payout` itself.
    function _payout(address token, address to, uint128 amount, bytes32 channelId) internal {
        if (amount == 0) return;

        uint256 balBefore = ITIP20(token).balanceOf(to);
        if (!ITIP20(token).transfer(to, amount)) revert TransferFailed();
        uint256 delivered = ITIP20(token).balanceOf(to) - balBefore;

        if (delivered < amount) {
            // Safe: delivered < amount <= type(uint128).max here.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 blocked = amount - uint128(delivered);
            _blockedPayouts[channelId][to] += blocked;
            emit PayoutBlocked(channelId, to, token, blocked);
        }
    }

    /// @notice Claims a payout that was redirected to ReceivePolicyGuard
    /// (see `_payout`) back for the affected participant. `receipt` is the
    /// ABI-encoded `IReceivePolicyGuard.ClaimReceiptV1` witness, obtained
    /// off-chain by indexing the token's `TransferBlocked` event — the guard
    /// does not enumerate receipts on-chain.
    ///
    /// Permissionless when `to` is the original recipient (the affected
    /// participant), matching the rest of this contract's "anyone can
    /// trigger it, funds always go to the correct owner" pattern. Redirecting
    /// to a *different* address (e.g. because the participant is still
    /// blocked at their channel address and wants funds sent elsewhere)
    /// requires `msg.sender == recipient`. Tempo's own guard independently
    /// re-enforces who is allowed to claim the receipt and where a reroute
    /// may land — this check is defense in depth, not the only guard.
    function rescueBlockedPayout(bytes32 channelId, address token, bytes calldata receipt, address to)
        external
        nonReentrant
    {
        IReceivePolicyGuard.ClaimReceiptV1 memory r = abi.decode(receipt, (IReceivePolicyGuard.ClaimReceiptV1));
        if (r.token != token || r.originator != address(this)) revert ReceiptMismatch();

        address participant = r.recipient;
        if (to != participant && msg.sender != participant) revert NotAuthorizedToRedirect();

        uint128 pending = _blockedPayouts[channelId][participant];
        if (pending == 0) revert NoBlockedPayout();
        _blockedPayouts[channelId][participant] = 0;

        RECEIVE_POLICY_GUARD.claim(to, receipt);

        emit BlockedPayoutRescued(channelId, participant, token, pending, to);
    }

    function _isValidDirectSignature(bytes32 digest, bytes memory signature, address participant)
        internal
        view
        returns (bool)
    {
        (bool valid, address signer) = _recoverSigner(digest, signature);
        return valid && signer == participant;
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) internal view returns (bool valid, address signer) {
        try SIGNATURE_VERIFIER.recover(digest, signature) returns (address recovered) {
            return (true, recovered);
        } catch {
            return (false, address(0));
        }
    }

    function _hashIntent(ChannelIntent calldata intent) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CHANNEL_INTENT_TYPEHASH,
                intent.protocolVersion,
                intent.participantA,
                intent.participantB,
                intent.token,
                intent.depositA,
                intent.depositB,
                intent.challengeDuration,
                intent.validUntil,
                intent.salt
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _hashState(ChannelState calldata state) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH, state.channelId, state.nonce, state.balanceA, state.balanceB, state.appDataHash
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _hashCapability(ChannelCapability memory capability) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CHANNEL_CAPABILITY_TYPEHASH,
                capability.protocolVersion,
                capability.channelId,
                capability.participant,
                capability.delegatedSigner,
                capability.counterparty,
                capability.token,
                capability.baselineBalance,
                capability.maxNetSpend,
                capability.capabilityNonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @dev channelId is derived from the intent's EIP-712 struct hash plus
    /// chain id and this contract's address, so the same logical intent
    /// content can never collide across chains or contract deployments, and
    /// a tampered intent passed to `joinChannel`/`cancelUnjoined` simply
    /// fails to match any stored (non-VOID) channel.
    function _computeChannelId(ChannelIntent calldata intent) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CHANNEL_INTENT_TYPEHASH,
                intent.protocolVersion,
                intent.participantA,
                intent.participantB,
                intent.token,
                intent.depositA,
                intent.depositB,
                intent.challengeDuration,
                intent.validUntil,
                intent.salt
            )
        );
        return keccak256(abi.encode(structHash, block.chainid, address(this)));
    }
}
