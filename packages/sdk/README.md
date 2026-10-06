# @offlane/sdk

Transport-independent client primitives for OffLane relays.

The RPC layer follows Nitrolite's compact five-element frame and separates the
WebSocket transport from request correlation. OffLane uses versioned methods and
strict runtime validation, while its payloads carry the two-party
`ChannelState` and either direct or channel-capability authorization.

```ts
const client = new OfflaneClient(
  new WebSocketTransport("wss://relay.example/ws"),
);

await client.connect();
await client.proposeState({
  proposalId,
  proposer,
  baseStateHash,
  state,
  authorization,
});
```

`proposeState` is direction-neutral. Participant A or participant B may be the
proposer and payer; the state balances determine the payment direction.

## Endpoint encryption

The SDK keeps plaintext and messaging private keys outside the relay. It uses
X25519 for a shared secret, HKDF-SHA256 for a channel-and-header-specific key,
and XChaCha20-Poly1305 for authenticated encryption.

```ts
const aliceMessaging = generateMessagingKeyPair();
const envelope = encryptMessage({
  channelId,
  sender: alice,
  recipient: bob,
  sequence: 1n,
  stateNonce: 1n,
  senderKeyPair: aliceMessaging,
  recipientPublicKey: bobMessaging.publicKey,
  plaintext: JSON.stringify({ task: "summarize" }),
});

await client.sendMessage(envelope);
// Propose nonce 1 with appDataHash: envelope.messageId.

const [record] = await bobClient.listMessages(channelId);
const request = JSON.parse(decryptMessageText(record.envelope, bobMessaging));
await bobClient.acknowledgeMessage(envelope.messageId);
```

Applications must distribute and authenticate messaging public keys. The demo
creates dedicated ephemeral keys for both endpoints and passes their public
keys directly.
