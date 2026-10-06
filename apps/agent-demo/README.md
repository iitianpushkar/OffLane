# OffLane agent demo

This executable demo proves the complete bidirectional flow against Tempo
Moderato:

1. Alice and Bob approve and deposit 10 PathUSD each.
2. Alice authorizes an ephemeral AI-agent key with a 3 PathUSD spending cap.
3. Alice's agent pays Bob 2 PathUSD through the OffLane relay.
4. Bob pays Alice back 1 PathUSD through the same channel.
5. The relay restarts and recovers nonce 2 from SQLite.
6. Alice's capability authorization and Bob's direct authorization settle the
   final 9/11 PathUSD state on-chain.

The demo refuses to run on any chain other than Moderato `42431`. It requires
the disposable `ALICE_PK` and `BOB_PK` values in the ignored root `.env`.

From the workspace root:

```bash
pnpm build
pnpm --filter @offlane/agent-demo start
```

It starts an isolated relay on a random local port and uses a temporary SQLite
database. Tempo Foundry submits on-chain type-`0x76` transactions with PathUSD
as the fee token; all off-chain state exchange uses `@offlane/sdk`.
