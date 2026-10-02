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
