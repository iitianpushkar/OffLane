# @offlane/relay

The OffLane relay transports participant-signed channel states. It does not
hold participant keys and never countersigns a balance update.

The first adapter keeps state in memory. Seeded channel records represent the
chain-indexer boundary; a later SQLite/indexer adapter will populate them from
`ChannelManager` events.

Delegated agents authenticate with their own key, then call
`channels.v1.register_capability` with the participant-signed capability. This
binds the live connection to that participant for inbound proposal delivery
without giving the relay any signing authority.

The default verifier supports secp256k1 EOAs, which covers autonomous agent
keys. `AuthorizationVerifier` is an explicit adapter boundary for adding
Tempo TIP-1020 P256 and WebAuthn verification without changing relay state
progression.

## Run

```bash
OFFLANE_CHAIN_ID=42431 \
OFFLANE_CHANNEL_MANAGER=0x... \
pnpm --filter @offlane/relay build

OFFLANE_CHAIN_ID=42431 \
OFFLANE_CHANNEL_MANAGER=0x... \
pnpm --filter @offlane/relay start
```

The WebSocket endpoint is `ws://127.0.0.1:7824/ws` and the health endpoint is
`http://127.0.0.1:7824/health`.
