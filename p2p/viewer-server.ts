import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

// Structural subset of TelemetryEvent; the observer's event payload supplies these fields.
export type ViewerEvent = {
  messageId: string; from: { id: string; epoch: string; name?: string };
  to: { id: string; epoch: string; name?: string };
  reporter: { id: string; epoch: string; peerId: string; name?: string }; eventId: string; sequence: number; version: 1;
  action: string; timestamp: number; status: string;
  replyTo?: string; retryOf?: string; supersedes?: string;
  body?: string; bodyTruncated?: boolean;
  artifacts?: { attachments: { name: string; type: string }[]; manifest: { path: string; type: string; size?: number }[]; totalCount: number; totalBytes: number; omitted: number };
};

const MAX_INTERACTIONS = 1_000;
const MAX_UPDATES = 16;
const MAX_CLIENTS = 64;
const MAX_BUFFER = 4 * 1024 * 1024;
const statusRank: Record<string, number> = {
  attempted: 0, failed: 1, socket_delivered: 2, queued: 3,
  cancellation_requested: 3, receiver_received: 4, injected: 5,
  acknowledged: 6, expired: 7, cancelled: 7, superseded: 7,
};
const html = new URL("./viewer.html", import.meta.url);

type Update = Pick<ViewerEvent, "action" | "status" | "timestamp" | "eventId" | "sequence"> & { reporter: string };
type Interaction = Pick<ViewerEvent, "messageId" | "from" | "to" | "action" | "timestamp" | "replyTo" | "retryOf" | "supersedes" | "artifacts" | "body" | "bodyTruncated"> & {
  id: string;
  linkedTo?: string;
  status: string;
  updates: Update[];
};

/** Caller owns observer.start/stop and server.listen; listen on 127.0.0.1, not a public interface. */
export function createViewerServer(observer: EventEmitter): Server {
  const interactions = new Map<string, Interaction>();
  const seen = new Map<string, Set<string>>();
  const clients = new Set<ServerResponse>();
  const reporters = new Set<string>();
  let truncated = false;
  let partial = false;
  const send = (response: ServerResponse, name: string, data: unknown) => {
    // ponytail: reconnect a slow browser for a fresh snapshot instead of retaining an unbounded write queue.
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    if (response.writableLength + Buffer.byteLength(frame) > MAX_BUFFER) { response.destroy(); return; }
    response.write(frame);
  };
  const broadcast = (name: string, data: unknown) => {
    for (const client of clients) send(client, name, data);
  };
  const onEvent = (event: ViewerEvent) => {
    const originalId = JSON.stringify([event.from.id, event.from.epoch, event.messageId]);
    const id = event.action === "cancel" ? JSON.stringify([event.from.id, event.from.epoch, event.messageId, "cancel"]) : originalId;
    const eventKey = `${event.reporter.peerId}:${event.eventId}`;
    if (seen.get(id)?.has(eventKey)) return;
    let interaction = interactions.get(id);
    let evicted: string | undefined;
    if (!interaction) {
      interaction = {
        id, messageId: event.messageId, from: event.from, to: event.to,
        ...(event.action === "cancel" ? { linkedTo: originalId } : {}),
        action: event.action, timestamp: event.timestamp, status: event.status, replyTo: event.replyTo,
        retryOf: event.retryOf, supersedes: event.supersedes, artifacts: event.artifacts,
        body: event.body, bodyTruncated: event.bodyTruncated,
        updates: [],
      };
      interactions.set(id, interaction);
      if (interactions.size > MAX_INTERACTIONS) {
        evicted = interactions.keys().next().value;
        if (evicted) { interactions.delete(evicted); seen.delete(evicted); truncated = true; }
      }
    }
    const ids = seen.get(id) ?? new Set<string>();
    ids.add(eventKey);
    if (ids.size > 128) ids.delete(ids.values().next().value!);
    seen.set(id, ids);
    if (event.action !== "receipt" && interaction.action === "receipt") interaction.action = event.action;
    if (event.artifacts) interaction.artifacts = event.artifacts;
    if (event.body !== undefined) { interaction.body = event.body; interaction.bodyTruncated = event.bodyTruncated; }
    interaction.updates.push({ eventId: event.eventId, action: event.action, status: event.status, timestamp: event.timestamp, sequence: event.sequence, reporter: event.reporter.name ?? event.reporter.id });
    if ((statusRank[event.status] ?? 0) >= (statusRank[interaction.status] ?? 0)) interaction.status = event.status;
    if (interaction.updates.length > MAX_UPDATES) interaction.updates.shift();
    broadcast("interaction", { interaction, evicted, truncated, partial });
  };
  const onStatus = (status: { partial?: boolean; dropped?: number; connected?: boolean; reporter?: { peerId: string }; peerId?: string }) => {
    if (status.partial) partial = true;
    if (status.connected && status.reporter?.peerId) reporters.add(status.reporter.peerId);
    if (status.connected === false && status.peerId) reporters.delete(status.peerId);
    broadcast("status", { ...status, connectedReporters: reporters.size, truncated, partial });
  };
  observer.on("event", onEvent);
  observer.on("status", onStatus);

  const server = createServer(async (request, response) => {
    const port = (server.address() as { port?: number } | null)?.port;
    const host = request.headers.host?.toLowerCase();
    const remote = request.socket.remoteAddress;
    if (!port || !host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "")
      || (request.headers.origin && request.headers.origin.toLowerCase() !== `http://${host}`)) {
      response.writeHead(403).end("Forbidden"); return;
    }
    if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }).end(); return; }
    const path = request.url?.split("?", 1)[0];
    if (path === "/events") {
      if (clients.size >= MAX_CLIENTS) { response.writeHead(503).end("Too many viewers"); return; }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      clients.add(response);
      response.on("close", () => clients.delete(response));
      let snapshot = { interactions: [...interactions.values()], connectedReporters: reporters.size, truncated, partial };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BUFFER - 1024) {
        // ponytail: trim snapshot artifact descriptors before an oversized write; totals and omitted counts remain accurate.
        snapshot = { ...snapshot, interactions: snapshot.interactions.map((interaction) => {
          const a = interaction.artifacts;
          if (!a) return interaction;
          const attachment = a.attachments[0];
          const manifest = attachment ? undefined : a.manifest[0];
          return { ...interaction, artifacts: { ...a, attachments: attachment ? [attachment] : [], manifest: manifest ? [manifest] : [], omitted: a.totalCount - (attachment || manifest ? 1 : 0) } };
        }) };
      }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BUFFER - 1024) {
        // Keep all interactions, but cap body previews in an oversized reconnect snapshot.
        snapshot = { ...snapshot, interactions: snapshot.interactions.map((interaction) => interaction.body && interaction.body.length > 512
          ? { ...interaction, body: interaction.body.slice(0, 512), bodyTruncated: true }
          : interaction) };
      }
      send(response, "snapshot", snapshot);
    } else if (path === "/" || path === "/viewer.html") {
      try {
        const page = await readFile(html, "utf8");
        const hash = (source: string) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
        const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const style = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; img-src 'self'`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        }).end(page);
      } catch { response.writeHead(500).end("Viewer unavailable"); }
    } else response.writeHead(404).end("Not found");
  });
  const heartbeat = setInterval(() => { for (const client of clients) if (client.writableLength > MAX_BUFFER) client.destroy(); else client.write(": keepalive\n\n"); }, 15_000);
  heartbeat.unref();
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const client of clients) client.end();
    return close(callback);
  };
  server.on("close", () => {
    clearInterval(heartbeat);
    observer.off("event", onEvent);
    observer.off("status", onStatus);
    for (const client of clients) client.end();
    clients.clear();
  });
  return server;
}
