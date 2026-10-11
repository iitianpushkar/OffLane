# @offlane/relay

The OffLane relay transports participant-signed channel states. It does not
hold participant keys and never countersigns a balance update.

The runnable relay stores channels, pending proposals, signed states, and its
chain-indexer cursor in SQLite. It also stores opaque encrypted envelopes and
their delivery status; it never receives messaging private keys or plaintext.
On startup it replays confirmed
`ChannelManager` events from the saved cursor before accepting traffic.

Delegated agents authenticate with their own key, then call
`channels.v1.register_capability` with the participant-signed capability. This
binds the live connection to that participant for inbound proposal delivery
without giving the relay any signing authority.

The default verifier supports secp256k1 EOAs, which covers autonomous agent
keys. `AuthorizationVerifier` is an explicit adapter boundary for adding
Tempo TIP-1020 P256 and WebAuthn verification without changing relay state
progression.

Participants can call `channels.v1.get_pending` after reconnecting to recover
the current channel proposal before accepting or rejecting it. Pending
proposals use the same participant authorization checks as channel state
queries and survive relay restarts in SQLite.

## Messaging-key directory

Authenticated wallets register EIP-712-signed X25519 certificates through
`keys.v1.register`. A participant can call `keys.v1.resolve` only for itself or
an address sharing one of its indexed channels. The relay verifies wallet
ownership, certificate time bounds, and monotonically increasing versions;
`keys.v1.revoke` leaves a version tombstone so a revoked certificate cannot be
replayed. Certificates and revocations persist in SQLite.

## Encrypted message routing

Authenticated channel participants and registered delegated agents can call:

- `messages.v1.send` to persist and route an encrypted envelope
- `messages.v1.list` to recover the caller's channel inbox after reconnecting
- `messages.v1.acknowledge` to mark a message as processed by its recipient

The relay recomputes every envelope commitment and requires a message's
`stateNonce` to be the next channel nonce. A proposal with nonzero
`appDataHash` must refer to that stored message, proposer, and nonce. This
prevents an encrypted request from being paired with a different payment
state. Message rows survive relay restarts and are removed with their channel
after confirmed settlement.

## Run

Create the environment file at the workspace root:

```bash
cp .env.example .env
```

Set the deployment-specific values in `.env`:

```dotenv
OFFLANE_CHANNEL_MANAGER=0x...
OFFLANE_RPC_URL=https://...
OFFLANE_DEPLOYMENT_BLOCK=123456
```

Build and run the compiled service from the workspace root:

```bash
pnpm --filter @offlane/relay build
pnpm --filter @offlane/relay start
```

The start script requires and loads the root `.env` automatically. Existing
process environment variables take precedence over values from the file.

The WebSocket endpoint is `ws://127.0.0.1:7824/ws` and the health endpoint is
`http://127.0.0.1:7824/health`.

Optional settings:

- `OFFLANE_CONFIRMATIONS` defaults to `2` blocks.
- `OFFLANE_POLL_INTERVAL_MS` defaults to `2000` milliseconds.
- `OFFLANE_DATABASE_PATH` defaults to `./offlane-relay.sqlite`.
- `PORT` defaults to `7824`; `HOST` defaults to `127.0.0.1`.

`OFFLANE_DEPLOYMENT_BLOCK` is required to prevent an accidental scan from
genesis. See `docs/RUNBOOK.md` for the complete deployment and startup flow.
