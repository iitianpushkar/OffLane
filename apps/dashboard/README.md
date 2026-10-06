# OffLane web product

This package serves the user-facing OffLane product:

- `/` — public product homepage
- `/app` — wallet-authenticated channel and agent workspace
- `/demo` — optional visual proof of the automated end-to-end demo

The app connects a Tempo-compatible browser wallet directly to Moderato and
authenticates it with the relay using a signed one-time challenge. Users can
discover their indexed channels, open a channel, share or import a
counterparty invite, join a pending channel, and create a channel-scoped agent
capability with a maximum net spend. Agent private keys live only in the
current browser tab.

From the repository root, with the same ignored `.env` used by the CLI demo:

```bash
pnpm build
pnpm --filter @offlane/dashboard start
```

Open `http://127.0.0.1:4173`. A wallet must explicitly approve every signature
and on-chain transaction. The product is fixed to Tempo Moderato chain ID
`42431`; no mainnet configuration is exposed.

The server starts the persistent indexed relay when one is not already
running. The `/demo` page may start one isolated demo run at a time. Test
private keys used by that optional demo remain in the server process and are
never included in browser responses.

Optional settings:

```dotenv
OFFLANE_DASHBOARD_HOST=127.0.0.1
OFFLANE_DASHBOARD_PORT=4173
```
