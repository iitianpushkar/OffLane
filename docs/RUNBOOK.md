# OffLane manual runbook

## Prerequisites

- Node.js 22.5 or newer (`node:sqlite` is used by the relay)
- pnpm 10.23
- Foundry with Tempo support
- A Moderato RPC URL
- Two funded Moderato accounts with the chosen TIP-20 collateral token

## Install and verify

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

cd contracts
forge build
forge test
cd ..
```

## Deploy `ChannelManager`

The repository records a current capability-enabled Moderato deployment in
`contracts/README.md`. Follow this section only when deploying a new instance,
and record both its contract address and deployment block.

```bash
cp .env.example .env
```

Edit `.env` and set `TEMPO_TESTNET_RPC_URL`. Load it into the current shell
before running Foundry:

```bash
set -a
source .env
set +a

cd contracts

test "$(cast chain-id --rpc-url "$TEMPO_TESTNET_RPC_URL")" = "42431" || {
  echo "Refusing deployment: RPC is not Tempo Moderato (chain ID 42431)"
  exit 1
}

forge create src/ChannelManager.sol:ChannelManager \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  --interactive \
  --tempo.fee-token PathUSD \
  --broadcast
```

Moderato pays transaction fees in TIP-20 stablecoins. If a disposable test
deployer has no PathUSD, fund its public address with the official testnet
faucet RPC before deployment:

```bash
cast rpc tempo_fundAddress DEPLOYER_ADDRESS \
  --rpc-url "$TEMPO_TESTNET_RPC_URL"
```

Use the transaction hash printed by `forge create` to retrieve the deployment
block if it is not printed directly:

```bash
cast receipt DEPLOYMENT_TRANSACTION_HASH \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  blockNumber
```

## Start the indexed relay

Return to the repository root and update `.env` with the new contract address
and deployment block:

```dotenv
OFFLANE_CHANNEL_MANAGER=DEPLOYED_CHANNEL_MANAGER_ADDRESS
OFFLANE_DEPLOYMENT_BLOCK=DEPLOYMENT_BLOCK_NUMBER
OFFLANE_RPC_URL=YOUR_MODERATO_RPC_URL
```

Build and start the relay:

```bash
pnpm build
pnpm --filter @offlane/relay start
```

The start script requires and loads the root `.env` automatically. Startup
first replays confirmed `ChannelManager` events into SQLite. It then serves:

- WebSocket RPC: `ws://127.0.0.1:7824/ws`
- Health check: `http://127.0.0.1:7824/health`

Check the process from another terminal:

```bash
curl http://127.0.0.1:7824/health
```

Stop it with `Ctrl-C`. Channels, pending proposals, signed states, and the
confirmed-block cursor remain in `offlane-relay.sqlite` for the next start.

## Run the live contract smoke test

The smoke script opens, joins, and cooperatively closes a direct-signature
channel. Each participant needs at least 10 units of the selected 6-decimal
TIP-20. It refuses to run unless the connected chain ID is Moderato `42431`.

If `.env` contains disposable `ALICE_PK` and `BOB_PK` test keys, load it in the
terminal before running the script:

```bash
set -a
source .env
set +a

cd contracts
export CHANNEL_MANAGER="$OFFLANE_CHANNEL_MANAGER"
export PATHUSD='MODERATO_PATHUSD_ADDRESS'

forge script script/SmokeTest.s.sol:SmokeTest \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  --tempo.fee-token PathUSD \
  --broadcast \
  -vvvv
```

For keys that are not disposable test credentials, leave them out of `.env`
and use a hardware wallet or an interactive signing flow.

The smoke script closes the channel, so the indexer will remove it after the
configured confirmation depth. Use a separate open channel for relay SDK
experiments.

## Run the bidirectional AI-agent demo

The agent demo is the full relay path. It starts an isolated relay, opens and
joins a 10/10 PathUSD channel, gives an ephemeral Alice agent a root-signed
3 PathUSD spending capability, accepts payments in both directions, restarts
the relay to prove SQLite recovery, and closes with the agent capability as
Alice's settlement evidence.

The ignored root `.env` must contain the Moderato RPC configuration and funded,
disposable `ALICE_PK` and `BOB_PK` test keys. Then run:

```bash
pnpm build
pnpm --filter @offlane/agent-demo start
```

The command refuses any live chain ID other than Moderato `42431`. It creates a
temporary SQLite database and removes it after the final on-chain settlement.

The first verified run used channel
`0xe5ba669256b66e9245996f790f78964588cb66121ae13ef64c3b2f8bc5aeffa0`
and settled it in transaction
[`0xf78f1fd3…68ca5a3`](https://explore.tempo.xyz/tx/0xf78f1fd3279542ac73a9aeb548c4103f6eae0abcc9d398b1cb0a3ee2f68ca5a3).
