import { DatabaseSync } from "node:sqlite";
import {
  encodeChannelState,
  encodeStateAuthorization,
  channelStateWireSchema,
  stateAuthorizationWireSchema,
  stateProposalWireSchema,
  type Address,
  type Bytes32,
  type StateAcceptanceMessage,
} from "@offlane/protocol";
import type {
  IndexerCursor,
  PendingProposal,
  RelayChannel,
  RelayChannelStatus,
  RelayStore,
} from "./store.js";

interface ChannelRow {
  participant_a: string;
  participant_b: string;
  token: string;
  status: string;
  current_state: string;
  authorization_a: string | null;
  authorization_b: string | null;
}

interface ProposalRow {
  proposal: string;
  created_at: number;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function encodeChannel(channel: RelayChannel): {
  currentState: string;
  authorizationA: string | null;
  authorizationB: string | null;
} {
  return {
    currentState: stringify(encodeChannelState(channel.current)),
    authorizationA: channel.authorizationA
      ? stringify(encodeStateAuthorization(channel.authorizationA))
      : null,
    authorizationB: channel.authorizationB
      ? stringify(encodeStateAuthorization(channel.authorizationB))
      : null,
  };
}

function decodeChannel(row: ChannelRow): RelayChannel {
  const state = channelStateWireSchema.parse(JSON.parse(row.current_state));
  const authorizationA = row.authorization_a
    ? stateAuthorizationWireSchema.parse(JSON.parse(row.authorization_a))
    : undefined;
  const authorizationB = row.authorization_b
    ? stateAuthorizationWireSchema.parse(JSON.parse(row.authorization_b))
    : undefined;

  return {
    participantA: row.participant_a as Address,
    participantB: row.participant_b as Address,
    token: row.token as Address,
    status: row.status as RelayChannelStatus,
    current: state,
    ...(authorizationA ? { authorizationA } : {}),
    ...(authorizationB ? { authorizationB } : {}),
  };
}

function encodeProposal(pending: PendingProposal): string {
  return stringify({
    ...pending.proposal,
    state: encodeChannelState(pending.proposal.state),
    authorization: encodeStateAuthorization(pending.proposal.authorization),
  });
}

function decodeProposal(row: ProposalRow): PendingProposal {
  return {
    proposal: stateProposalWireSchema.parse(JSON.parse(row.proposal)),
    createdAt: row.created_at,
  };
}

export class SqliteRelayStore implements RelayStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL,
        participant_b TEXT NOT NULL,
        token TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closing')),
        current_state TEXT NOT NULL,
        authorization_a TEXT,
        authorization_b TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_proposals (
        proposal_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE REFERENCES channels(channel_id) ON DELETE CASCADE,
        proposal TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS indexer_cursors (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        last_block TEXT NOT NULL,
        PRIMARY KEY (chain_id, contract_address)
      );
    `);
  }

  async getChannel(channelId: Bytes32): Promise<RelayChannel | undefined> {
    const row = this.database
      .prepare(`
        SELECT participant_a, participant_b, token, status, current_state,
               authorization_a, authorization_b
        FROM channels WHERE channel_id = ?
      `)
      .get(channelId.toLowerCase()) as ChannelRow | undefined;
    return row ? decodeChannel(row) : undefined;
  }

  async saveChannel(channel: RelayChannel): Promise<void> {
    const encoded = encodeChannel(channel);
    this.database
      .prepare(`
        INSERT INTO channels (
          channel_id, participant_a, participant_b, token, status,
          current_state, authorization_a, authorization_b, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          participant_a = excluded.participant_a,
          participant_b = excluded.participant_b,
          token = excluded.token,
          status = excluded.status,
          current_state = excluded.current_state,
          authorization_a = excluded.authorization_a,
          authorization_b = excluded.authorization_b,
          updated_at = excluded.updated_at
      `)
      .run(
        channel.current.channelId.toLowerCase(),
        channel.participantA.toLowerCase(),
        channel.participantB.toLowerCase(),
        channel.token.toLowerCase(),
        channel.status,
        encoded.currentState,
        encoded.authorizationA,
        encoded.authorizationB,
        Date.now(),
      );
  }

  async deleteChannel(channelId: Bytes32): Promise<void> {
    this.database
      .prepare("DELETE FROM channels WHERE channel_id = ?")
      .run(channelId.toLowerCase());
  }

  async createChannelFromChain(channel: RelayChannel): Promise<void> {
    const encoded = encodeChannel(channel);
    this.database
      .prepare(`
        INSERT OR IGNORE INTO channels (
          channel_id, participant_a, participant_b, token, status,
          current_state, authorization_a, authorization_b, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        channel.current.channelId.toLowerCase(),
        channel.participantA.toLowerCase(),
        channel.participantB.toLowerCase(),
        channel.token.toLowerCase(),
        channel.status,
        encoded.currentState,
        encoded.authorizationA,
        encoded.authorizationB,
        Date.now(),
      );
  }

  async markChannelOpen(channelId: Bytes32, balanceB: bigint): Promise<void> {
    const row = this.database
      .prepare("SELECT current_state FROM channels WHERE channel_id = ?")
      .get(channelId.toLowerCase()) as { current_state: string } | undefined;
    if (!row) return;
    const current = channelStateWireSchema.parse(JSON.parse(row.current_state));
    const next = current.nonce === 0n ? { ...current, balanceB } : current;
    this.database
      .prepare(`
        UPDATE channels SET status = 'open', current_state = ?, updated_at = ?
        WHERE channel_id = ?
      `)
      .run(
        stringify(encodeChannelState(next)),
        Date.now(),
        channelId.toLowerCase(),
      );
  }

  async markChannelClosing(channelId: Bytes32): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          UPDATE channels SET status = 'closing', updated_at = ?
          WHERE channel_id = ?
        `)
        .run(Date.now(), channelId.toLowerCase());
      this.database
        .prepare("DELETE FROM pending_proposals WHERE channel_id = ?")
        .run(channelId.toLowerCase());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getPendingByChannel(channelId: Bytes32): Promise<PendingProposal | undefined> {
    const row = this.database
      .prepare("SELECT proposal, created_at FROM pending_proposals WHERE channel_id = ?")
      .get(channelId.toLowerCase()) as ProposalRow | undefined;
    return row ? decodeProposal(row) : undefined;
  }

  async getPending(proposalId: Bytes32): Promise<PendingProposal | undefined> {
    const row = this.database
      .prepare("SELECT proposal, created_at FROM pending_proposals WHERE proposal_id = ?")
      .get(proposalId.toLowerCase()) as ProposalRow | undefined;
    return row ? decodeProposal(row) : undefined;
  }

  async savePending(pending: PendingProposal): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const channel = this.database
        .prepare("SELECT status FROM channels WHERE channel_id = ?")
        .get(pending.proposal.state.channelId.toLowerCase()) as
        | { status: string }
        | undefined;
      if (!channel || channel.status !== "open") {
        throw new Error("channel changed before proposal commit");
      }
      this.database
        .prepare("DELETE FROM pending_proposals WHERE channel_id = ?")
        .run(pending.proposal.state.channelId.toLowerCase());
      this.database
        .prepare(`
          INSERT INTO pending_proposals (proposal_id, channel_id, proposal, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          pending.proposal.proposalId.toLowerCase(),
          pending.proposal.state.channelId.toLowerCase(),
          encodeProposal(pending),
          pending.createdAt,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async deletePending(proposalId: Bytes32): Promise<void> {
    this.database
      .prepare("DELETE FROM pending_proposals WHERE proposal_id = ?")
      .run(proposalId.toLowerCase());
  }

  async commitAccepted(
    channel: RelayChannel,
    proposalId: Bytes32,
    acceptance: StateAcceptanceMessage,
  ): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const pendingRow = this.database
        .prepare("SELECT proposal, created_at FROM pending_proposals WHERE proposal_id = ?")
        .get(proposalId.toLowerCase()) as ProposalRow | undefined;
      if (!pendingRow) throw new Error("pending proposal disappeared before commit");
      const pending = decodeProposal(pendingRow);
      const tracked = this.database
        .prepare("SELECT status, current_state FROM channels WHERE channel_id = ?")
        .get(channel.current.channelId.toLowerCase()) as
        | { status: string; current_state: string }
        | undefined;
      if (
        !tracked ||
        tracked.status !== "open" ||
        tracked.current_state !== stringify(encodeChannelState(channel.current))
      ) {
        throw new Error("channel changed before acceptance commit");
      }
      const proposerIsA =
        pending.proposal.proposer.toLowerCase() === channel.participantA.toLowerCase();
      const next: RelayChannel = {
        ...channel,
        current: pending.proposal.state,
        authorizationA: proposerIsA
          ? pending.proposal.authorization
          : acceptance.authorization,
        authorizationB: proposerIsA
          ? acceptance.authorization
          : pending.proposal.authorization,
      };
      const encoded = encodeChannel(next);
      this.database
        .prepare(`
          UPDATE channels SET current_state = ?, authorization_a = ?,
            authorization_b = ?, updated_at = ? WHERE channel_id = ?
        `)
        .run(
          encoded.currentState,
          encoded.authorizationA,
          encoded.authorizationB,
          Date.now(),
          channel.current.channelId.toLowerCase(),
        );
      this.database
        .prepare("DELETE FROM pending_proposals WHERE proposal_id = ?")
        .run(proposalId.toLowerCase());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getIndexerCursor(
    chainId: number,
    contractAddress: Address,
  ): Promise<bigint | undefined> {
    const row = this.database
      .prepare(`
        SELECT last_block FROM indexer_cursors
        WHERE chain_id = ? AND contract_address = ?
      `)
      .get(chainId, contractAddress.toLowerCase()) as
      | { last_block: string }
      | undefined;
    return row ? BigInt(row.last_block) : undefined;
  }

  async setIndexerCursor(cursor: IndexerCursor): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO indexer_cursors (chain_id, contract_address, last_block)
        VALUES (?, ?, ?)
        ON CONFLICT(chain_id, contract_address)
        DO UPDATE SET last_block = excluded.last_block
      `)
      .run(
        cursor.chainId,
        cursor.contractAddress.toLowerCase(),
        cursor.lastBlock.toString(),
      );
  }

  close(): void {
    this.database.close();
  }
}
