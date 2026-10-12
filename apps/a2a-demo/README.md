# OffLane exported-credential A2A demo

This CLI consumes two plaintext agent credential files exported by the
dashboard. It validates their wallet signatures and channel relationship,
authenticates both delegated agents with the relay, exchanges encrypted A2A
messages, and commits one payment in each direction.

Both participants must export credentials for the same open channel. When each
participant selects **Download JSON** in the local dashboard, the dashboard
also saves role-based copies as `credentials/agent-a.json` and
`credentials/agent-b.json`. Keep the relay running, build the workspace, and
invoke the demo from the repository root without file arguments:

```bash
pnpm build
pnpm a2a
```

Explicit credential paths remain supported:

```bash
pnpm a2a -- ~/Downloads/offlane-agent-alice.json ~/Downloads/offlane-agent-bob.json
```

The default transfers are `0.10` PathUSD from participant A to B and `0.05`
PathUSD from B to A. Override them with two additional arguments:

```bash
pnpm a2a -- alice.json bob.json 0.25 0.10
```

The files contain delegated and messaging private keys. This demo rejects
non-Moderato exports and never submits an on-chain transaction.
