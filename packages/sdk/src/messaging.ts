import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  encodeEncryptedEnvelopeAad,
  hashEncryptedEnvelope,
  type Address,
  type Bytes32,
  type EncryptedEnvelope,
  type Hex,
} from "@offlane/protocol";
import { bytesToHex, hexToBytes } from "viem";

export interface MessagingKeyPair {
  privateKey: Bytes32;
  publicKey: Bytes32;
}

export interface EncryptMessageInput {
  channelId: Bytes32;
  sender: Address;
  recipient: Address;
  sequence: bigint;
  stateNonce: bigint;
  senderKeyPair: MessagingKeyPair;
  recipientPublicKey: Bytes32;
  plaintext: Uint8Array | string;
  contentType?: string;
}

export function generateMessagingKeyPair(): MessagingKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  return {
    privateKey: bytesToHex(privateKey) as Bytes32,
    publicKey: bytesToHex(x25519.getPublicKey(privateKey)) as Bytes32,
  };
}

function deriveMessageKey(
  privateKey: Bytes32,
  peerPublicKey: Bytes32,
  channelId: Bytes32,
  aad: Hex,
): Uint8Array {
  const sharedSecret = x25519.getSharedSecret(
    hexToBytes(privateKey),
    hexToBytes(peerPublicKey),
  );
  return hkdf(
    sha256,
    sharedSecret,
    hexToBytes(channelId),
    hexToBytes(aad),
    32,
  );
}

export function encryptMessage(input: EncryptMessageInput): EncryptedEnvelope {
  const contentType = input.contentType ?? "application/json";
  const header = {
    protocolVersion: 1 as const,
    channelId: input.channelId,
    sender: input.sender,
    recipient: input.recipient,
    sequence: input.sequence,
    stateNonce: input.stateNonce,
    senderPublicKey: input.senderKeyPair.publicKey,
    recipientPublicKey: input.recipientPublicKey,
    contentType,
  };
  const aad = encodeEncryptedEnvelopeAad(header);
  const encryptionNonce = randomBytes(24);
  const key = deriveMessageKey(
    input.senderKeyPair.privateKey,
    input.recipientPublicKey,
    input.channelId,
    aad,
  );
  const plaintext =
    typeof input.plaintext === "string"
      ? new TextEncoder().encode(input.plaintext)
      : input.plaintext;
  const ciphertext = xchacha20poly1305(
    key,
    encryptionNonce,
    hexToBytes(aad),
  ).encrypt(plaintext);
  const committed = {
    ...header,
    encryptionNonce: bytesToHex(encryptionNonce),
    ciphertext: bytesToHex(ciphertext),
  } satisfies Omit<EncryptedEnvelope, "messageId">;
  return { ...committed, messageId: hashEncryptedEnvelope(committed) };
}

export function decryptMessage(
  envelope: EncryptedEnvelope,
  recipientKeyPair: MessagingKeyPair,
): Uint8Array {
  if (
    envelope.recipientPublicKey.toLowerCase() !==
    recipientKeyPair.publicKey.toLowerCase()
  ) {
    throw new Error("message is encrypted for a different messaging key");
  }
  const { messageId: _, encryptionNonce, ciphertext, ...header } = envelope;
  if (hashEncryptedEnvelope({ ...header, encryptionNonce, ciphertext }) !== envelope.messageId) {
    throw new Error("encrypted envelope commitment is invalid");
  }
  const aad = encodeEncryptedEnvelopeAad(header);
  const key = deriveMessageKey(
    recipientKeyPair.privateKey,
    envelope.senderPublicKey,
    envelope.channelId,
    aad,
  );
  return xchacha20poly1305(
    key,
    hexToBytes(encryptionNonce),
    hexToBytes(aad),
  ).decrypt(hexToBytes(ciphertext));
}

export function decryptMessageText(
  envelope: EncryptedEnvelope,
  recipientKeyPair: MessagingKeyPair,
): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    decryptMessage(envelope, recipientKeyPair),
  );
}
