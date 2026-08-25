import { EventEmitter } from "node:events";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mdns } from "@libp2p/mdns";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { getIntercomScopeId } from "../config.ts";
import { isMessage, isMessageControl, isMessageReceipt, isSessionInfo } from "../broker/protocol.ts";
import { EXACT_SEND_FEATURE } from "../types.ts";
import type {
  Attachment,
  BrokerMessage,
  ClientMessage,
  Message,
  MessageControl,
  MessageProvenance,
  MessageReceipt,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";
import type { SendResult } from "../broker/client.ts";

const PROTOCOL = "/pi-intercom/1.0.0";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
  supersedes?: string;
  retryOf?: string;
  provenance?: MessageProvenance;
}

interface PeerSession {
  peerId: PeerId;
  session: SessionInfo;
}

type ListenAddress = ReturnType<Libp2p["getMultiaddrs"]>[number];

interface P2PAddressComponents {
  transportManager: { getAddrs(): ListenAddress[] };
  addressManager: { confirmObservedAddr(address: ListenAddress, options: { type: "transport" }): void };
}

export function confirmP2PListenAddresses(components: P2PAddressComponents): void {
  // mDNS is link-local, so addresses the transport actually listens on are safe
  // to advertise even when the LAN uses a public-range subnet.
  for (const address of components.transportManager.getAddrs()) {
    components.addressManager.confirmObservedAddr(address, { type: "transport" });
  }
}

type PeerEnvelope =
  | { type: "hello"; scopeId?: string; session: SessionInfo }
  | { type: "message"; scopeId?: string; from: SessionInfo; to: string; message: Message }
  | { type: "presence"; scopeId?: string; from: SessionInfo }
  | { type: "receipt"; scopeId?: string; from: SessionInfo; receipt: MessageReceipt }
  | { type: "control"; scopeId?: string; from: SessionInfo; control: MessageControl };

type PeerResponse =
  | { ok: true; session?: SessionInfo }
  | { ok: false; reason: string };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getP2PKey(): string {
  const key = process.env.PI_INTERCOM_P2P_KEY?.trim();
  if (!key || key.length < 16) throw new Error("PI_INTERCOM_P2P_KEY must contain at least 16 characters for the p2p transport");
  return key;
}

function serviceTag(key: string, scopeId: string | undefined): string {
  const suffix = createHash("sha256").update(`${key}\0${scopeId ?? ""}`).digest("hex").slice(0, 12);
  return `_pi-intercom-${suffix}._udp.local`;
}

async function readJson(stream: Stream): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    total += bytes.byteLength;
    if (total > MAX_MESSAGE_BYTES) throw new Error(`P2P message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    chunks.push(bytes);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(decoder.decode(data));
}

async function writeJson(stream: Stream, value: unknown): Promise<void> {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error(`P2P message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  stream.send(bytes);
  await stream.close();
}

export class P2PIntercomClient extends EventEmitter {
  private node: Libp2p | null = null;
  private _sessionId: string | null = null;
  private registration: SessionInfo | null = null;
  private readonly scopeId = getIntercomScopeId();
  private readonly key = getP2PKey();
  private readonly peers = new Map<string, PeerSession>();
  private readonly sessionByPeer = new Map<string, string>();
  private readonly inboundRoutes = new Map<string, PeerId>();
  private readonly outboundRoutes = new Map<string, PeerId>();
  private nextSenderSequence = 1;

  get sessionId(): string | null {
    return this._sessionId;
  }

  supportsFeature(feature: string): boolean {
    return feature === EXACT_SEND_FEATURE;
  }

  isConnected(): boolean {
    return Boolean(this.node?.status === "started" && this._sessionId);
  }

  async connect(session: SessionRegistration, sessionId: string = randomUUID()): Promise<void> {
    if (this.node) throw new Error("Already connected");

    const endpointEpoch = randomUUID();
    this._sessionId = sessionId;
    this.registration = { ...session, id: sessionId, endpointEpoch, trustedLocal: false };

    const node = await createLibp2p({
      start: false,
      addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [mdns({ serviceTag: serviceTag(this.key, this.scopeId) })],
    });
    this.node = node;
    await node.handle(PROTOCOL, (stream, connection) => this.handleStream(stream, connection));
    node.addEventListener("peer:discovery", (event) => {
      if (!event.detail.id.equals(node.peerId)) void this.announceToPeer(event.detail.id);
    });
    node.addEventListener("peer:connect", (event) => {
      if (!event.detail.equals(node.peerId)) void this.announceToPeer(event.detail);
    });
    node.addEventListener("peer:disconnect", (event) => this.removePeer(event.detail));
    await node.start();
    confirmP2PListenAddresses((node as Libp2p & { components: P2PAddressComponents }).components);

    const registered: BrokerMessage = { type: "registered", sessionId, features: [EXACT_SEND_FEATURE] };
    this.emit("broker_message", registered);
  }

  async disconnect(): Promise<void> {
    const node = this.node;
    if (!node) return;
    this.node = null;
    this._sessionId = null;
    this.registration = null;
    this.peers.clear();
    this.sessionByPeer.clear();
    this.inboundRoutes.clear();
    this.outboundRoutes.clear();
    await node.stop();
  }

  listSessions(): Promise<SessionInfo[]> {
    if (!this.isConnected() || !this.registration) return Promise.reject(new Error("Not connected"));
    return Promise.resolve([this.registration, ...[...this.peers.values()].map(({ session }) => session)]);
  }

  async send(to: string, options: SendOptions): Promise<SendResult> {
    const target = this.resolveTarget(to);
    const messageId = options.messageId ?? randomUUID();
    if (!target) {
      return { id: messageId, delivered: false, reason: `Session "${to}" is not currently connected.`, delivery: "failed", retryable: true, outcomeKnown: true };
    }
    if (!this.registration) throw new Error("Not connected");

    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      senderSequence: this.nextSenderSequence++,
      supersedes: options.supersedes,
      retryOf: options.retryOf,
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      provenance: options.provenance,
      content: { text: options.text, attachments: options.attachments },
    };
    const response = await this.request(target.peerId, {
      type: "message",
      scopeId: this.scopeId,
      from: this.registration,
      to: target.session.id,
      message,
    });
    if (!response.ok) {
      return { id: messageId, delivered: false, reason: response.reason, delivery: "failed", retryable: true, outcomeKnown: true };
    }
    this.outboundRoutes.set(messageId, target.peerId);
    return { id: messageId, delivered: true, delivery: "socket_delivered", retryable: false, outcomeKnown: true };
  }

  async cancelMessage(messageId: string): Promise<SendResult> {
    const peerId = this.outboundRoutes.get(messageId);
    if (!peerId || !this.registration) {
      return { id: messageId, delivered: false, reason: "Message target is no longer connected.", delivery: "failed", retryable: true, outcomeKnown: true };
    }
    const response = await this.request(peerId, {
      type: "control",
      scopeId: this.scopeId,
      from: this.registration,
      control: { messageId, action: "cancel", timestamp: Date.now() },
    });
    return response.ok
      ? { id: messageId, delivered: true, delivery: "socket_delivered", retryable: false, outcomeKnown: true }
      : { id: messageId, delivered: false, reason: response.reason, delivery: "failed", retryable: true, outcomeKnown: true };
  }

  cancelAsk(messageId: string): void {
    void this.cancelMessage(messageId).catch(() => undefined);
  }

  sendMessageReceipt(receipt: MessageReceipt): void {
    const peerId = this.inboundRoutes.get(receipt.messageId);
    if (!peerId || !this.registration) return;
    void this.request(peerId, { type: "receipt", scopeId: this.scopeId, from: this.registration, receipt }).catch(() => undefined);
  }

  updatePresence(updates: { name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }): void {
    if (!this.registration) return;
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete (this.registration as unknown as Record<string, unknown>)[key];
      else if (value !== undefined) (this.registration as unknown as Record<string, unknown>)[key] = value;
    }
    this.registration.lastActivity = Date.now();
    for (const { peerId } of this.peers.values()) {
      void this.request(peerId, { type: "presence", scopeId: this.scopeId, from: this.registration }).catch(() => undefined);
    }
  }

  updateExtensionCapabilities(_extensions: SessionRegistration["extensions"]): void {}

  sendExtensionMessage(_message: Extract<ClientMessage, { type: "extension_publish" | "extension_state_commit" }>): void {
    throw new Error("The extension bus is not supported by the p2p transport");
  }

  onBrokerMessage(handler: (message: BrokerMessage) => void): () => void {
    this.on("broker_message", handler);
    return () => this.off("broker_message", handler);
  }

  onMessageReceipt(handler: (from: SessionInfo, receipt: MessageReceipt) => void): () => void {
    this.on("message_receipt", handler);
    return () => this.off("message_receipt", handler);
  }

  onMessageControl(handler: (from: SessionInfo, control: MessageControl) => void): () => void {
    this.on("message_control", handler);
    return () => this.off("message_control", handler);
  }

  private resolveTarget(to: string): PeerSession | null {
    const sessions = [...this.peers.values()];
    const exact = sessions.find(({ session }) => session.id === to);
    if (exact) return exact;
    const named = sessions.filter(({ session }) => session.name?.toLowerCase() === to.toLowerCase());
    if (named.length === 1) return named[0]!;
    const prefixed = named.length === 0 ? sessions.filter(({ session }) => session.id.startsWith(to)) : [];
    return prefixed.length === 1 ? prefixed[0]! : null;
  }

  private async announceToPeer(peerId: PeerId): Promise<void> {
    if (!this.registration || this.sessionByPeer.has(peerId.toString())) return;
    try {
      const response = await this.request(peerId, { type: "hello", scopeId: this.scopeId, session: this.registration });
      if (response.ok && response.session) this.upsertPeer(peerId, response.session);
    } catch {
      // Discovery is best-effort; mDNS or peer:connect will retry.
    }
  }

  private sign(payload: unknown): { payload: unknown; mac: string } {
    const json = JSON.stringify(payload);
    return { payload, mac: createHmac("sha256", this.key).update(json).digest("hex") };
  }

  private verify(value: unknown): unknown {
    if (!value || typeof value !== "object") throw new Error("Invalid authenticated p2p message");
    const wire = value as { payload?: unknown; mac?: unknown };
    if (typeof wire.mac !== "string") throw new Error("Invalid authenticated p2p message");
    const expected = createHmac("sha256", this.key).update(JSON.stringify(wire.payload)).digest();
    const actual = Buffer.from(wire.mac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("P2P message authentication failed");
    return wire.payload;
  }

  private async request(peerId: PeerId, envelope: PeerEnvelope): Promise<PeerResponse> {
    const node = this.node;
    if (!node) throw new Error("Not connected");
    const stream = await node.dialProtocol(peerId, PROTOCOL);
    await writeJson(stream, this.sign(envelope));
    const response = this.verify(await readJson(stream));
    if (!response || typeof response !== "object" || typeof (response as { ok?: unknown }).ok !== "boolean") {
      throw new Error("Invalid p2p response");
    }
    return response as PeerResponse;
  }

  private async handleStream(stream: Stream, connection: Connection): Promise<void> {
    try {
      const value = this.verify(await readJson(stream));
      const response = this.handleEnvelope(value, connection.remotePeer);
      await writeJson(stream, this.sign(response));
    } catch (error) {
      try {
        await writeJson(stream, this.sign({ ok: false, reason: toError(error).message } satisfies PeerResponse));
      } catch {
        stream.abort(toError(error));
      }
    }
  }

  private handleEnvelope(value: unknown, peerId: PeerId): PeerResponse {
    if (!value || typeof value !== "object") return { ok: false, reason: "Invalid p2p message" };
    const envelope = value as Record<string, unknown>;
    if ((envelope.scopeId ?? undefined) !== this.scopeId) return { ok: false, reason: "Intercom scope mismatch" };

    if (envelope.type === "hello" && isSessionInfo(envelope.session)) {
      this.upsertPeer(peerId, envelope.session);
      return this.registration ? { ok: true, session: this.registration } : { ok: false, reason: "Not connected" };
    }
    if (envelope.type === "message" && isSessionInfo(envelope.from) && typeof envelope.to === "string" && isMessage(envelope.message)) {
      if (envelope.to !== this._sessionId) return { ok: false, reason: "Message addressed to another session" };
      this.upsertPeer(peerId, envelope.from);
      this.inboundRoutes.set(envelope.message.id, peerId);
      this.emit("message", envelope.from, envelope.message);
      return { ok: true };
    }
    if (envelope.type === "presence" && isSessionInfo(envelope.from)) {
      this.upsertPeer(peerId, envelope.from);
      const message: BrokerMessage = { type: "presence_update", session: envelope.from };
      this.emit("broker_message", message);
      this.emit("presence_update", envelope.from);
      return { ok: true };
    }
    if (envelope.type === "receipt" && isSessionInfo(envelope.from) && isMessageReceipt(envelope.receipt)) {
      this.emit("message_receipt", envelope.from, envelope.receipt);
      return { ok: true };
    }
    if (envelope.type === "control" && isSessionInfo(envelope.from) && isMessageControl(envelope.control)) {
      this.emit("message_control", envelope.from, envelope.control);
      return { ok: true };
    }
    return { ok: false, reason: "Invalid p2p message" };
  }

  private upsertPeer(peerId: PeerId, session: SessionInfo): void {
    if (session.id === this._sessionId) return;
    const peerKey = peerId.toString();
    const existing = this.peers.get(session.id);
    if (existing && !existing.peerId.equals(peerId)) this.sessionByPeer.delete(existing.peerId.toString());
    const previousSessionId = this.sessionByPeer.get(peerKey);
    if (previousSessionId && previousSessionId !== session.id) this.peers.delete(previousSessionId);
    this.peers.set(session.id, { peerId, session: { ...session, trustedLocal: false } });
    this.sessionByPeer.set(peerKey, session.id);
    if (!existing) {
      const joined: BrokerMessage = { type: "session_joined", session };
      this.emit("broker_message", joined);
      this.emit("session_joined", session);
    }
  }

  private removePeer(peerId: PeerId): void {
    const peerKey = peerId.toString();
    const sessionId = this.sessionByPeer.get(peerKey);
    if (!sessionId) return;
    this.sessionByPeer.delete(peerKey);
    this.peers.delete(sessionId);
    const left: BrokerMessage = { type: "session_left", sessionId };
    this.emit("broker_message", left);
    this.emit("session_left", sessionId);
  }
}
