import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Address,
  Bytes32,
  ChannelState,
  StateAcceptanceMessage,
  StateProposalMessage,
} from "@offlane/protocol";
import { describe, expect, it } from "vitest";
import { SqliteRelayStore } from "./sqlite-store.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const TOKEN = "0x0000000000000000000000000000000000000020" as Address;
const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const PROPOSAL = `0x${"22".repeat(32)}` as Bytes32;
const EMPTY_HASH = `0x${"00".repeat(32)}` as Bytes32;

describe("SqliteRelayStore", () => {
  it("persists pending and fully accepted states across restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offlane-relay-"));
    const path = join(directory, "relay.sqlite");
    const initial: ChannelState = {
      channelId: CHANNEL,
      nonce: 0n,
      balanceA: 100n,
      balanceB: 100n,
      appDataHash: EMPTY_HASH,
    };
    const next: ChannelState = {
      ...initial,
      nonce: 1n,
      balanceA: 90n,
      balanceB: 110n,
    };
    const proposal: StateProposalMessage = {
      proposalId: PROPOSAL,
      proposer: A,
      baseStateHash: EMPTY_HASH,
      state: next,
      authorization: { kind: "direct", stateSignature: "0x1234" },
    };
    const acceptance: StateAcceptanceMessage = {
      proposalId: PROPOSAL,
      accepter: B,
      state: next,
      authorization: { kind: "direct", stateSignature: "0xabcd" },
    };

    try {
      let store = new SqliteRelayStore(path);
      await store.saveChannel({
        participantA: A,
        participantB: B,
        token: TOKEN,
        status: "open",
        current: initial,
      });
      await store.savePending({ proposal, createdAt: 123 });
      await store.setIndexerCursor({
        chainId: 42431,
        contractAddress: A,
        lastBlock: 99n,
      });
      store.close();

      store = new SqliteRelayStore(path);
      expect(await store.getPending(PROPOSAL)).toEqual({
        proposal,
        createdAt: 123,
      });
      expect(await store.getIndexerCursor(42431, A)).toBe(99n);
      const channel = await store.getChannel(CHANNEL);
      expect(channel?.current).toEqual(initial);
      await store.commitAccepted(channel!, PROPOSAL, acceptance);
      store.close();

      store = new SqliteRelayStore(path);
      const restored = await store.getChannel(CHANNEL);
      expect(restored?.current).toEqual(next);
      expect(restored?.authorizationA).toEqual(proposal.authorization);
      expect(restored?.authorizationB).toEqual(acceptance.authorization);
      expect(await store.getPending(PROPOSAL)).toBeUndefined();
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
