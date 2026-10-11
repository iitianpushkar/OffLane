# @offlane/protocol

Canonical, chain-aware types and validation rules shared by OffLane clients,
agents, relays, and indexers.

The package deliberately keeps financial state transitions deterministic. A
relay may reject invalid messages early, but it cannot invent a balance or
decide payment direction. Both channel participants validate the same proposed
state and sign it independently.

## Bidirectional payments

A payment is represented by a new cumulative balance split. Either participant
can be the payer:

```text
A pays B: balanceA decreases and balanceB increases
B pays A: balanceB decreases and balanceA increases
```

Every accepted payment advances the nonce by exactly one and preserves the
total collateral.

## Agent capabilities

A participant may authorize an automated signing key with a root-signed
`ChannelCapability`. The capability binds the key to one channel,
counterparty and token, and defines the maximum net loss from a chosen
baseline balance. Both participants can create independent capabilities for
the same bidirectional channel.

Capabilities do not expire on-chain because expiry or revocation must not
invalidate an older signed state that is still needed as dispute evidence.
Clients enforce operational expiry and close the channel to retire the
capability permanently.

## Encrypted messages

`EncryptedEnvelope` is the canonical endpoint-encrypted payload shared by the
SDK and relay. Its authenticated header binds the channel, sender, recipient,
per-recipient sequence, payment-state nonce, both X25519 public keys, and
content type. `hashEncryptedEnvelope` additionally commits to the 24-byte
encryption nonce and ciphertext. That message ID is stored in
`ChannelState.appDataHash`, tying the encrypted request or response to the
balance transition signed by both channel participants.

Wire schemas encode `bigint` fields as decimal strings. The versioned message
RPC surface is `messages.v1.send`, `messages.v1.list`, and
`messages.v1.acknowledge`, with `messages.v1.received` and
`messages.v1.acknowledged` events.

`MessagingKeyCertificate` binds an X25519 public key to a wallet address using
an EIP-712 signature under the OffLane Messaging domain. Version and validity
fields support replacement, expiry, and revocation without using the wallet's
fund-controlling key for encryption.
