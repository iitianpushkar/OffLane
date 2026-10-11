# OffLane Next.js product

This package is the Vercel-ready user interface for OffLane:

- `/` — public product homepage
- `/app` — Wagmi-powered wallet, channel, and agent workspace
- `/demo` — visual proof of the automated end-to-end demo
- `/api/config` — public Moderato contract and relay configuration

## Local development

Build the workspace once, then start the persistent relay and Next.js in
separate terminals from the repository root:

```bash
pnpm build
pnpm --filter @offlane/relay start
```

```bash
pnpm dashboard
```

Open `http://127.0.0.1:4173`. Next.js reads the repository-root `.env` during
local development. Wallet signatures and transactions still require explicit
approval. The interface is fixed to Tempo Moderato chain ID `42431`.

## Encrypted payment flow

Use two browser profiles so each participant can connect a different wallet:

1. Both participants open the same joined channel from **Channels**.
2. On first connection, each wallet signs a 30-day messaging-key certificate.
3. OffLane resolves the counterparty's signed key automatically from the
   wallet address recorded in the channel.
4. Either participant writes a message, enters a PathUSD amount, and selects
   **Sign and propose payment**.
5. The recipient opens or refreshes the channel, reads the decrypted message,
   and accepts or rejects the proposal.
6. After acceptance, both workspaces show the new nonce and balances. Repeat
   from the other wallet to test the reverse direction.

Messaging private keys are generated in the browser and stored in that
profile's local storage. The relay stores the wallet-signed public-key
certificate, encrypted envelopes, and signed pending proposals. It cannot
decrypt messages. A recipient can recover a proposal after reconnecting or
restarting the browser. Restart the relay after pulling protocol or relay
changes so it recognizes the latest RPC methods.

The local `/demo` route can start the CLI demo and stream its output. Its test
private keys stay in the Node process and are never returned by an API route.
The process-spawning demo is disabled on Vercel.

## Vercel deployment

Create a Vercel project for `apps/dashboard` and enable access to files outside
the root directory so pnpm can resolve the workspace packages. Use the normal
Next.js build command or run this from the repository root:

```bash
pnpm --filter @offlane/dashboard build
```

Configure these Vercel environment variables:

```dotenv
OFFLANE_CHAIN_ID=42431
OFFLANE_RPC_URL=https://rpc.moderato.tempo.xyz
OFFLANE_CHANNEL_MANAGER=0x...
OFFLANE_BROWSER_RELAY_URL=wss://relay.example.com/ws
OFFLANE_TOKEN_ADDRESS=0x20C0000000000000000000000000000000000000
```

Deploy `services/relay` on a persistent Node host with durable storage and TLS.
Vercel serves the Next.js UI and configuration route; it does not host the
WebSocket relay or its SQLite database. Do not add `ALICE_PK`, `BOB_PK`, or
other test private keys to the Vercel project.
