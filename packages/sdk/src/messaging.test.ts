import { hashEncryptedEnvelope, type Address, type Bytes32 } from "@offlane/protocol";
import { describe, expect, it } from "vitest";
import {
  decryptMessageText,
  encryptMessage,
  generateMessagingKeyPair,
} from "./messaging.js";

const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const ALICE = "0x00000000000000000000000000000000000000a1" as Address;
const BOB = "0x00000000000000000000000000000000000000b2" as Address;

describe("encrypted messaging", () => {
  it("encrypts bidirectionally and detects tampering or a wrong recipient key", () => {
    const alice = generateMessagingKeyPair();
    const bob = generateMessagingKeyPair();
    const request = encryptMessage({
      channelId: CHANNEL,
      sender: ALICE,
      recipient: BOB,
      sequence: 1n,
      stateNonce: 1n,
      senderKeyPair: alice,
      recipientPublicKey: bob.publicKey,
      plaintext: JSON.stringify({ task: "summarize", input: "hello" }),
    });

    expect(decryptMessageText(request, bob)).toBe(
      JSON.stringify({ task: "summarize", input: "hello" }),
    );
    expect(hashEncryptedEnvelope(request)).toBe(request.messageId);
    expect(() => decryptMessageText(request, generateMessagingKeyPair())).toThrow(
      "different messaging key",
    );
    expect(() =>
      decryptMessageText(
        { ...request, ciphertext: `${request.ciphertext.slice(0, -2)}00` },
        bob,
      ),
    ).toThrow("commitment is invalid");

    const response = encryptMessage({
      channelId: CHANNEL,
      sender: BOB,
      recipient: ALICE,
      sequence: 1n,
      stateNonce: 2n,
      senderKeyPair: bob,
      recipientPublicKey: alice.publicKey,
      plaintext: "done",
      contentType: "text/plain",
    });
    expect(decryptMessageText(response, alice)).toBe("done");
  });
});
