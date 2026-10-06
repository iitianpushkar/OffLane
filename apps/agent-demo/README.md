# OffLane agent demo

This executable demo proves the complete bidirectional flow against Tempo
Moderato:

1. Alice and Bob approve and deposit 10 PathUSD each.
2. Alice authorizes an ephemeral AI-agent key with a 3 PathUSD spending cap.
3. Alice's agent encrypts a JSON request for Bob using dedicated X25519 keys.
4. The request hash is committed into nonce 1 while the agent pays Bob 2
   PathUSD; Bob decrypts and acknowledges it.
5. Bob encrypts a JSON response, commits it into nonce 2, and pays Alice back 1
   PathUSD; Alice's agent decrypts and acknowledges it.
6. The relay restarts and recovers nonce 2, both ciphertexts, and both
   acknowledgements from SQLite.
7. Alice's capability authorization and Bob's direct authorization settle the
   final 9/11 PathUSD state on-chain.

The demo refuses to run on any chain other than Moderato `42431`. It requires
the disposable `ALICE_PK` and `BOB_PK` values in the ignored root `.env`.

From the workspace root:

```bash
pnpm build
pnpm --filter @offlane/agent-demo start
```

It starts an isolated relay on a random local port and uses a temporary SQLite
database. The isolated indexer starts at the block captured immediately before
the demo, so it does not replay unrelated historical channels. Tempo Foundry
submits on-chain type-`0x76` transactions with PathUSD as the fee token; all
off-chain state exchange uses `@offlane/sdk`.

If any relay or SDK step fails after Bob joins, the demo signs the newest
mutually authorized state with both root test keys and cooperatively closes the
channel before returning the error. Relay startup waits up to two minutes by
default; override it with `OFFLANE_DEMO_RELAY_STARTUP_TIMEOUT_MS` when testing
against a slow RPC.
