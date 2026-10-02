# Nitrolite reference map

OffLane uses Layer-3's Nitrolite implementation as a source-level reference,
not only as a general architecture analogy. The reference reviewed for this
step was Nitrolite commit `111b7e5b03f9bed3faa6558ae4b88f3965301709`.

## What OffLane adopts

| Nitrolite source | Pattern adopted in OffLane | OffLane implementation |
| --- | --- | --- |
| [`sdk/ts/src/rpc/message.ts`](https://github.com/layer-3/nitrolite/blob/111b7e5b03f9bed3faa6558ae4b88f3965301709/sdk/ts/src/rpc/message.ts) | Compact `[type, requestId, method, payload, timestamp]` JSON frames | `packages/protocol/src/rpc.ts` |
| [`sdk/ts/src/rpc/dialer.ts`](https://github.com/layer-3/nitrolite/blob/111b7e5b03f9bed3faa6558ae4b88f3965301709/sdk/ts/src/rpc/dialer.ts) | Transport boundary, pending-request correlation, unsolicited events, cancellation | `packages/sdk/src/transport.ts`, `packages/sdk/src/client.ts` |
| [`sdk/ts/src/rpc/methods.ts`](https://github.com/layer-3/nitrolite/blob/111b7e5b03f9bed3faa6558ae4b88f3965301709/sdk/ts/src/rpc/methods.ts) | Versioned method names grouped by domain | `node.v1.*`, `channels.v1.*` |
| [`sdk/ts/src/signers.ts`](https://github.com/layer-3/nitrolite/blob/111b7e5b03f9bed3faa6558ae4b88f3965301709/sdk/ts/src/signers.ts) | Signing authority is an SDK boundary rather than relay-owned key material | Existing `StateAuthorization`; signer adapters are the next SDK slice |
| [`nitronode`](https://github.com/layer-3/nitrolite/tree/111b7e5b03f9bed3faa6558ae4b88f3965301709/nitronode) | Relay as persistent coordinator and chain-event observer | Planned `services/relay` package |

## What differs intentionally

| Nitrolite | OffLane |
| --- | --- |
| User-to-node ledger with node countersignatures | Direct two-party channel; both participants authorize the same cumulative state |
| Home/escrow channels and cross-chain migration | One Tempo channel and one TIP-20 collateral token for the hackathon scope |
| Compound session-key signature format selected by a prefix byte | Root-signed EIP-712 `ChannelCapability` plus a separate delegated state signature, matching `ChannelManager` |
| Session-key asset/application scope and expiry | Channel, counterparty, token, baseline, and maximum-net-spend scope; operational expiry stays client-side so dispute evidence remains valid |
| Node-driven transition enum and cumulative net-flow ledger | Strictly increasing nonce and conserved `balanceA + balanceB`; either participant can pay |

## Current wire boundary

Messages use a strict five-element frame:

```text
[messageType, requestId, method, payload, timestampMs]
```

Message types are request, response, event, and error. Request IDs are safe
non-negative JavaScript integers. Methods are allowlisted and versioned.
Big integer channel fields remain canonical decimal strings inside payloads.

The initial method surface is:

- `node.v1.ping`
- `channels.v1.propose_state`
- `channels.v1.accept_state`
- `channels.v1.reject_state`
- `channels.v1.get_state`
- `channels.v1.state_updated`

The next relay step must use these protocol schemas directly and add a drift
test so the relay router and SDK cannot silently disagree about method names.
