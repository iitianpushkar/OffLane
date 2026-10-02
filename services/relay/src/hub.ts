import type { Address, RpcMessage } from "@offlane/protocol";

export interface RelaySession {
  id: string;
  signer: Address | undefined;
  participants: Set<string>;
  send(message: RpcMessage): void;
}

export class SessionHub {
  private readonly sessions = new Map<string, RelaySession>();

  authenticate(session: RelaySession, signer: Address): void {
    session.signer = signer;
    session.participants.clear();
    this.sessions.set(session.id, session);
  }

  authorizeParticipant(session: RelaySession, participant: Address): void {
    session.participants.add(participant.toLowerCase());
  }

  isAuthorized(session: RelaySession, participant: Address): boolean {
    return (
      session.signer?.toLowerCase() === participant.toLowerCase() ||
      session.participants.has(participant.toLowerCase())
    );
  }

  remove(session: RelaySession): void {
    this.sessions.delete(session.id);
  }

  publish(signer: Address, message: RpcMessage): void {
    for (const session of this.sessions.values()) {
      if (
        session.signer?.toLowerCase() === signer.toLowerCase() ||
        session.participants.has(signer.toLowerCase())
      ) {
        try {
          session.send(message);
        } catch {
          this.sessions.delete(session.id);
        }
      }
    }
  }
}
