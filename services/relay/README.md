# @offlane/relay

The OffLane relay transports participant-signed channel states. It does not
hold participant keys and never countersigns a balance update.

The runnable relay stores channels, pending proposals, signed states, and its
chain-indexer cursor in SQLite. On startup it replays confirmed
`ChannelManager` events from the saved cursor before accepting traffic.

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
OFFLANE_RPC_URL=https://... \
OFFLANE_DEPLOYMENT_BLOCK=123456 \
pnpm --filter @offlane/relay build

OFFLANE_CHAIN_ID=42431 \
OFFLANE_CHANNEL_MANAGER=0x... \
OFFLANE_RPC_URL=https://... \
OFFLANE_DEPLOYMENT_BLOCK=123456 \
OFFLANE_DATABASE_PATH=./offlane-relay.sqlite \
pnpm --filter @offlane/relay start
```

The WebSocket endpoint is `ws://127.0.0.1:7824/ws` and the health endpoint is
`http://127.0.0.1:7824/health`.

Optional settings:

- `OFFLANE_CONFIRMATIONS` defaults to `2` blocks.
- `OFFLANE_POLL_INTERVAL_MS` defaults to `2000` milliseconds.
- `OFFLANE_DATABASE_PATH` defaults to `./offlane-relay.sqlite`.
- `PORT` defaults to `7824`; `HOST` defaults to `127.0.0.1`.

`OFFLANE_DEPLOYMENT_BLOCK` is required to prevent an accidental scan from
genesis. See `docs/RUNBOOK.md` for the complete deployment and startup flow.
