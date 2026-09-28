import { EventEmitter } from "node:events";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mdns } from "@libp2p/mdns";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { PeerId, Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";
import { getIntercomScopeId } from "../config.ts";
import type { Attachment, Message, SessionInfo } from "../types.ts";
import type { TransferManifestEntry } from "./transfer.ts";

export const TELEMETRY_PROTOCOL = "/pi-intercom/telemetry/1.0.0";
const MAX_FRAME = 64 * 1024;
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024;
const text = new TextEncoder();
const decode = new TextDecoder();
export type Endpoint = { id: string; epoch: string; name?: string };
export type TelemetryEvent = {
  version: 1; reporter: Endpoint & { peerId: string }; eventId: string; sequence: number;
  messageId: string; from: Endpoint; to: Endpoint;
  action: "send" | "ask" | "reply" | "cancel" | "receipt";
  timestamp: number; status: "attempted" | "socket_delivered" | "failed" | "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";
  replyTo?: string; retryOf?: string; supersedes?: string;
  /** Message text, shared only when the reporting agent explicitly opts in. Never attachment content. */
  body?: string; bodyTruncated?: boolean;
  artifacts?: { attachments: { name: string; type: string }[]; manifest: TransferManifestEntry[]; totalCount: number; totalBytes: number; omitted: number };
};

export function endpoint(session: SessionInfo): Endpoint {
  return { id: session.id.slice(0, 128), epoch: (session.endpointEpoch ?? "legacy").slice(0, 128), ...(session.name ? { name: session.name.slice(0, 128) } : {}) };
}
export function agentServiceTag(key: string, scope?: string): string {
  return `_pi-intercom-${createHash("sha256").update(`${key}\0${scope ?? ""}`).digest("hex").slice(0, 12)}._udp.local`;
}
export function observerServiceTag(key: string, scope?: string): string {
  return `_pi-intercom-view-${createHash("sha256").update(`${key}\0${scope ?? ""}\0observer`).digest("hex").slice(0, 12)}._udp.local`;
}
export function telemetryKey(): string {
  const key = process.env.PI_INTERCOM_P2P_KEY?.trim();
  if (!key || key.length < 16) throw new Error("PI_INTERCOM_P2P_KEY must contain at least 16 characters");
  return key;
}
function sign(key: string, payload: unknown) {
  return { payload, mac: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") };
}
function verify(key: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid telemetry envelope");
  const wire = value as { payload?: unknown; mac?: unknown };
  if (typeof wire.mac !== "string" || !/^[a-f0-9]{64}$/.test(wire.mac)) throw new Error("Invalid telemetry signature");
  const expected = createHmac("sha256", key).update(JSON.stringify(wire.payload)).digest();
  if (!timingSafeEqual(expected, Buffer.from(wire.mac, "hex"))) throw new Error("Invalid telemetry signature");
  if (!wire.payload || typeof wire.payload !== "object" || Array.isArray(wire.payload)) throw new Error("Invalid telemetry payload");
  return wire.payload as Record<string, unknown>;
}
function framed(stream: Stream) { return lpStream(stream, { maxDataLength: MAX_FRAME, maxBufferSize: MAX_FRAME * 2 }); }
async function writeFrame(frame: ReturnType<typeof framed>, value: unknown): Promise<void> {
  const bytes = text.encode(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) throw new Error("Telemetry frame too large");
  await frame.write(bytes);
}
async function readFrame(frame: ReturnType<typeof framed>, signal?: AbortSignal): Promise<unknown> {
  try { return JSON.parse(decode.decode((await frame.read({ signal })).subarray())); }
  catch { throw new Error("Invalid telemetry JSON frame"); }
}
const bounded = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const onlyKeys = (value: unknown, keys: string[]) => value !== null && typeof value === "object" && Object.keys(value).every((key) => keys.includes(key));
function validEndpoint(value: unknown): value is Endpoint {
  if (!value || typeof value !== "object") return false;
  const e = value as Endpoint;
  return onlyKeys(e, ["id", "epoch", "name", "peerId"]) && bounded(e.id) && bounded(e.epoch) && (e.name === undefined || (typeof e.name === "string" && e.name.length <= 128));
}
export function validTelemetryEvent(value: unknown, reporter: Endpoint & { peerId: string }): value is TelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as TelemetryEvent;
  const statuses = ["attempted", "socket_delivered", "failed", "receiver_received", "queued", "injected", "acknowledged", "expired", "cancelled", "superseded", "cancellation_requested"];
  const actions = ["send", "ask", "reply", "cancel", "receipt"];
  if (!onlyKeys(e, ["version", "reporter", "eventId", "sequence", "messageId", "from", "to", "action", "timestamp", "status", "replyTo", "retryOf", "supersedes", "body", "bodyTruncated", "artifacts"]) || e.version !== 1 || !validEndpoint(e.reporter) || e.reporter.peerId !== reporter.peerId || e.reporter.id !== reporter.id || e.reporter.epoch !== reporter.epoch || !bounded(e.eventId) || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || !bounded(e.messageId) || !validEndpoint(e.from) || !validEndpoint(e.to) || !actions.includes(e.action) || !statuses.includes(e.status) || !Number.isFinite(e.timestamp)) return false;
  if (!onlyKeys(e.from, ["id", "epoch", "name"]) || !onlyKeys(e.to, ["id", "epoch", "name"]) || ![e.from, e.to].some((p) => p.id === reporter.id && p.epoch === reporter.epoch)) return false;
  if ([e.replyTo, e.retryOf, e.supersedes].some((s) => s !== undefined && !bounded(s))) return false;
  if (e.body !== undefined && (typeof e.body !== "string" || text.encode(e.body).length > MAX_TELEMETRY_BODY_BYTES || e.action === "cancel" || e.action === "receipt")) return false;
  if (e.bodyTruncated !== undefined && (typeof e.bodyTruncated !== "boolean" || e.body === undefined)) return false;
  if (e.artifacts !== undefined) {
    const a = e.artifacts;
    if (!a || !onlyKeys(a, ["attachments", "manifest", "totalCount", "totalBytes", "omitted"]) || !Array.isArray(a.attachments) || !Array.isArray(a.manifest) || a.attachments.length + a.manifest.length > 100 || !Number.isSafeInteger(a.totalCount) || a.totalCount < 0 || !Number.isSafeInteger(a.totalBytes) || a.totalBytes < 0 || !Number.isSafeInteger(a.omitted) || a.omitted < 0) return false;
    if (a.attachments.some((x) => !x || !onlyKeys(x, ["name", "type"]) || !bounded(x.name, 256) || !["file", "snippet", "context"].includes(x.type))) return false;
    if (a.manifest.some((x) => !x || !onlyKeys(x, ["path", "type", "size"]) || !bounded(x.path, 512) || (isAbsolute(x.path) || /^[a-z]:/i.test(x.path)) || x.path.includes("\\") || x.path.split("/").some((s) => !s || s === "." || s === "..") || !["file", "directory"].includes(x.type) || (x.size !== undefined && (!Number.isSafeInteger(x.size) || x.size < 0)))) return false;
  }
  return true;
}
export function projectArtifacts(attachments?: Attachment[], manifest?: TransferManifestEntry[]): TelemetryEvent["artifacts"] {
  if (!attachments?.length && !manifest?.length) return undefined;
  const safeAttachments = (attachments ?? []).slice(0, 100).map((a) => ({ name: (a.name.replaceAll("\\", "/").split("/").at(-1) || "[unnamed]").slice(0, 256), type: a.type }));
  const safeManifest = (manifest ?? []).slice(0, 100 - safeAttachments.length).map((m) => ({ path: m.path.slice(0, 512), type: m.type, ...(m.size === undefined ? {} : { size: m.size }) }));
  const totalCount = (attachments?.length ?? 0) + (manifest?.length ?? 0);
  return { attachments: safeAttachments, manifest: safeManifest, totalCount, totalBytes: (manifest ?? []).reduce((sum, m) => sum + (m.size ?? 0), 0), omitted: totalCount - safeAttachments.length - safeManifest.length };
}
export function projectMessage(message: Message, from: Endpoint, to: Endpoint, status: TelemetryEvent["status"], manifest?: TransferManifestEntry[], includeBody = false): Pick<TelemetryEvent, "messageId" | "from" | "to" | "action" | "timestamp" | "status" | "replyTo" | "retryOf" | "supersedes" | "artifacts" | "body" | "bodyTruncated"> {
  const artifacts = projectArtifacts(message.content.attachments, manifest);
  const source = includeBody ? text.encode(message.content.text) : null;
  const body = source ? (source.length > MAX_TELEMETRY_BODY_BYTES ? decode.decode(source.subarray(0, MAX_TELEMETRY_BODY_BYTES)).replace(/\uFFFD$/, "") : message.content.text) : undefined;
  return { messageId: message.id, from, to, action: message.replyTo ? "reply" : message.expectsReply ? "ask" : "send", timestamp: message.timestamp, status,
    ...(message.replyTo ? { replyTo: message.replyTo.slice(0, 128) } : {}), ...(message.retryOf ? { retryOf: message.retryOf.slice(0, 128) } : {}), ...(message.supersedes ? { supersedes: message.supersedes.slice(0, 128) } : {}),
    ...(source ? { body, bodyTruncated: source.length > MAX_TELEMETRY_BODY_BYTES } : {}),
    ...(artifacts ? { artifacts } : {}) };
}

/** Best-effort, bounded telemetry sender. It never awaits on a message delivery path. */
export class AgentTelemetry {
  private readonly key = telemetryKey();
  private readonly scope = getIntercomScopeId();
  private observers = new Map<string, { stream: Stream; queue: TelemetryEvent[]; writing: boolean }>();
  private pending = new Set<string>();
  private retries = new Map<string, { attempts: number; lastSeen: number; timer?: NodeJS.Timeout }>();
  private sequence = 0;
  private dropped = 0;
  private closed = false;
  constructor(private node: Libp2p, private session: SessionInfo) {}
  /** Accept a viewer that dialed this agent through the regular P2P discovery service. */
  async acceptObserver(stream: Stream, peerId: PeerId): Promise<void> {
    try {
      if (this.closed) throw new Error("Telemetry stopped");
      const frame = framed(stream);
      const hello = verify(this.key, await readFrame(frame, AbortSignal.timeout(5_000))) as { type?: string; version?: number; scope?: string; observerPeerId?: string };
      if (hello.type !== "subscribe" || hello.version !== 1 || hello.scope !== this.scope || hello.observerPeerId !== peerId.toString()) throw new Error("Invalid observer subscription");
      await writeFrame(frame, sign(this.key, { type: "subscribed", scope: this.scope, reporter: { ...endpoint(this.session), peerId: this.node.peerId.toString() } }));
      const id = peerId.toString();
      if (this.closed || this.observers.has(id) || this.observers.size >= 32) throw new Error("Duplicate or excess observer");
      const observer = { stream, queue: [] as TelemetryEvent[], writing: false };
      this.observers.set(id, observer);
      stream.addEventListener("close", () => { if (this.observers.get(id) === observer) this.observers.delete(id); });
    } catch { stream.abort(new Error("Telemetry subscription rejected")); }
  }
  async connectPeer(peerId: PeerId): Promise<void> {
    const id = peerId.toString();
    if (this.closed || peerId.equals(this.node.peerId)) return;
    const existing = this.retries.get(id);
    if (existing) existing.lastSeen = Date.now();
    if (this.observers.has(id) || this.pending.has(id) || this.observers.size >= 32 || this.pending.size >= 32) return;
    if (!existing && this.retries.size >= 256) {
      const oldest = this.retries.keys().next().value;
      if (oldest) { const removed = this.retries.get(oldest); if (removed?.timer) clearTimeout(removed.timer); this.retries.delete(oldest); }
    }
    this.pending.add(id);
    const retry = existing ?? { attempts: 0, lastSeen: Date.now() };
    this.retries.set(id, retry);
    try {
      const stream = await this.node.dialProtocol(peerId, TELEMETRY_PROTOCOL, { signal: AbortSignal.timeout(5_000) });
      const frame = framed(stream);
      await writeFrame(frame, sign(this.key, { type: "subscribe", version: 1, scope: this.scope, reporter: { ...endpoint(this.session), peerId: this.node.peerId.toString() } }));
      const response = verify(this.key, await readFrame(frame, AbortSignal.timeout(5_000))) as { type?: string; scope?: string };
      if (response.type !== "subscribed" || response.scope !== this.scope) throw new Error("Invalid telemetry subscription");
      if (this.closed) { stream.abort(new Error("Telemetry stopped")); return; }
      retry.attempts = 0;
      if (this.observers.has(id)) { stream.abort(new Error("Already subscribed")); return; }
      const observer = { stream, queue: [] as TelemetryEvent[], writing: false };
      this.observers.set(id, observer);
      stream.addEventListener("close", () => { if (this.observers.get(id) === observer) { this.observers.delete(id); this.retry(peerId); } });
    } catch { this.retry(peerId); }
    finally { this.pending.delete(id); }
  }
  private retry(peerId: PeerId): void {
    const retry = this.retries.get(peerId.toString());
    if (!retry || this.closed || Date.now() - retry.lastSeen > 120_000 || retry.timer) return;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      void this.connectPeer(peerId).catch(() => undefined);
    }, Math.min(30_000, 1_000 * 2 ** Math.min(retry.attempts++, 5)));
    retry.timer.unref();
  }
  emit(event: Omit<TelemetryEvent, "version" | "reporter" | "eventId" | "sequence">): void {
    if (this.closed || !this.observers.size) return;
    const full: TelemetryEvent = { ...event, version: 1, reporter: { ...endpoint(this.session), peerId: this.node.peerId.toString() }, eventId: randomUUID(), sequence: ++this.sequence };
    // Bound encoded bytes too: a 512-character Unicode path may use far more than 512 bytes.
    while (text.encode(JSON.stringify(sign(this.key, { type: "event", scope: this.scope, event: full, dropped: this.dropped }))).length > MAX_FRAME && full.artifacts && (full.artifacts.manifest.length || full.artifacts.attachments.length)) {
      if (full.artifacts.manifest.length) full.artifacts.manifest.pop();
      else full.artifacts.attachments.pop();
      full.artifacts.omitted++;
    }
    if (text.encode(JSON.stringify(sign(this.key, { type: "event", scope: this.scope, event: full, dropped: this.dropped }))).length > MAX_FRAME) { this.dropped++; return; }
    for (const observer of this.observers.values()) {
      if (observer.queue.length >= 128) { observer.queue.shift(); this.dropped++; }
      observer.queue.push(full);
      void this.flush(observer);
    }
  }
  private async flush(observer: { stream: Stream; queue: TelemetryEvent[]; writing: boolean }): Promise<void> {
    if (observer.writing) return;
    observer.writing = true;
    try {
      const frame = framed(observer.stream);
      while (observer.queue.length && !this.closed) {
        const event = observer.queue.shift()!;
        await writeFrame(frame, sign(this.key, { type: "event", scope: this.scope, event, dropped: this.dropped }));
      }
    } catch { observer.stream.abort(new Error("Telemetry stream failed")); }
    finally { observer.writing = false; }
  }
  stop(): void {
    this.closed = true;
    for (const retry of this.retries.values()) if (retry.timer) clearTimeout(retry.timer);
    this.retries.clear();
    for (const { stream } of this.observers.values()) stream.abort(new Error("Telemetry stopped"));
    this.observers.clear();
  }
}

/** Observer is not registered as an intercom session; it dials agents and accepts older agents dialing it. */
export class TelemetryObserver extends EventEmitter {
  private readonly key = telemetryKey();
  private readonly scope = getIntercomScopeId();
  private readonly connecting = new Set<string>();
  private readonly active = new Set<string>();
  node: Libp2p | null = null;
  async start(): Promise<void> {
    if (this.node) throw new Error("Observer already started");
    const tag = observerServiceTag(this.key, this.scope);
    const createMdns = mdns({ serviceTag: tag });
    const discoverAgents = mdns({ serviceTag: agentServiceTag(this.key, this.scope), broadcast: false });
    let discovery: ReturnType<typeof createMdns> | undefined;
    let agentDiscovery: ReturnType<typeof discoverAgents> | undefined;
    const node = await createLibp2p({ start: false, addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()], peerDiscovery: [
      (components) => { discovery = createMdns(components); return discovery; },
      (components) => { agentDiscovery = discoverAgents(components); return agentDiscovery; },
    ] });
    this.node = node;
    await node.handle(TELEMETRY_PROTOCOL, (stream, connection) => this.handle(stream, connection.remotePeer), { maxInboundStreams: 64, maxOutboundStreams: 64 });
    agentDiscovery?.addEventListener("peer", (event) => {
      if (event.detail.id.equals(node.peerId)) return;
      void node.peerStore.merge(event.detail.id, { multiaddrs: event.detail.multiaddrs })
        .then(() => this.subscribe(event.detail.id)).catch(() => undefined);
    });
    await node.start();
    // Advertise the actual bound TCP addresses, including LAN public-range subnets.
    const components = (node as Libp2p & { components: { transportManager: { getAddrs(): ReturnType<Libp2p["getMultiaddrs"]> }; addressManager: { confirmObservedAddr(addr: ReturnType<Libp2p["getMultiaddrs"]>[number], options: { type: "transport" }): void } } }).components;
    for (const addr of components.transportManager.getAddrs()) components.addressManager.confirmObservedAddr(addr, { type: "transport" });
    // The mDNS implementation exposes its socket, though PeerDiscovery's interface omits it.
    const socket = (discovery as typeof discovery & { mdns?: { on(event: "query", handler: (query: { questions: Array<{ name: string; type: string }> }) => void): void; respond(answers: Array<{ name: string; type: "PTR" | "TXT"; class: "IN"; ttl: number; data: string }>): void } } | undefined)?.mdns;
    socket?.on("query", (query) => {
      if (query.questions.some(({ name, type }) => name === tag && type === "PTR")) {
        const instance = `${node.peerId.toString()}.${tag}`;
        socket.respond([{ name: tag, type: "PTR", class: "IN", ttl: 120, data: instance }, ...node.getMultiaddrs().map((addr) => ({ name: instance, type: "TXT" as const, class: "IN" as const, ttl: 120, data: `dnsaddr=${addr.toString()}` }))]);
      }
    });
  }
  async stop(): Promise<void> { const node = this.node; this.node = null; await node?.stop(); this.connecting.clear(); this.active.clear(); }
  private async subscribe(peerId: PeerId): Promise<void> {
    const node = this.node, id = peerId.toString();
    if (!node || this.connecting.has(id) || this.active.has(id) || this.connecting.size + this.active.size >= 64) return;
    this.connecting.add(id);
    let stream: Stream | undefined;
    try {
      stream = await node.dialProtocol(peerId, TELEMETRY_PROTOCOL, { signal: AbortSignal.timeout(5_000) });
      const frame = framed(stream);
      await writeFrame(frame, sign(this.key, { type: "subscribe", version: 1, scope: this.scope, observerPeerId: node.peerId.toString() }));
      const response = verify(this.key, await readFrame(frame, AbortSignal.timeout(5_000))) as { type?: string; scope?: string; reporter?: Endpoint & { peerId?: string } };
      if (response.type !== "subscribed" || response.scope !== this.scope || !validEndpoint(response.reporter) || response.reporter?.peerId !== id) throw new Error("Invalid agent subscription");
      await this.consume(stream, peerId, response.reporter as Endpoint & { peerId: string });
    } catch { stream?.abort(new Error("Telemetry connection failed")); }
    finally { this.connecting.delete(id); }
  }
  private async handle(stream: Stream, peerId: PeerId): Promise<void> {
    try {
      const frame = framed(stream);
      const hello = verify(this.key, await readFrame(frame, AbortSignal.timeout(5_000))) as { type?: string; version?: number; scope?: string; reporter?: Endpoint & { peerId?: string } };
      if (hello.type !== "subscribe" || hello.version !== 1 || hello.scope !== this.scope || !validEndpoint(hello.reporter) || hello.reporter?.peerId !== peerId.toString()) throw new Error("Invalid telemetry subscription");
      await writeFrame(frame, sign(this.key, { type: "subscribed", scope: this.scope }));
      await this.consume(stream, peerId, hello.reporter as Endpoint & { peerId: string });
    } catch { stream.abort(new Error("Telemetry subscription rejected")); }
  }
  private async consume(stream: Stream, peerId: PeerId, reporter: Endpoint & { peerId: string }): Promise<void> {
    const id = peerId.toString();
    if (this.active.has(id) || this.active.size >= 64) { stream.abort(new Error("Duplicate telemetry connection")); return; }
    this.active.add(id);
    this.emit("status", { connected: true, reporter });
    try {
      const frame = framed(stream);
      for (;;) {
        const payload = verify(this.key, await readFrame(frame)) as { type?: string; scope?: string; event?: unknown; dropped?: number };
        if (payload.type !== "event" || payload.scope !== this.scope || !validTelemetryEvent(payload.event, reporter) || !Number.isSafeInteger(payload.dropped) || payload.dropped! < 0) throw new Error("Invalid telemetry event");
        this.emit("event", payload.event);
        if (payload.dropped) this.emit("status", { partial: true, dropped: payload.dropped });
      }
    } catch { /* malformed or disconnected streams are not trusted */ }
    finally { stream.abort(new Error("Telemetry closed")); this.active.delete(id); this.emit("status", { connected: false, peerId: id }); }
  }
}
