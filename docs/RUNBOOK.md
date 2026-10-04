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

The deployment listed as previous in `contracts/README.md` predates agent
capabilities. Deploy the current source and record both the contract address
and deployment block.

```bash
cd contracts
export TEMPO_TESTNET_RPC_URL='YOUR_MODERATO_RPC_URL'

forge create src/ChannelManager.sol:ChannelManager \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  --interactive \
  --broadcast
```

Use the transaction hash printed by `forge create` to retrieve the deployment
block if it is not printed directly:

```bash
cast receipt DEPLOYMENT_TRANSACTION_HASH \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  blockNumber
```

## Start the indexed relay

From the repository root:

```bash
export OFFLANE_CHAIN_ID=42431
export OFFLANE_CHANNEL_MANAGER='DEPLOYED_CHANNEL_MANAGER_ADDRESS'
export OFFLANE_DEPLOYMENT_BLOCK='DEPLOYMENT_BLOCK_NUMBER'
export OFFLANE_RPC_URL='YOUR_MODERATO_RPC_URL'
export OFFLANE_DATABASE_PATH='./offlane-relay.sqlite'
export OFFLANE_CONFIRMATIONS=2
export HOST=127.0.0.1
export PORT=7824

pnpm --filter @offlane/relay start
```

Startup first replays confirmed `ChannelManager` events into SQLite. It then
serves:

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
TIP-20.

```bash
cd contracts

read -s "ALICE_PK?Alice private key: "
export ALICE_PK
echo
read -s "BOB_PK?Bob private key: "
export BOB_PK
echo

export CHANNEL_MANAGER='DEPLOYED_CHANNEL_MANAGER_ADDRESS'
export PATHUSD='MODERATO_PATHUSD_ADDRESS'

forge script script/SmokeTest.s.sol:SmokeTest \
  --rpc-url "$TEMPO_TESTNET_RPC_URL" \
  --broadcast \
  -vvvv

unset ALICE_PK BOB_PK
```

The smoke script closes the channel, so the indexer will remove it after the
configured confirmation depth. Use a separate open channel for relay SDK
experiments.
