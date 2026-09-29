// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChannelManager} from "../src/ChannelManager.sol";
import {ITIP20} from "../src/interfaces/ITIP20.sol";

/// @notice Live end-to-end smoke test against a deployed ChannelManager:
/// open -> join -> (simulated off-chain payment) -> cooperativeClose.
/// Not a permanent fixture — run once against testnet to validate the real
/// TIP-1020 precompile and real TIP-20 token behavior, not Foundry's local
/// emulation. Reads ALICE_PK, BOB_PK, CHANNEL_MANAGER, PATHUSD from env.
contract SmokeTest is Script {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CHANNEL_INTENT_TYPEHASH = keccak256(
        "ChannelIntent(uint8 protocolVersion,address participantA,address participantB,address token,uint128 depositA,uint128 depositB,uint32 challengeDuration,uint32 validUntil,address authorizedSignerA,address authorizedSignerB,uint256 salt)"
    );
    bytes32 internal constant CHANNEL_STATE_TYPEHASH =
        keccak256("ChannelState(bytes32 channelId,uint64 nonce,uint128 balanceA,uint128 balanceB,bytes32 appDataHash)");

    function run() external {
        uint256 alicePk = vm.envUint("ALICE_PK");
        uint256 bobPk = vm.envUint("BOB_PK");
        address managerAddr = vm.envAddress("CHANNEL_MANAGER");
        address token = vm.envAddress("PATHUSD");

        address alice = vm.addr(alicePk);
        address bob = vm.addr(bobPk);
        ChannelManager cm = ChannelManager(managerAddr);

        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Tempo.ChannelManager")),
                keccak256(bytes("1")),
                block.chainid,
                managerAddr
            )
        );

        ChannelManager.ChannelIntent memory intent = ChannelManager.ChannelIntent({
            protocolVersion: cm.PROTOCOL_VERSION(),
            participantA: alice,
            participantB: bob,
            token: token,
            depositA: 10e6,
            depositB: 10e6,
            challengeDuration: cm.MIN_CHALLENGE_DURATION(),
            validUntil: uint32(block.timestamp + 1 days),
            authorizedSignerA: address(0),
            authorizedSignerB: address(0),
            salt: uint256(keccak256(abi.encode(block.timestamp, block.prevrandao, "smoke-test")))
        });

        bytes32 intentDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, _hashIntent(intent)));
        bytes memory sigA = _sign(alicePk, intentDigest);
        bytes memory sigB = _sign(bobPk, intentDigest);

        console.log("=== open ===");
        vm.startBroadcast(alicePk);
        IERC20(token).approve(managerAddr, intent.depositA);
        bytes32 channelId = cm.openChannel(intent, sigA);
        vm.stopBroadcast();
        console.log("channelId:");
        console.logBytes32(channelId);

        console.log("=== join ===");
        vm.startBroadcast(bobPk);
        IERC20(token).approve(managerAddr, intent.depositB);
        cm.joinChannel(intent, sigB);
        vm.stopBroadcast();
        console.log("status after join (expect 2=OPEN):", uint8(cm.getChannel(channelId).status));

        console.log("=== cooperativeClose (simulated: alice pays bob 4) ===");
        ChannelManager.ChannelState memory state = ChannelManager.ChannelState({
            channelId: channelId,
            nonce: 1,
            balanceA: 6e6,
            balanceB: 14e6,
            appDataHash: bytes32(0)
        });
        bytes32 stateDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, _hashState(state)));
        bytes memory sigA2 = _sign(alicePk, stateDigest);
        bytes memory sigB2 = _sign(bobPk, stateDigest);

        uint256 aliceBefore = ITIP20(token).balanceOf(alice);
        uint256 bobBefore = ITIP20(token).balanceOf(bob);

        vm.startBroadcast(alicePk);
        cm.cooperativeClose(state, sigA2, sigB2);
        vm.stopBroadcast();

        uint256 aliceAfter = ITIP20(token).balanceOf(alice);
        uint256 bobAfter = ITIP20(token).balanceOf(bob);

        console.log("status after close (expect 0=VOID/deleted):", uint8(cm.getChannel(channelId).status));
        console.log("alice pathUSD delta (expect +6e6):", aliceAfter - aliceBefore);
        console.log("bob pathUSD delta (expect +14e6):", bobAfter - bobBefore);

        require(aliceAfter - aliceBefore == 6e6, "alice payout mismatch");
        require(bobAfter - bobBefore == 14e6, "bob payout mismatch");
        console.log("SMOKE TEST PASSED");
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

    function _hashState(ChannelManager.ChannelState memory state) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH, state.channelId, state.nonce, state.balanceA, state.balanceB, state.appDataHash
            )
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
