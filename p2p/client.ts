import { EventEmitter } from "node:events";
import { WATCH_FEATURE, WATCH_TIMEOUT, validateWatchRequest, validWatchResult, watchError, watchDeadline, jsonBytes, type WatchRequest, type WatchResult, type WatchProvider } from "../watch.ts";
import { AgentTelemetry, agentServiceTag, endpoint, observerServiceTag, TELEMETRY_PROTOCOL, projectMessage, type Endpoint, type TelemetryEvent } from "./telemetry.ts";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mdns } from "@libp2p/mdns";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { getIntercomScopeId } from "../config.ts";
import type { TodoSnapshot } from "./todo.ts";
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
import {
  TRANSFER_PROTOCOL,
  buildTransferSource,
  createTransferStream,
  decodeTransferJson,
  encodeTransferJson,
  receiveTransferFiles,
  sendTransferFiles,
  type TransferCompletion,
  type TransferManifestEntry,
} from "./transfer.ts";

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

interface TransferSendOptions extends SendOptions {
  paths: string[];
  cwd: string;
  signal?: AbortSignal;
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

export function p2pMdnsAnswers(service: string, peerName: string, addresses: ReadonlyArray<{ toString(): string }>) {
  const instance = `${peerName}.${service}`;
  return [
    { name: service, type: "PTR" as const, class: "IN" as const, ttl: 120, data: instance },
    ...addresses.map((address) => ({
      name: instance,
      type: "TXT" as const,
      class: "IN" as const,
      ttl: 120,
      data: `dnsaddr=${address.toString()}`,
    })),
  ];
}

type PeerEnvelope =
  | { type: "watch"; scopeId?: string; from: SessionInfo; to: string; targetEpoch?: string; requestId: string; request: WatchRequest }
  | { type: "hello"; scopeId?: string; session: SessionInfo }
  | { type: "message"; scopeId?: string; from: SessionInfo; to: string; message: Message }
  | { type: "presence"; scopeId?: string; from: SessionInfo }
  | { type: "receipt"; scopeId?: string; from: SessionInfo; receipt: MessageReceipt }
  | { type: "control"; scopeId?: string; from: SessionInfo; control: MessageControl };

type PeerResponse =
  | { ok: true; session?: SessionInfo; transferId?: string; storedAt?: string; watch?: WatchResult; requestId?: string; endpointEpoch?: string }
  | { ok: false; reason: string };

type TransferEnvelope = {
  type: "transfer";
  scopeId?: string;
  from: SessionInfo;
  to: string;
  message: Message;
  transferId: string;
  manifest: TransferManifestEntry[];
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getP2PKey(): string {
  const key = process.env.PI_INTERCOM_P2P_KEY?.trim();
  if (!key || key.length < 16) throw new Error("PI_INTERCOM_P2P_KEY must contain at least 16 characters for the p2p transport");
  return key;
}

function getP2PRequestTimeoutMs(): number {
  const timeout = Number(process.env.PI_INTERCOM_P2P_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000;
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
  try { return JSON.parse(decoder.decode(data)); }
  catch { throw new Error("Invalid p2p JSON message"); }
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
  private telemetry: AgentTelemetry | null = null;
  private telemetryContent = false;
  private readonly outboundEndpoints = new Map<string, Endpoint>();
  private readonly inboundEndpoints = new Map<string, Endpoint>();
  private readonly outboundMessages = new Map<string, Message>();

  private watchProvider?: WatchProvider;
  private outgoingWatches = new Map<AbortController, string>();
  private incomingWatches = new Map<AbortController, string>();
  get endpointEpoch(): string | undefined { return this.registration?.endpointEpoch; }
  setWatchProvider(provider?: WatchProvider): void {
    this.watchProvider = provider;
    for (const c of this.incomingWatches.keys()) c.abort(new Error("replaced"));
    this.incomingWatches.clear();
  }
  async watch(to: string, request: WatchRequest, signal?: AbortSignal): Promise<WatchResult> {
    validateWatchRequest(request);
    signal?.throwIfAborted();
    if (to === this._sessionId) return watchError("self_target");
    const target = this.resolveTarget(to);
    if (!target || !this.registration) return watchError("not_found");
    if (target.session.watchEnabled === undefined) return watchError("unsupported");
    if (!target.session.watchEnabled) return watchError("disabled");
    if (this.outgoingWatches.size >= 8) return watchError("busy");
    const controller = new AbortController();
    this.outgoingWatches.set(controller, target.session.id);
    const requestId = randomUUID();
    try {
      const envelope: PeerEnvelope = { type: "watch", scopeId: this.scopeId, from: this.registration, to: target.session.id, targetEpoch: target.session.endpointEpoch, requestId, request };
      if (jsonBytes(this.sign(envelope)) > 8192) return watchError("invalid_request");
      const response = await this.request(target.peerId, envelope, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      signal?.throwIfAborted();
      if (!response.ok) return watchError(response.reason);
      const live = this.peers.get(target.session.id);
      if (response.requestId !== requestId || response.endpointEpoch !== target.session.endpointEpoch || !live || live.session.endpointEpoch !== target.session.endpointEpoch || !live.peerId.equals(target.peerId) || !validWatchResult(response.watch, request)) return watchError("stale_target");
      if (!("error" in response.watch) && (response.watch.target.id !== target.session.id || response.watch.target.endpointEpoch !== target.session.endpointEpoch)) return watchError("stale_target");
      return response.watch;
    } finally { this.outgoingWatches.delete(controller); }
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  supportsFeature(feature: string): boolean {
    return feature === EXACT_SEND_FEATURE || feature === WATCH_FEATURE;
  }

  isConnected(): boolean {
    return Boolean(this.node?.status === "started" && this._sessionId);
  }

  async connect(session: SessionRegistration, sessionId: string = randomUUID()): Promise<void> {
    if (this.node) throw new Error("Already connected");

    const endpointEpoch = randomUUID();
    this._sessionId = sessionId;
    this.registration = { ...session, id: sessionId, endpointEpoch, trustedLocal: false };

    const mdnsServiceTag = agentServiceTag(this.key, this.scopeId);
    const createMdns = mdns({ serviceTag: mdnsServiceTag });
    let mdnsService: ReturnType<typeof createMdns> | undefined;
    const telemetryEnabled = process.env.PI_INTERCOM_TELEMETRY !== "0";
    this.telemetryContent = telemetryEnabled && process.env.PI_INTERCOM_TELEMETRY_CONTENT !== "0";
    const createObserverDiscovery = mdns({ serviceTag: observerServiceTag(this.key, this.scopeId) });
    let observerDiscovery: ReturnType<typeof createObserverDiscovery> | undefined;
    const node = await createLibp2p({
      start: false,
      addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [(components) => {
        mdnsService = createMdns(components);
        return mdnsService;
      }, ...(telemetryEnabled ? [(components: Parameters<typeof createObserverDiscovery>[0]) => {
        observerDiscovery = createObserverDiscovery(components);
        return observerDiscovery;
      }] : [])],
    });
    this.node = node;
    if (telemetryEnabled) this.telemetry = new AgentTelemetry(node, this.registration);
    await node.handle(PROTOCOL, (stream, connection) => this.handleStream(stream, connection), { maxInboundStreams: 64, maxOutboundStreams: 64 });
    if (this.telemetry) await node.handle(TELEMETRY_PROTOCOL, (stream, connection) => this.telemetry?.acceptObserver(stream, connection.remotePeer), { maxInboundStreams: 64, maxOutboundStreams: 64 });
    await node.handle(TRANSFER_PROTOCOL, (stream, connection) => this.handleTransferStream(stream, connection), {
      maxInboundStreams: 2,
      maxOutboundStreams: 2,
    });
    mdnsService?.addEventListener("peer", (event) => {
      if (event.detail.id.equals(node.peerId)) return;
      // mDNS can emit a private-only response before our bound-address response.
      // Merge every response and retry only after its addresses are available.
      void node.peerStore.merge(event.detail.id, { multiaddrs: event.detail.multiaddrs })
        .then(() => this.announceToPeer(event.detail.id))
        .catch(() => undefined);
    });
    observerDiscovery?.addEventListener("peer", (event) => {
      if (event.detail.id.equals(node.peerId)) return;
      void node.peerStore.merge(event.detail.id, { multiaddrs: event.detail.multiaddrs })
        .then(() => this.telemetry?.connectPeer(event.detail.id)).catch(() => undefined);
    });
    node.addEventListener("peer:connect", (event) => {
      if (!event.detail.equals(node.peerId)) void this.announceToPeer(event.detail);
    });
    node.addEventListener("peer:disconnect", (event) => this.removePeer(event.detail));
    await node.start();
    confirmP2PListenAddresses((node as Libp2p & { components: P2PAddressComponents }).components);

    // @libp2p/mdns drops public-range addresses even when they are on the local
    // link. Add a response on its existing socket with only our bound addresses.
    // PeerDiscovery's public type omits the mDNS socket exposed by its implementation.
    const mdnsSocket = (mdnsService as typeof mdnsService & { mdns?: { on(event: "query", handler: (query: { questions: Array<{ name: string; type: string }> }) => void): void; respond(answers: ReturnType<typeof p2pMdnsAnswers>): void } } | undefined)?.mdns;
    mdnsSocket?.on("query", (query) => {
      if (query.questions.some(({ name, type }) => name === mdnsServiceTag && type === "PTR")) {
        mdnsSocket.respond(p2pMdnsAnswers(mdnsServiceTag, node.peerId.toString(), node.getMultiaddrs()));
      }
    });

    const registered: BrokerMessage = { type: "registered", sessionId, features: [EXACT_SEND_FEATURE] };
    this.emit("broker_message", registered);
  }

  async disconnect(): Promise<void> {
    const node = this.node;
    if (!node) return;
    this.setWatchProvider(undefined);
    for (const c of this.outgoingWatches.keys()) c.abort(new Error("disconnected"));
    this.outgoingWatches.clear();
    this.telemetry?.stop();
    this.telemetry = null;
    this.telemetryContent = false;
    this.outboundEndpoints.clear();
    this.inboundEndpoints.clear();
    this.outboundMessages.clear();
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
    this.remember(this.outboundEndpoints, messageId, endpoint(target.session));
    this.remember(this.outboundMessages, messageId, message);
    this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), "attempted", undefined, this.telemetryContent));
    let response: PeerResponse;
    try { response = await this.request(target.peerId, {
      type: "message",
      scopeId: this.scopeId,
      from: this.registration,
      to: target.session.id,
      message,
    }); } catch (error) {
      this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), "failed", undefined, this.telemetryContent));
      throw error;
    }
    this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), response.ok ? "socket_delivered" : "failed", undefined, this.telemetryContent));
    if (!response.ok) {
      return { id: messageId, delivered: false, reason: response.reason, delivery: "failed", retryable: true, outcomeKnown: true };
    }
    this.outboundRoutes.set(messageId, target.peerId);
    return { id: messageId, delivered: true, delivery: "socket_delivered", retryable: false, outcomeKnown: true };
  }

  async sendTransfer(to: string, options: TransferSendOptions): Promise<SendResult & { storedAt?: string }> {
    const target = this.resolveTarget(to);
    const messageId = options.messageId ?? randomUUID();
    if (!target) {
      return { id: messageId, delivered: false, reason: `Session "${to}" is not currently connected.`, delivery: "failed", retryable: true, outcomeKnown: true };
    }
    if (!this.registration || !this.node) throw new Error("Not connected");

    const source = await buildTransferSource(options.paths, options.cwd);
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
    this.remember(this.outboundEndpoints, messageId, endpoint(target.session));
    this.remember(this.outboundMessages, messageId, message);
    this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), "attempted", source.manifest, this.telemetryContent));
    const envelope: TransferEnvelope = {
      type: "transfer",
      scopeId: this.scopeId,
      from: this.registration,
      to: target.session.id,
      message,
      transferId: messageId,
      manifest: source.manifest,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("P2P transfer timed out")), 5 * 60_000);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let stream: Stream | undefined;
    try {
      stream = await this.node.dialProtocol(target.peerId, TRANSFER_PROTOCOL, { signal });
      const framed = createTransferStream(stream);
      await framed.write(encodeTransferJson(this.sign(envelope)), { signal });
      await sendTransferFiles(framed, source, messageId, (completion) => this.sign(completion), signal);
      await stream.close();
      const response = this.verify(decodeTransferJson(await framed.read({ signal }))) as PeerResponse;
      if (!response || typeof response !== "object" || typeof response.ok !== "boolean") throw new Error("Invalid p2p transfer response");
      this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), response.ok ? "socket_delivered" : "failed", source.manifest, this.telemetryContent));
      if (!response.ok) return { id: messageId, delivered: false, reason: response.reason, delivery: "failed", retryable: true, outcomeKnown: true };
      this.outboundRoutes.set(messageId, target.peerId);
      return { id: messageId, delivered: true, delivery: "socket_delivered", retryable: false, outcomeKnown: true, storedAt: response.storedAt };
    } catch (error) {
      this.report(() => projectMessage(message, endpoint(this.registration!), endpoint(target.session), "failed", source.manifest, this.telemetryContent));
      stream?.abort(toError(error));
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async cancelMessage(messageId: string): Promise<SendResult> {
    const peerId = this.outboundRoutes.get(messageId);
    if (!peerId || !this.registration) {
      return { id: messageId, delivered: false, reason: "Message target is no longer connected.", delivery: "failed", retryable: true, outcomeKnown: true };
    }
    const to = this.outboundEndpoints.get(messageId);
    if (to) this.report({ messageId, from: endpoint(this.registration), to, action: "cancel", timestamp: Date.now(), status: "attempted" });
    let response: PeerResponse;
    try { response = await this.request(peerId, {
      type: "control",
      scopeId: this.scopeId,
      from: this.registration,
      control: { messageId, action: "cancel", timestamp: Date.now() },
    }); } catch (error) {
      if (to) this.report({ messageId, from: endpoint(this.registration), to, action: "cancel", timestamp: Date.now(), status: "failed" });
      throw error;
    }
    if (to) this.report({ messageId, from: endpoint(this.registration), to, action: "cancel", timestamp: Date.now(), status: response.ok ? "socket_delivered" : "failed" });
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
    const to = this.inboundEndpoints.get(receipt.messageId);
    if (to) this.report({ messageId: receipt.messageId, from: to, to: endpoint(this.registration), action: "receipt", timestamp: receipt.timestamp, status: receipt.status });
    void this.request(peerId, { type: "receipt", scopeId: this.scopeId, from: this.registration, receipt }).catch(() => undefined);
  }

  updatePresence(updates: { name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }): void {
    if (!this.registration) return;
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) Reflect.deleteProperty(this.registration, key);
      else if (value !== undefined) Reflect.set(this.registration, key, value);
    }
    this.registration.lastActivity = Date.now();
    this.telemetry?.emitPresence();
    for (const { peerId } of this.peers.values()) {
      void this.request(peerId, { type: "presence", scopeId: this.scopeId, from: this.registration }).catch(() => undefined);
    }
  }

  updateTodos(snapshot: TodoSnapshot): void { if (this.telemetryContent) this.telemetry?.updateTodos(snapshot); }

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

  private remember<T>(map: Map<string, T>, id: string, value: T): void {
    map.set(id, value);
    if (map.size > 1000) map.delete(map.keys().next().value!);
  }

  private report(event: Omit<TelemetryEvent, "version" | "reporter" | "eventId" | "sequence"> | (() => Omit<TelemetryEvent, "version" | "reporter" | "eventId" | "sequence">)): void {
    if (!this.telemetry) return;
    try { this.telemetry.emit(typeof event === "function" ? event() : event); } catch { /* Observability cannot affect messaging. */ }
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

  private verify(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object") throw new Error("Invalid authenticated p2p message");
    const wire = value as { payload?: unknown; mac?: unknown };
    if (typeof wire.mac !== "string") throw new Error("Invalid authenticated p2p message");
    const expected = createHmac("sha256", this.key).update(JSON.stringify(wire.payload)).digest();
    const actual = Buffer.from(wire.mac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("P2P message authentication failed");
    if (!wire.payload || typeof wire.payload !== "object" || Array.isArray(wire.payload)) throw new Error("Invalid authenticated p2p payload");
    return wire.payload as Record<string, unknown>;
  }

  private async request(peerId: PeerId, envelope: PeerEnvelope, signal?: AbortSignal): Promise<PeerResponse> {
    const node = this.node;
    if (!node) throw new Error("Not connected");
    const timeoutMs = envelope.type === "watch" ? WATCH_TIMEOUT : getP2PRequestTimeoutMs();
    const controller = new AbortController();
    const abort = () => { controller.abort(signal?.reason); stream?.abort(toError(signal?.reason ?? new Error("cancelled"))); };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    let stream: Stream | undefined;
    const timer = setTimeout(() => {
      const error = new Error(`P2P ${envelope.type} request timed out after ${timeoutMs}ms`);
      stream?.abort(error);
      controller.abort(error);
    }, timeoutMs);
    try {
      stream = await node.dialProtocol(peerId, PROTOCOL, { signal: controller.signal });
      await writeJson(stream, this.sign(envelope));
      const wire = await readJson(stream);
      if (envelope.type === "watch" && jsonBytes(wire) > 96 * 1024) throw new Error("Oversized watch response");
      const response = this.verify(wire);
      if (!response || typeof response !== "object" || typeof (response as { ok?: unknown }).ok !== "boolean") {
        throw new Error("Invalid p2p response");
      }
      return response as PeerResponse;
    } catch (error) {
      stream?.abort(toError(error));
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async handleStream(stream: Stream, connection: Connection): Promise<void> {
    const controller = new AbortController();
    const close = () => controller.abort(new Error("disconnected"));
    stream.addEventListener("close", close);
    try {
      const wire = await readJson(stream);
      const value = this.verify(wire);
      if (value.type === "watch" && jsonBytes(wire) > 8192) throw new Error("Oversized watch request");
      const response = await this.handleEnvelope(value, connection.remotePeer, controller.signal);
      controller.signal.throwIfAborted();
      await writeJson(stream, this.sign(response));
    } catch (error) {
      try {
        await writeJson(stream, this.sign({ ok: false, reason: toError(error).message } satisfies PeerResponse));
      } catch {
        stream.abort(toError(error));
      }
    } finally { stream.removeEventListener("close", close); }
  }

  private async handleTransferStream(stream: Stream, connection: Connection): Promise<void> {
    const framed = createTransferStream(stream);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("P2P transfer timed out")), 5 * 60_000);
    try {
      const value = this.verify(decodeTransferJson(await framed.read({ signal: controller.signal })));
      if (!value || typeof value !== "object") throw new Error("Invalid p2p transfer");
      const envelope = value as TransferEnvelope;
      if (envelope.type !== "transfer" || envelope.scopeId !== this.scopeId || !isSessionInfo(envelope.from) || envelope.to !== this._sessionId || !isMessage(envelope.message) || envelope.transferId !== envelope.message.id) {
        throw new Error("Invalid p2p transfer header");
      }
      const storedAt = await receiveTransferFiles(
        framed,
        this._sessionId!,
        envelope.transferId,
        envelope.manifest,
        (completionValue) => {
          // SAFETY: transfer completion is checked by the receiver after authenticated decoding.
          const completion = this.verify(completionValue) as unknown as TransferCompletion;
          if (!completion || typeof completion !== "object") throw new Error("Invalid p2p transfer completion");
          return completion;
        },
        controller.signal,
      );
      const listed = envelope.manifest.slice(0, 100).map((entry) => `- ${entry.path}`).join("\n");
      const omitted = envelope.manifest.length > 100 ? `\n- ... ${envelope.manifest.length - 100} more entries` : "";
      const attachment: Attachment = {
        type: "context",
        name: "Transferred files",
        content: `Saved under ${storedAt}\n\nContents:\n${listed}${omitted}`,
      };
      const message: Message = {
        ...envelope.message,
        content: { ...envelope.message.content, attachments: [...(envelope.message.content.attachments ?? []), attachment] },
      };
      this.upsertPeer(connection.remotePeer, envelope.from);
      this.inboundRoutes.set(message.id, connection.remotePeer);
      this.remember(this.inboundEndpoints, message.id, endpoint(envelope.from));
      this.report(() => projectMessage(envelope.message, endpoint(envelope.from), endpoint(this.registration!), "receiver_received", envelope.manifest, this.telemetryContent));
      this.emit("message", envelope.from, message);
      await framed.write(encodeTransferJson(this.sign({ ok: true, transferId: envelope.transferId, storedAt } satisfies PeerResponse)), { signal: controller.signal });
      await stream.close();
    } catch (error) {
      try {
        await framed.write(encodeTransferJson(this.sign({ ok: false, reason: toError(error).message } satisfies PeerResponse)));
        await stream.close();
      } catch {
        stream.abort(toError(error));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleEnvelope(value: unknown, peerId: PeerId, signal?: AbortSignal): Promise<PeerResponse> {
    if (!value || typeof value !== "object") return { ok: false, reason: "Invalid p2p message" };
    const envelope = value as Record<string, unknown>;
    if ((envelope.scopeId ?? undefined) !== this.scopeId) return { ok: false, reason: "Intercom scope mismatch" };

    if (envelope.type === "watch") {
      const sessionId = this.sessionByPeer.get(peerId.toString());
      const known = sessionId ? this.peers.get(sessionId) : undefined;
      const registration = this.registration;
      if (!registration || !known || !known.peerId.equals(peerId) || !isSessionInfo(envelope.from) || envelope.from.id !== known.session.id || envelope.from.endpointEpoch !== known.session.endpointEpoch || envelope.to !== registration.id || envelope.targetEpoch !== registration.endpointEpoch || typeof envelope.requestId !== "string" || envelope.requestId.length > 128 || jsonBytes(value) > 8192) return { ok: false, reason: "unauthorized" };
      try { validateWatchRequest(envelope.request); } catch { return { ok: false, reason: "invalid_request" }; }
      const provider = this.watchProvider;
      const respond = (watch: WatchResult): PeerResponse => ({ ok: true, watch, requestId: envelope.requestId as string, endpointEpoch: registration.endpointEpoch });
      if (registration.watchEnabled === undefined) return respond(watchError("unsupported"));
      if (!registration.watchEnabled || !provider) return respond(watchError("disabled"));
      if (this.incomingWatches.size >= 32 || [...this.incomingWatches.values()].filter(id => id === sessionId).length >= 8) return respond(watchError("busy"));
      const controller = new AbortController();
      this.incomingWatches.set(controller, sessionId!);
      try {
        const result = await watchDeadline(s => provider(envelope.request as WatchRequest, s), WATCH_TIMEOUT, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
        const live = this.peers.get(sessionId!);
        if (this.registration !== registration || this.watchProvider !== provider || !live || live.session.endpointEpoch !== known.session.endpointEpoch || !live.peerId.equals(peerId)) return { ok: false, reason: "stale_target" };
        return respond(validWatchResult(result, envelope.request as WatchRequest) ? result : watchError("invalid_response"));
      } catch (error) { return respond(watchError(error instanceof Error ? error.message : "failed")); }
      finally { this.incomingWatches.delete(controller); }
    }

    if (envelope.type === "hello" && isSessionInfo(envelope.session)) {
      this.upsertPeer(peerId, envelope.session);
      return this.registration ? { ok: true, session: this.registration } : { ok: false, reason: "Not connected" };
    }
    if (envelope.type === "message" && isSessionInfo(envelope.from) && typeof envelope.to === "string" && isMessage(envelope.message)) {
      if (envelope.to !== this._sessionId) return { ok: false, reason: "Message addressed to another session" };
      this.upsertPeer(peerId, envelope.from);
      this.inboundRoutes.set(envelope.message.id, peerId);
      this.remember(this.inboundEndpoints, envelope.message.id, endpoint(envelope.from));
      const incomingMessage = envelope.message;
      const incomingFrom = envelope.from;
      if (this.registration) this.report(() => projectMessage(incomingMessage, endpoint(incomingFrom), endpoint(this.registration!), "receiver_received", undefined, this.telemetryContent));
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
      const receipt = envelope.receipt;
      const from = envelope.from;
      const message = this.outboundMessages.get(receipt.messageId);
      if (message && this.registration) this.report(() => ({ ...projectMessage(message, endpoint(this.registration!), endpoint(from), receipt.status), timestamp: receipt.timestamp }));
      this.emit("message_receipt", envelope.from, envelope.receipt);
      return { ok: true };
    }
    if (envelope.type === "control" && isSessionInfo(envelope.from) && isMessageControl(envelope.control)) {
      if (this.registration) this.report({ messageId: envelope.control.messageId, from: endpoint(envelope.from), to: endpoint(this.registration), action: "cancel", timestamp: envelope.control.timestamp, status: "receiver_received" });
      this.emit("message_control", envelope.from, envelope.control);
      return { ok: true };
    }
    return { ok: false, reason: "Invalid p2p message" };
  }

  private upsertPeer(peerId: PeerId, session: SessionInfo): void {
    if (session.id === this._sessionId) return;
    const peerKey = peerId.toString();
    const existing = this.peers.get(session.id);
    if (existing && (!existing.peerId.equals(peerId) || existing.session.endpointEpoch !== session.endpointEpoch)) {
      for (const [c, id] of [...this.incomingWatches, ...this.outgoingWatches]) if (id === session.id) c.abort(new Error("replaced"));
      if (!existing.peerId.equals(peerId)) this.sessionByPeer.delete(existing.peerId.toString());
    }
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
    for (const [messageId, route] of this.inboundRoutes) {
      if (route.equals(peerId)) this.inboundRoutes.delete(messageId);
    }
    for (const [messageId, route] of this.outboundRoutes) {
      if (route.equals(peerId)) this.outboundRoutes.delete(messageId);
    }
    if (!sessionId) return;
    for (const [c, id] of [...this.incomingWatches, ...this.outgoingWatches]) if (id === sessionId) c.abort(new Error("disconnected"));
    this.sessionByPeer.delete(peerKey);
    this.peers.delete(sessionId);
    const left: BrokerMessage = { type: "session_left", sessionId };
    this.emit("broker_message", left);
    this.emit("session_left", sessionId);
  }
}
