# Relay integration guide — `ChannelManager`

This is the handoff spec for implementing the **relay node**. The relay is a
separate, out-of-repo component; this doc describes the contract surface it
integrates with, so someone can build it without reading `ChannelManager.sol`
line by line. If anything here disagrees with `src/ChannelManager.sol`, the
contract is the source of truth — re-check before implementing.

## Scope boundary

**This repo builds only the contracts.** The relay, client SDK, and
encrypted-messaging transport are out of scope here and unbuilt.

The trust boundary is strict: the contract holds collateral and enforces
settlement; the relay only transports signed messages and submits
transactions. The relay **never signs on a participant's behalf** and
**cannot move funds without a participant's own signature + their own TIP-20
allowance**. Every function below that the relay calls checks a signature
against `intent.participantA/B` (or the channel's stored participants), not
`msg.sender` — so the relay can pay gas and broadcast, but can't forge
consent.

## Chain facts (see `../DESIGN.md` §2 for full detail)

- No native gas token — never expect `msg.value` to carry a real amount.
- TIP-20 tokens are always **6 decimals**. Don't assume 18.
- Mainnet chain id `4217`, testnet "Moderato" chain id `42431`.
- Signatures are verified through Tempo's TIP-1020 precompile, which accepts
  secp256k1, P256, and WebAuthn/passkey signatures — participants aren't
  limited to raw ECDSA keys.
- Delegated/session signing keys go through Tempo's native Account Keychain
  precompile, not a field on the contract itself — see "Delegated signing
  keys" below.

## EIP-712 domain

```
name:    "Tempo.ChannelManager"
version: "1"
chainId: <the chain the contract is deployed on>
verifyingContract: <ChannelManager address>
```

Standard OpenZeppelin `EIP712` domain separator — derive it the normal way
(`eth_signTypedData_v4` or equivalent) once the contract address is known.

## Typed data structs

Both structs below must be encoded **exactly** as written — the typehash is
a literal string hash, so field order/types/names must match char-for-char.

### `ChannelIntent` — the open/join agreement

```solidity
struct ChannelIntent {
    uint8 protocolVersion;      // must equal PROTOCOL_VERSION (currently 1)
    address participantA;
    address participantB;
    address token;              // TIP-20 collateral token
    uint128 depositA;
    uint128 depositB;
    uint32 challengeDuration;   // seconds; 1 hour <= x <= 30 days
    uint32 validUntil;          // unix timestamp; open/join must happen before this
    uint256 salt;                // uniqueness — pick a fresh random value per channel
}
```

typehash string:
```
ChannelIntent(uint8 protocolVersion,address participantA,address participantB,address token,uint128 depositA,uint128 depositB,uint32 challengeDuration,uint32 validUntil,uint256 salt)
```

**Changed 2026-09-30**: this struct used to also carry `authorizedSignerA`/
`authorizedSignerB` address fields for delegated session keys. Those are
gone — delegated signing now goes entirely through Tempo's native Account
Keychain precompile instead, tracked nowhere in this contract. See
"Delegated signing keys" below; if you built against the old shape, drop
those two fields from every struct construction, hash, and signature you
produce, or your signatures won't match the new typehash.

**`ChannelIntent` is never stored on-chain in full.** Only its derived
`channelId` and resulting balances/status are. The relay (or client) must
hold onto the full `ChannelIntent` struct itself — it's required as calldata
again for `joinChannel` and `cancelUnjoined`.

### `ChannelState` — a signed balance snapshot

```solidity
struct ChannelState {
    bytes32 channelId;
    uint64 nonce;         // strictly increasing per channel
    uint128 balanceA;
    uint128 balanceB;
    bytes32 appDataHash;  // opaque — bind this to e.g. an encrypted message reference
}
```

typehash string:
```
ChannelState(bytes32 channelId,uint64 nonce,uint128 balanceA,uint128 balanceB,bytes32 appDataHash)
```

Every off-chain payment is just both participants signing a new
`ChannelState` with an incremented `nonce` and updated balances
(`balanceA + balanceB` must always equal the channel's total funded
collateral — the contract enforces this on every on-chain transition, but
the relay should sanity-check it before forwarding a state, to fail fast).

`appDataHash` is where message-binding lives: if a payment is tied to an
encrypted message, hash that message (or its ciphertext/receipt) and put it
here. The contract never interprets this field — it's opaque to
`ChannelManager`, purely for the relay/client's own binding logic.

### Deriving `channelId`

```
structHash = keccak256(abi.encode(CHANNEL_INTENT_TYPEHASH, <all 9 intent fields in order>))
channelId  = keccak256(abi.encode(structHash, chainId, verifyingContract))
```

Note this is **not** the same as the EIP-712 signing digest
(`_hashTypedDataV4(structHash)`) — `channelId` uses the raw struct hash
directly, salted with chain id + contract address, so it's stable and
computable off-chain without needing the domain separator's type prefix.
The contract exposes a view helper so you don't have to reimplement this:

```solidity
function computeChannelId(ChannelIntent calldata intent) external view returns (bytes32)
```

Call this (or replicate the formula) to know a channel's id before it's
opened, e.g. to key local relay state.

## Full lifecycle

### 1. Open

Off-chain: A and B agree on a `ChannelIntent`, both sign it (A signs first,
typically). Relay's job: transport the proposed intent from A to B (or
however negotiation happens), then submit:

```solidity
function openChannel(ChannelIntent calldata intent, bytes calldata signatureA)
    external returns (bytes32 channelId)
```

- Requires **A's** signature over the intent (EIP-712 digest via
  `_hashTypedDataV4`).
- Pulls `depositA` from A via `token.transferFrom(A, contract, depositA)` —
  **A must have already approved the contract for at least `depositA`**.
  The relay should verify this allowance exists before submitting, or the
  tx reverts and wastes gas.
- Anyone can be `msg.sender` (relay-submittable) — the contract checks the
  signature, not the caller.
- Channel status becomes `PENDING`.
- Emits `ChannelOpened(channelId, participantA, participantB, token, depositA, depositB, challengeDuration, validUntil)`.

### 2. Join

```solidity
function joinChannel(ChannelIntent calldata intent, bytes calldata signatureB) external
```

- Same `intent` struct as open (relay must have kept it, or recomputed it
  identically — any mismatch fails to match the stored channel and reverts).
- Requires **B's** signature.
- Pulls `depositB` from B the same way.
- Channel status becomes `OPEN` — off-chain payments (signed `ChannelState`
  updates) can now happen, transported entirely by the relay, no on-chain
  activity needed per payment.
- Emits `ChannelJoined(channelId, depositB)`.

### 2b. Cancel if B never joins

```solidity
function cancelUnjoined(ChannelIntent calldata intent) external
```

Permissionless, callable by anyone once `block.timestamp >= intent.validUntil`
and the channel is still `PENDING`. Refunds A's deposit. The relay should
watch for expired-and-unjoined channels and call this as a courtesy keeper
action (funds always return to the correct participant regardless of caller).
Emits `ChannelCancelled(channelId)`.

### 3. Off-chain payments (no contract interaction)

Participants exchange signed `ChannelState`s directly (nonce increasing,
balances re-summing to the same total, optionally binding `appDataHash` to a
message). The relay's core steady-state job is purely transport here — no
transactions, just message passing between the two participants' clients.
The relay should keep the latest fully-signed state it has seen for every
open channel it's involved in, since it needs it for step 5.

### 4. Cooperative close (happy path)

```solidity
function cooperativeClose(ChannelState calldata state, bytes calldata signatureA, bytes calldata signatureB) external
```

- Requires **both** signatures over the final agreed state.
- Settles immediately: pays out `balanceA`/`balanceB`, deletes the channel.
- Works from `OPEN` or `CLOSING` — either party can short-circuit an
  in-progress unilateral close if they'd rather just finish cooperatively.
- Emits `ChannelSettled(channelId, payoutA, payoutB)`.
- This is the expected end state for a channel that closes amicably — the
  relay submits it once both signatures are collected.

### 5. Unilateral close + dispute (unhappy path)

If a counterparty goes silent or refuses to cooperatively close, either
party (or the relay on their behalf) calls:

```solidity
function initiateClose(ChannelState calldata state, bytes calldata signatureA, bytes calldata signatureB) external
```

with the latest mutually-signed state they have. This requires **both**
signatures too (any valid past mutually-signed state works, not just the
newest) — it starts a challenge window of `challengeDuration` seconds.
Emits `CloseInitiated(channelId, nonce, balanceA, balanceB, challengeExpireAt)`.

**This is the relay's most important liveness responsibility.** If the
relay is holding a *newer* mutually-signed state than the one used to
initiate close (e.g. the counterparty tried to close with a stale, more
favorable-to-them state), it must call:

```solidity
function challenge(ChannelState calldata newerState, bytes calldata signatureA, bytes calldata signatureB) external
```

before `challengeExpireAt`. Requires `newerState.nonce > ch.nonce` and both
signatures. Each successful challenge resets the window, giving the other
side a fair chance to respond in turn. Emits
`StateChallenged(channelId, nonce, balanceA, balanceB, challengeExpireAt)`.

Once the window passes with no further challenge, anyone can finalize:

```solidity
function finalizeClose(bytes32 channelId) external
```

Permissionless keeper call — pays out the last recorded state, deletes the
channel, emits `ChannelSettled`. The relay should watch `CloseInitiated`/
`StateChallenged` events and call this once `challengeExpireAt` has passed,
so payouts don't sit stuck waiting for a participant to notice.

## TIP-403 receive-policy edge case

A payout via `_payout` can be silently redirected if the recipient has a
TIP-403 receive policy configured — the TIP-20 `transfer` call returns
`true` but the funds land in Tempo's `ReceivePolicyGuard` instead of the
recipient. The contract detects this (balance-before/after check) and:

- Tracks the shortfall in `getBlockedPayout(channelId, participant)`.
- Emits `PayoutBlocked(channelId, participant, token, amount)`.

The relay should watch for this event and, if it fires, let the affected
participant know they need to reclaim via:

```solidity
function rescueBlockedPayout(bytes32 channelId, address token, bytes calldata receipt, address to) external
```

`receipt` is the ABI-encoded `IReceivePolicyGuard.ClaimReceiptV1` witness —
obtained by indexing the token's `TransferBlocked` event on
`ReceivePolicyGuard` (the guard doesn't enumerate receipts on-chain, so this
requires an indexer). Permissionless if `to == participant`; otherwise
requires `msg.sender == participant`. Emits `BlockedPayoutRescued`.

## Events to index (full list)

| Event | When |
|---|---|
| `ChannelOpened(channelId, participantA, participantB, token, depositA, depositB, challengeDuration, validUntil)` | after `openChannel` |
| `ChannelJoined(channelId, depositB)` | after `joinChannel` |
| `ChannelCancelled(channelId)` | after `cancelUnjoined` |
| `CloseInitiated(channelId, nonce, balanceA, balanceB, challengeExpireAt)` | after `initiateClose` |
| `StateChallenged(channelId, nonce, balanceA, balanceB, challengeExpireAt)` | after `challenge` |
| `ChannelSettled(channelId, payoutA, payoutB)` | after `cooperativeClose` or `finalizeClose` |
| `PayoutBlocked(channelId, participant, token, amount)` | a payout got redirected by a receive policy |
| `BlockedPayoutRescued(channelId, participant, token, amount, to)` | after `rescueBlockedPayout` |

## Read-only helpers

```solidity
function getChannel(bytes32 channelId) external view returns (Channel memory)
function computeChannelId(ChannelIntent calldata intent) external view returns (bytes32)
function getBlockedPayout(bytes32 channelId, address participant) external view returns (uint128)
```

`Channel` (the returned struct) includes `status` (`VOID`/`PENDING`/`OPEN`/
`CLOSING`), both participants, token, and current `nonce`/balances/
`challengeExpireAt` — everything the relay needs to reconcile its own view
against on-chain truth without replaying every event from genesis. (It no
longer carries any delegated-signer fields — see below.)

## Delegated signing keys — Tempo Account Keychain

**Changed 2026-09-30**: there is no `authorizedSigner` field on this
contract anymore. Delegated/session signing keys are handled entirely
through Tempo's native **Account Keychain** precompile
(`https://docs.tempo.xyz/developers/docs/protocol/transactions/AccountKeychain`,
fixed address `0xaAAAaaAA00000000000000000000000000000000`), which the
relay/client SDK talks to directly — this contract only ever *reads* from
it, never writes.

**How a participant delegates a session key** (entirely outside this
contract, from their own wallet):

```solidity
function authorizeKey(address keyId, SignatureType signatureType, KeyRestrictions calldata config) external
```

called on the Account Keychain precompile, where `keyId` is the delegated
key's address and `config.expiry` sets when it stops working. The
participant can revoke it early at any time with `revokeKey(keyId)`.

**How this contract checks it**: when verifying a signature against
`participant`, `_isValidSignature` first tries the participant's own
address via TIP-1020 `recover`; if that doesn't match, it calls
`ACCOUNT_KEYCHAIN.getKey(participant, recoveredSigner)` and accepts the
signature only if the returned key is **not revoked and not expired**
(`!isRevoked && block.timestamp < expiry`). This applies uniformly to every
signature check in the contract — open, join, cooperative close, initiate
close, challenge.

**What this does and does not give you:**
- ✅ Real, chain-enforced expiry and instant revocation. A participant
  revokes a compromised session key from their wallet and it stops working
  in every open channel immediately — nothing to do on this contract's side.
- ❌ **No automatic per-channel spend cap.** Account Keychain's spending
  limits and call scopes are enforced by Tempo's protocol only for a key's
  *own direct* on-chain TIP-20 `transfer`/`transferWithMemo`/`approve` calls
  as a transaction signer — they do not apply to an arbitrary off-chain-signed
  `ChannelState` this contract verifies independently. If a relay/client
  needs to bound how much a delegated key can authorize within a channel,
  that has to be enforced at the relay/SDK layer (e.g. refuse to countersign
  or forward a state that exceeds an agreed cap) — this contract does not do
  it for you.
- The relay doesn't need to construct or sign anything for this — it just
  needs to accept signatures from whichever key the client hands it (their
  root key or a delegated one) and pass them straight through. If a
  signature that used to work suddenly gets rejected with `InvalidSignature`,
  check whether the signing key was revoked or expired before assuming
  something else broke.

## Errors the relay should handle gracefully

`InvalidProtocolVersion`, `InvalidParticipants`, `InvalidToken`,
`InvalidChallengeDuration`, `IntentExpired`, `IntentNotYetValid`,
`ChannelAlreadyExists`, `ChannelNotPending`, `ChannelNotOpen`,
`ChannelNotClosing`, `InvalidSignature`, `StaleNonce`, `NotNewerNonce`,
`BalanceSumMismatch`, `ChallengeWindowActive`, `ChallengeWindowExpired`,
`TransferFailed`, `ReceiptMismatch`, `NotAuthorizedToRedirect`,
`NoBlockedPayout`.

Most of these are avoidable by the relay pre-validating before submitting
(e.g. checking nonce/balance-sum/expiry locally first) rather than
discovering them from a reverted transaction.

## What the relay must never do

- Never construct or sign a `ChannelIntent`/`ChannelState` on a
  participant's behalf — it has no keys for either participant. If a
  participant has delegated a session key to it via Tempo's Account
  Keychain (see above), that's the one exception, and only within the
  expiry/revocation the participant set — the relay does not get to decide
  when that delegation ends, the participant does, from their own wallet.
- Never assume a `transfer`/`transferFrom` call reverting means "nothing
  happened" without also checking for the TIP-403 redirect case.
- Never trust a self-reported balance over the contract's `getChannel`
  view — reconcile against on-chain state, especially after any dispute
  event.
