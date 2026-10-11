import {
  channelCapabilityTypes,
  channelStateTypes,
  messagingKeyCertificateTypes,
  messagingKeyDomain,
  validateCapabilityForState,
  type Address,
  type ChannelCapability,
  type ChannelState,
  type ChannelTerms,
  type Hex,
  type MessagingKeyCertificate,
  type StateAuthorization,
} from "@offlane/protocol";
import {
  verifyMessage,
  verifyTypedData,
  type TypedDataDomain,
} from "viem";

export interface AuthorizationVerifier {
  verifyRelayChallenge(
    signer: Address,
    message: string,
    signature: Hex,
  ): Promise<boolean>;
  verifyStateAuthorization(
    terms: ChannelTerms,
    participant: Address,
    state: ChannelState,
    authorization: StateAuthorization,
  ): Promise<boolean>;
  verifyCapability(
    terms: ChannelTerms,
    referenceState: ChannelState,
    capability: ChannelCapability,
    signature: Hex,
  ): Promise<boolean>;
  verifyMessagingKeyCertificate(
    certificate: MessagingKeyCertificate,
    signature: Hex,
  ): Promise<boolean>;
  authorizationSigner(
    participant: Address,
    authorization: StateAuthorization,
  ): Address;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class ViemAuthorizationVerifier implements AuthorizationVerifier {
  constructor(private readonly domain: TypedDataDomain) {}

  async verifyRelayChallenge(
    signer: Address,
    message: string,
    signature: Hex,
  ): Promise<boolean> {
    try {
      return await verifyMessage({ address: signer, message, signature });
    } catch {
      return false;
    }
  }

  async verifyMessagingKeyCertificate(
    certificate: MessagingKeyCertificate,
    signature: Hex,
  ): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: certificate.owner,
        domain: messagingKeyDomain(this.domain),
        types: messagingKeyCertificateTypes,
        primaryType: "MessagingKeyCertificate",
        message: certificate,
        signature,
      });
    } catch {
      return false;
    }
  }

  authorizationSigner(
    participant: Address,
    authorization: StateAuthorization,
  ): Address {
    return authorization.kind === "direct"
      ? participant
      : authorization.capability.delegatedSigner;
  }

  async verifyStateAuthorization(
    terms: ChannelTerms,
    participant: Address,
    state: ChannelState,
    authorization: StateAuthorization,
  ): Promise<boolean> {
    if (authorization.kind === "direct") {
      try {
        return await verifyTypedData({
          address: participant,
          domain: this.domain,
          types: channelStateTypes,
          primaryType: "ChannelState",
          message: state,
          signature: authorization.stateSignature,
        });
      } catch {
        return false;
      }
    }

    if (!sameAddress(authorization.capability.participant, participant)) {
      return false;
    }
    const capabilityValid = await this.verifyCapability(
      terms,
      state,
      authorization.capability,
      authorization.capabilitySignature,
    );
    if (!capabilityValid) return false;
    try {
      return await verifyTypedData({
        address: authorization.capability.delegatedSigner,
        domain: this.domain,
        types: channelStateTypes,
        primaryType: "ChannelState",
        message: state,
        signature: authorization.stateSignature,
      });
    } catch {
      return false;
    }
  }

  async verifyCapability(
    terms: ChannelTerms,
    referenceState: ChannelState,
    capability: ChannelCapability,
    signature: Hex,
  ): Promise<boolean> {
    try {
      validateCapabilityForState(terms, capability, referenceState);
      return await verifyTypedData({
        address: capability.participant,
        domain: this.domain,
        types: channelCapabilityTypes,
        primaryType: "ChannelCapability",
        message: capability,
        signature,
      });
    } catch {
      return false;
    }
  }
}
