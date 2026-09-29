// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChannelManager} from "../src/ChannelManager.sol";
import {IReceivePolicyGuard} from "../src/interfaces/IReceivePolicyGuard.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";

contract ChannelManagerTest is Test {
    // Real Tempo system precompiles. Foundry's `tempo = true` profile
    // (see foundry.toml) emulates these for real in the local test EVM —
    // confirmed by observation: TIP-1020 signature recovery/comparison
    // works correctly with no mock or vm.etch at all, and an unmocked call
    // to ReceivePolicyGuard rejects an unknown selector rather than acting
    // like an empty address. So tests below exercise the real precompiles
    // directly rather than a stand-in.
    address internal constant SIGNATURE_VERIFIER_ADDR = 0x5165300000000000000000000000000000000000;
    address internal constant RECEIVE_POLICY_GUARD_ADDR = 0xB10C000000000000000000000000000000000000;

    ChannelManager internal manager;
    MockTIP20 internal token;

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    address internal alice;
    address internal bob;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CHANNEL_INTENT_TYPEHASH = keccak256(
        "ChannelIntent(uint8 protocolVersion,address participantA,address participantB,address token,uint128 depositA,uint128 depositB,uint32 challengeDuration,uint32 validUntil,address authorizedSignerA,address authorizedSignerB,uint256 salt)"
    );
    bytes32 internal constant CHANNEL_STATE_TYPEHASH =
        keccak256("ChannelState(bytes32 channelId,uint64 nonce,uint128 balanceA,uint128 balanceB,bytes32 appDataHash)");

    function setUp() public {
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);

        manager = new ChannelManager();
        token = new MockTIP20();

        token.mint(alice, 1_000e6);
        token.mint(bob, 1_000e6);

        vm.prank(alice);
        token.approve(address(manager), type(uint256).max);
        vm.prank(bob);
        token.approve(address(manager), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Tempo.ChannelManager")),
                keccak256(bytes("1")),
                block.chainid,
                address(manager)
            )
        );
    }

    function _defaultIntent(uint128 depositA, uint128 depositB, uint256 salt)
        internal
        view
        returns (ChannelManager.ChannelIntent memory)
    {
        return ChannelManager.ChannelIntent({
            protocolVersion: manager.PROTOCOL_VERSION(),
            participantA: alice,
            participantB: bob,
            token: address(token),
            depositA: depositA,
            depositB: depositB,
            challengeDuration: manager.MIN_CHALLENGE_DURATION(),
            validUntil: uint32(block.timestamp + 1 days),
            authorizedSignerA: address(0),
            authorizedSignerB: address(0),
            salt: salt
        });
    }

    function _hashIntent(ChannelManager.ChannelIntent memory intent) internal pure returns (bytes32) {
        return keccak256(
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
                intent.authorizedSignerA,
                intent.authorizedSignerB,
                intent.salt
            )
        );
    }

    function _signIntent(ChannelManager.ChannelIntent memory intent, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _hashIntent(intent)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashState(ChannelManager.ChannelState memory state) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH, state.channelId, state.nonce, state.balanceA, state.balanceB, state.appDataHash
            )
        );
    }

    function _signState(ChannelManager.ChannelState memory state, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _hashState(state)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openAndJoin(uint128 depositA, uint128 depositB, uint256 salt)
        internal
        returns (bytes32 channelId, ChannelManager.ChannelIntent memory intent)
    {
        intent = _defaultIntent(depositA, depositB, salt);
        bytes memory sigA = _signIntent(intent, alicePk);
        channelId = manager.openChannel(intent, sigA);

        bytes memory sigB = _signIntent(intent, bobPk);
        manager.joinChannel(intent, sigB);
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_OpenJoinCooperativeClose_PaysOutAgreedBalances() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 50e6, 1);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);

        // Off-chain: Alice pays Bob 30 tokens. New split: A=70, B=80 (sum stays 150).
        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 70e6, balanceB: 80e6, appDataHash: bytes32(0)
        });
        bytes memory sigA = _signState(state, alicePk);
        bytes memory sigB = _signState(state, bobPk);

        manager.cooperativeClose(state, sigA, sigB);

        assertEq(token.balanceOf(alice), aliceBefore + 70e6, "alice payout");
        assertEq(token.balanceOf(bob), bobBefore + 80e6, "bob payout");
        assertEq(uint8(manager.getChannel(channelId).status), uint8(ChannelManager.Status.VOID), "channel deleted");
    }

    function test_CancelUnjoined_RefundsDepositToA() public {
        ChannelManager.ChannelIntent memory intent = _defaultIntent(100e6, 0, 2);
        bytes memory sigA = _signIntent(intent, alicePk);
        bytes32 channelId = manager.openChannel(intent, sigA);

        uint256 aliceBefore = token.balanceOf(alice);

        vm.warp(intent.validUntil);
        manager.cancelUnjoined(intent);

        assertEq(token.balanceOf(alice), aliceBefore + 100e6, "alice refunded");
        assertEq(uint8(manager.getChannel(channelId).status), uint8(ChannelManager.Status.VOID));
    }

    function test_InitiateClose_FinalizesAtOriginalStateIfNotChallenged() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 3);

        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 5, balanceA: 120e6, balanceB: 80e6, appDataHash: bytes32(0)
        });
        bytes memory sigA = _signState(state, alicePk);
        bytes memory sigB = _signState(state, bobPk);

        manager.initiateClose(state, sigA, sigB);

        // Challenge window active: finalizing too early must revert.
        vm.expectRevert(ChannelManager.ChallengeWindowActive.selector);
        manager.finalizeClose(channelId);

        vm.warp(block.timestamp + manager.MIN_CHALLENGE_DURATION() + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        manager.finalizeClose(channelId);

        assertEq(token.balanceOf(alice), aliceBefore + 120e6);
        assertEq(token.balanceOf(bob), bobBefore + 80e6);
    }

    function test_Challenge_NewerStateOverridesStaleInitiateClose() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 4);

        // Bob tries to close with a stale, Bob-favorable state.
        ChannelManager.ChannelState memory staleState = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 100e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        manager.initiateClose(staleState, _signState(staleState, alicePk), _signState(staleState, bobPk));

        // Alice presents the real, newer state where she has since been paid more.
        ChannelManager.ChannelState memory newerState = ChannelManager.ChannelState({
            channelId: channelId, nonce: 2, balanceA: 150e6, balanceB: 50e6, appDataHash: bytes32(0)
        });
        manager.challenge(newerState, _signState(newerState, alicePk), _signState(newerState, bobPk));

        vm.warp(block.timestamp + manager.MIN_CHALLENGE_DURATION() + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        manager.finalizeClose(channelId);

        assertEq(token.balanceOf(alice), aliceBefore + 150e6, "newer state must win");
        assertEq(token.balanceOf(bob), bobBefore + 50e6, "newer state must win");
    }

    // ------------------------------------------------------------------
    // Failure modes
    // ------------------------------------------------------------------

    function test_RevertWhen_ChallengeWithStaleOrEqualNonce() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 5);

        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 3, balanceA: 100e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        manager.initiateClose(state, _signState(state, alicePk), _signState(state, bobPk));

        // Same nonce again must be rejected as a "challenge" (not strictly newer).
        vm.expectRevert(ChannelManager.NotNewerNonce.selector);
        manager.challenge(state, _signState(state, alicePk), _signState(state, bobPk));
    }

    function test_RevertWhen_BalanceSumChanged() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 6);

        // Total is 200 at open; this state claims 201 — must be rejected.
        ChannelManager.ChannelState memory badState = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 101e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        bytes memory sigA = _signState(badState, alicePk);
        bytes memory sigB = _signState(badState, bobPk);

        vm.expectRevert(ChannelManager.BalanceSumMismatch.selector);
        manager.cooperativeClose(badState, sigA, sigB);
    }

    function test_RevertWhen_MissingCounterpartySignature() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 7);

        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 100e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        bytes memory sigA = _signState(state, alicePk);
        // Bob's slot is filled with Alice's signature again — not a valid signature from Bob.
        vm.expectRevert(ChannelManager.InvalidSignature.selector);
        manager.cooperativeClose(state, sigA, sigA);
    }

    // ------------------------------------------------------------------
    // TIP-403 receive-policy blocking + rescue
    // ------------------------------------------------------------------

    function test_Payout_BlockedByReceivePolicy_IsTrackedNotLost() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 41);

        token.setBlocked(bob, true);

        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 100e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        manager.cooperativeClose(state, _signState(state, alicePk), _signState(state, bobPk));

        // Alice, unaffected, is paid normally.
        assertEq(token.balanceOf(alice), 900e6 + 100e6, "alice paid normally");
        // Bob's payout was redirected, not delivered, but not lost either.
        assertEq(token.balanceOf(bob), 900e6, "bob did not receive tokens directly");
        assertEq(manager.getBlockedPayout(channelId, bob), 100e6, "blocked amount tracked");
        assertEq(token.balanceOf(RECEIVE_POLICY_GUARD_ADDR), 100e6, "funds sitting at the guard");
    }

    /// @dev A fabricated receipt can never actually be rescued in this test
    /// environment: ChannelManager's `rescueBlockedPayout` calls the REAL
    /// ReceivePolicyGuard precompile (Foundry's `tempo = true` mode emulates
    /// it faithfully — see the constants comment above), and the real guard
    /// has no balance recorded for a receipt that wasn't created by a real
    /// TIP-403-policy-respecting TIP-20 token (MockTIP20 only simulates the
    /// symptom, not the real blocking mechanism). So this test only proves
    /// the parts of `rescueBlockedPayout` that don't depend on that: the
    /// authorization gate, and that it correctly reverts rather than
    /// silently succeeding when the real guard has nothing to release. A
    /// full block-then-claim round trip needs a Moderato testnet run with a
    /// real TIP-20 token and a configured receive policy.
    function test_RescueBlockedPayout_AuthorizationGateAndNoRealReceiptToClaim() public {
        (bytes32 channelId,) = _openAndJoin(100e6, 100e6, 42);

        token.setBlocked(bob, true);
        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: 100e6, balanceB: 100e6, appDataHash: bytes32(0)
        });
        manager.cooperativeClose(state, _signState(state, alicePk), _signState(state, bobPk));
        assertEq(manager.getBlockedPayout(channelId, bob), 100e6);

        bytes memory fabricatedReceipt = abi.encode(
            IReceivePolicyGuard.ClaimReceiptV1({
                version: 1,
                token: address(token),
                recoveryAuthority: address(0),
                originator: address(manager),
                recipient: bob,
                blockedAt: uint64(block.timestamp),
                blockedNonce: 1,
                blockedReason: IReceivePolicyGuard.BlockedReason.RECEIVE_POLICY,
                kind: IReceivePolicyGuard.InboundKind.TRANSFER,
                memo: bytes32(0)
            })
        );

        // A stranger cannot redirect Bob's funds elsewhere — rejected before
        // the real guard is ever called.
        address bobsOtherWallet = makeAddr("bobsOtherWallet");
        vm.expectRevert(ChannelManager.NotAuthorizedToRedirect.selector);
        manager.rescueBlockedPayout(channelId, address(token), fabricatedReceipt, bobsOtherWallet);

        // Bob (or a permissionless keeper rescuing to Bob himself) passes
        // our own authorization gate, but the real guard has no balance for
        // a receipt that was never genuinely created there — must revert,
        // not silently report success while delivering nothing.
        vm.expectRevert();
        manager.rescueBlockedPayout(channelId, address(token), fabricatedReceipt, bob);

        // Our own bookkeeping is untouched by the failed attempt.
        assertEq(manager.getBlockedPayout(channelId, bob), 100e6);
    }

    function test_RevertWhen_OpeningSameIntentTwice() public {
        ChannelManager.ChannelIntent memory intent = _defaultIntent(100e6, 100e6, 8);
        bytes memory sigA = _signIntent(intent, alicePk);
        manager.openChannel(intent, sigA);

        vm.expectRevert(ChannelManager.ChannelAlreadyExists.selector);
        manager.openChannel(intent, sigA);
    }

    function testFuzz_CooperativeClose_ConservesTotalBalance(uint128 depositA, uint128 depositB, uint128 newBalanceA)
        public
    {
        depositA = uint128(bound(depositA, 0, 500e6));
        depositB = uint128(bound(depositB, 0, 500e6));
        token.mint(alice, depositA);
        token.mint(bob, depositB);

        uint256 total = uint256(depositA) + uint256(depositB);
        (bytes32 channelId,) = _openAndJoin(depositA, depositB, uint256(keccak256(abi.encode(depositA, depositB))));

        newBalanceA = uint128(bound(newBalanceA, 0, total));
        uint128 newBalanceB = uint128(total - newBalanceA);

        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId, nonce: 1, balanceA: newBalanceA, balanceB: newBalanceB, appDataHash: bytes32(0)
        });

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);

        manager.cooperativeClose(state, _signState(state, alicePk), _signState(state, bobPk));

        assertEq(token.balanceOf(alice), aliceBefore + newBalanceA);
        assertEq(token.balanceOf(bob), bobBefore + newBalanceB);
        assertEq(token.balanceOf(address(manager)), 0, "contract must not retain funds after close");
    }
}
