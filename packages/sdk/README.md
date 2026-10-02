# @offlane/sdk

Transport-independent client primitives for OffLane relays.

The RPC layer follows Nitrolite's compact five-element frame and separates the
WebSocket transport from request correlation. OffLane uses versioned methods and
strict runtime validation, while its payloads carry the two-party
`ChannelState` and either direct or channel-capability authorization.

```ts
const client = new OfflaneClient(
  new WebSocketTransport("wss://relay.example/ws"),
);

await client.connect();
await client.proposeState({
  proposalId,
  proposer,
  baseStateHash,
  state,
  authorization,
});
```

`proposeState` is direction-neutral. Participant A or participant B may be the
proposer and payer; the state balances determine the payment direction.
