import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mdns } from "@libp2p/mdns";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { PeerId, Stream } from "@libp2p/interface";
import { getIntercomScopeId } from "../config.ts";
import type { Attachment, Message, SessionInfo } from "../types.ts";
import type { TransferManifestEntry } from "./transfer.ts";
import { MAX_FRAME, MAX_TELEMETRY_BODY_BYTES, TELEMETRY_PROTOCOL, telemetryKey, sign, verify, framed, writeFrame, readFrame, validTodos, validEndpoint, onlyKeys, agentServiceTag, observerServiceTag, validTelemetryEvent, type TodoSnapshot, type Endpoint, type TelemetryPresence, type TelemetryTodo, type TelemetryEvent } from "./telemetry-contract.ts";
export { agentServiceTag, observerServiceTag, TELEMETRY_PROTOCOL, MAX_TELEMETRY_BODY_BYTES, validTelemetryEvent } from "./telemetry-contract.ts";
export type { Endpoint, TelemetryPresence, TelemetryTodo, TelemetryEvent } from "./telemetry-contract.ts";
const text = new TextEncoder();
const decode = new TextDecoder();
type Queued = TelemetryEvent | (TelemetryPresence & { type: "presence" }) | (TelemetryTodo & { type: "todo" });

export function endpoint(session: SessionInfo): Endpoint {
  return { id: session.id.slice(0, 128), epoch: (session.endpointEpoch ?? "legacy").slice(0, 128), ...(session.name ? { name: session.name.slice(0, 128) } : {}), ...(session.hostname ? { hostname: session.hostname.slice(0, 128) } : {}) };
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
  private observers = new Map<string, { stream: Stream; queue: Queued[]; writing: boolean }>();
  private todos: TodoSnapshot | undefined;
  private pending = new Set<string>();
  private retries = new Map<string, { attempts: number; lastSeen: number; timer?: NodeJS.Timeout }>();
  private sequence = 0;
  private dropped = 0;
  private lastActive: boolean | undefined;
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
      const observer = { stream, queue: [] as Queued[], writing: false };
      this.observers.set(id, observer);
      this.emitPresence(true, observer);
      this.emitTodos(observer);
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
      const observer = { stream, queue: [] as Queued[], writing: false };
      this.observers.set(id, observer);
      this.emitPresence(true, observer);
      this.emitTodos(observer);
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
  updateTodos(snapshot: TodoSnapshot): void {
    if (this.closed || !validTodos(snapshot) || JSON.stringify(snapshot) === JSON.stringify(this.todos)) return;
    this.todos = snapshot;
    this.emitTodos();
  }
  private emitTodos(only?: { stream: Stream; queue: Queued[]; writing: boolean }): void {
    if (!this.todos) return;
    const event: TelemetryTodo & { type: "todo" } = { type: "todo", reporter: { ...endpoint(this.session), peerId: this.node.peerId.toString() }, snapshot: this.todos };
    if (text.encode(JSON.stringify(sign(this.key, { type: "todo", scope: this.scope, todo: event }))).length > MAX_FRAME) return;
    for (const observer of only ? [only] : this.observers.values()) {
      if (observer.queue.length >= 128) observer.queue.shift();
      observer.queue.push(event);
      void this.flush(observer);
    }
  }
  emitPresence(force = false, only?: { stream: Stream; queue: Queued[]; writing: boolean }): void {
    const active = this.session.status?.startsWith("thinking") === true || this.session.status?.startsWith("tool:") === true;
    if (!force && this.lastActive === active) return;
    this.lastActive = active;
    const presence: TelemetryPresence & { type: "presence" } = { type: "presence", reporter: { ...endpoint(this.session), peerId: this.node.peerId.toString() }, active };
    for (const observer of only ? [only] : this.observers.values()) {
      if (observer.queue.length >= 128) observer.queue.shift();
      observer.queue.push(presence);
      void this.flush(observer);
    }
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
  private async flush(observer: { stream: Stream; queue: Queued[]; writing: boolean }): Promise<void> {
    if (observer.writing) return;
    observer.writing = true;
    try {
      const frame = framed(observer.stream);
      while (observer.queue.length && !this.closed) {
        const event = observer.queue.shift()!;
        await writeFrame(frame, sign(this.key, "type" in event
          ? event.type === "todo" ? { type: "todo", scope: this.scope, todo: event } : { type: "presence", scope: this.scope, presence: { reporter: event.reporter, active: event.active } }
          : { type: "event", scope: this.scope, event, dropped: this.dropped }));
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
      await this.consume(frame, stream, peerId, response.reporter as Endpoint & { peerId: string });
    } catch { stream?.abort(new Error("Telemetry connection failed")); }
    finally { this.connecting.delete(id); }
  }
  private async handle(stream: Stream, peerId: PeerId): Promise<void> {
    try {
      const frame = framed(stream);
      const hello = verify(this.key, await readFrame(frame, AbortSignal.timeout(5_000))) as { type?: string; version?: number; scope?: string; reporter?: Endpoint & { peerId?: string } };
      if (hello.type !== "subscribe" || hello.version !== 1 || hello.scope !== this.scope || !validEndpoint(hello.reporter) || hello.reporter?.peerId !== peerId.toString()) throw new Error("Invalid telemetry subscription");
      await writeFrame(frame, sign(this.key, { type: "subscribed", scope: this.scope }));
      await this.consume(frame, stream, peerId, hello.reporter as Endpoint & { peerId: string });
    } catch { stream.abort(new Error("Telemetry subscription rejected")); }
  }
  private async consume(frame: ReturnType<typeof framed>, stream: Stream, peerId: PeerId, reporter: Endpoint & { peerId: string }): Promise<void> {
    const id = peerId.toString();
    if (this.active.has(id) || this.active.size >= 64) { stream.abort(new Error("Duplicate telemetry connection")); return; }
    this.active.add(id);
    this.emit("status", { connected: true, reporter });
    try {
      for (;;) {
        const payload = verify(this.key, await readFrame(frame)) as { type?: string; scope?: string; event?: unknown; presence?: TelemetryPresence; todo?: TelemetryTodo & { type?: string }; dropped?: number };
        if (payload.type === "presence") {
          const presence = payload.presence;
          if (payload.scope !== this.scope || !presence || !onlyKeys(presence, ["reporter", "active"]) || !validEndpoint(presence.reporter) || presence.reporter.peerId !== reporter.peerId || presence.reporter.id !== reporter.id || presence.reporter.epoch !== reporter.epoch || typeof presence.active !== "boolean") throw new Error("Invalid telemetry presence");
          this.emit("presence", presence);
          continue;
        }
        if (payload.type === "todo") {
          const todo = payload.todo;
          if (payload.scope !== this.scope || !todo || todo.type !== "todo" || !validEndpoint(todo.reporter) || todo.reporter.peerId !== reporter.peerId || todo.reporter.id !== reporter.id || todo.reporter.epoch !== reporter.epoch || !validTodos(todo.snapshot)) throw new Error("Invalid telemetry todo");
          this.emit("todo", todo);
          continue;
        }
        if (payload.type !== "event" || payload.scope !== this.scope || !validTelemetryEvent(payload.event, reporter) || !Number.isSafeInteger(payload.dropped) || payload.dropped! < 0) throw new Error("Invalid telemetry event");
        this.emit("event", payload.event);
        if (payload.dropped) this.emit("status", { partial: true, dropped: payload.dropped });
      }
    } catch { /* malformed or disconnected streams are not trusted */ }
    finally { stream.abort(new Error("Telemetry closed")); this.active.delete(id); this.emit("status", { connected: false, peerId: id }); }
  }
}
