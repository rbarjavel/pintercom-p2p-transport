import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

// Structural subset of TelemetryEvent; the observer's event payload supplies these fields.
export type ViewerEvent = {
  messageId: string; from: { id: string; epoch: string; name?: string; hostname?: string };
  to: { id: string; epoch: string; name?: string; hostname?: string };
  reporter: { id: string; epoch: string; peerId: string; name?: string; hostname?: string }; eventId: string; sequence: number; version: 1;
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

/** Caller owns observer.start/stop and server.listen; LAN access is unauthenticated and can expose message text. */
export function createViewerServer(observer: EventEmitter): Server {
  const interactions = new Map<string, Interaction>();
  const seen = new Map<string, Set<string>>();
  const clients = new Set<ServerResponse>();
  const reporters = new Set<string>();
  const presence = new Map<string, { peer: ViewerEvent["from"]; active: boolean }>();
  const layout = new Map<string, [number, number]>();
  const machineByKey = new Map<string, string>();
  let layoutRevision = 0;
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
  const laneKey = (peer: ViewerEvent["from"]) => JSON.stringify([peer.id, peer.epoch]);
  const machineKey = (peer: ViewerEvent["from"]) => peer.hostname?.trim().toLowerCase() || `unknown:${laneKey(peer)}`;
  const place = (peer: ViewerEvent["from"]) => {
    const key = laneKey(peer), machine = machineKey(peer);
    if (!machineByKey.has(key) || peer.hostname?.trim()) machineByKey.set(key, machine);
    if (layout.has(key)) return;
    const members = [...layout].filter(([id]) => machineByKey.get(id) === machine);
    let position: [number, number];
    if (members.length) position = [Math.min(...members.map(([, [x]]) => x)), Math.max(...members.map(([, [, y]]) => y)) + 120];
    else position = [layout.size ? Math.max(...[...layout.values()].map(([x]) => x + 190)) + 300 : 0, 0];
    layout.set(key, position);
    broadcast("layout", { key, position, revision: ++layoutRevision });
  };
  const pruneLayout = () => {
    const alive = new Set([...presence.values()].map(({ peer }) => laneKey(peer)));
    for (const item of interactions.values()) { alive.add(laneKey(item.from)); alive.add(laneKey(item.to)); }
    for (const key of layout.keys()) if (!alive.has(key)) { layout.delete(key); machineByKey.delete(key); }
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
    if (event.from.hostname && !interaction.from.hostname) interaction.from = event.from;
    if (event.to.hostname && !interaction.to.hostname) interaction.to = event.to;
    if (event.action !== "receipt" && interaction.action === "receipt") interaction.action = event.action;
    if (event.artifacts) interaction.artifacts = event.artifacts;
    if (event.body !== undefined) { interaction.body = event.body; interaction.bodyTruncated = event.bodyTruncated; }
    interaction.updates.push({ eventId: event.eventId, action: event.action, status: event.status, timestamp: event.timestamp, sequence: event.sequence, reporter: event.reporter.name ?? event.reporter.id });
    if ((statusRank[event.status] ?? 0) >= (statusRank[interaction.status] ?? 0)) interaction.status = event.status;
    if (interaction.updates.length > MAX_UPDATES) interaction.updates.shift();
    place(event.from); place(event.to);
    if (evicted) pruneLayout();
    broadcast("interaction", { interaction, evicted, truncated, partial });
  };
  const onPresence = (update: { reporter: ViewerEvent["reporter"]; active: boolean }) => {
    const { peerId, ...peer } = update.reporter;
    presence.set(peerId, { peer, active: update.active });
    place(peer);
    broadcast("presence", { peer, active: update.active, connected: true });
  };
  const onStatus = (status: { partial?: boolean; dropped?: number; connected?: boolean; reporter?: { peerId: string }; peerId?: string }) => {
    if (status.partial) partial = true;
    if (status.connected && status.reporter?.peerId) reporters.add(status.reporter.peerId);
    if (status.connected === false && status.peerId) {
      reporters.delete(status.peerId);
      const old = presence.get(status.peerId);
      if (old) { presence.delete(status.peerId); pruneLayout(); broadcast("presence", { ...old, active: false, connected: false }); }
    }
    broadcast("status", { ...status, connectedReporters: reporters.size, truncated, partial });
  };
  observer.on("event", onEvent);
  observer.on("presence", onPresence);
  observer.on("status", onStatus);

  const server = createServer(async (request, response) => {
    const port = (server.address() as { port?: number } | null)?.port;
    const host = request.headers.host?.toLowerCase();
    const local = request.socket.localAddress;
    // Only accept an IP literal for the interface reached (or localhost on loopback), not a rebinding DNS name.
    if (!port || !host || !local || (host !== `${local}:${port}` && !(local === "127.0.0.1" && host === `localhost:${port}`))
      || (request.headers.origin && request.headers.origin.toLowerCase() !== `http://${host}`)) {
      response.writeHead(403).end("Forbidden"); return;
    }
    const path = request.url?.split("?", 1)[0];
    if ((path === "/layout" || path === "/layout/group") && request.method === "POST") {
      if (request.headers["content-type"] !== "application/json") { response.writeHead(415).end("Expected JSON"); return; }
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 1024) { response.writeHead(413).end("Layout update too large"); return; } }
        const data = JSON.parse(body) as Record<string, unknown>;
        if (path === "/layout/group") {
          if (typeof data.machine !== "string" || typeof data.dx !== "number" || typeof data.dy !== "number" || !Number.isFinite(data.dx) || !Number.isFinite(data.dy)) throw new Error("Invalid group movement");
          const moved: [string, [number, number]][] = [];
          const dx = data.dx, dy = data.dy;
          for (const [key, [x, y]] of layout) if (machineByKey.get(key) === data.machine) moved.push([key, [x + dx, y + dy]]);
          if (!moved.length || moved.some(([, position]) => position.some((coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 1_000_000))) throw new Error("Invalid group movement");
          for (const [key, position] of moved) layout.set(key, position);
          const revision = ++layoutRevision;
          broadcast("layout", { moved, revision });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ moved, revision }));
        } else {
          if (typeof data.key !== "string" || !layout.has(data.key) || typeof data.x !== "number" || typeof data.y !== "number" || !Number.isFinite(data.x) || !Number.isFinite(data.y) || Math.abs(data.x) > 1_000_000 || Math.abs(data.y) > 1_000_000) throw new Error("Invalid layout update");
          const position: [number, number] = [data.x, data.y];
          layout.set(data.key, position);
          broadcast("layout", { key: data.key, position, revision: ++layoutRevision });
          response.writeHead(204).end();
        }
      } catch { response.writeHead(400).end("Invalid layout update"); }
      return;
    }
    if (path === "/layout/reset" && request.method === "POST") {
      const groups = new Map<string, { x: number; count: number }>();
      for (const key of layout.keys()) {
        const machine = machineByKey.get(key) ?? `unknown:${key}`;
        let group = groups.get(machine);
        if (!group) { group = { x: groups.size * 490, count: 0 }; groups.set(machine, group); }
        layout.set(key, [group.x, group.count++ * 120]);
      }
      broadcast("layout", { positions: [...layout], revision: ++layoutRevision });
      response.writeHead(204).end(); return;
    }
    if (request.method !== "GET") { response.writeHead(405, { Allow: "GET, POST" }).end(); return; }
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
      let snapshot = { interactions: [...interactions.values()], presence: [...presence.values()], layout: [...layout], layoutRevision, connectedReporters: reporters.size, truncated, partial };
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
    observer.off("presence", onPresence);
    observer.off("status", onStatus);
    for (const client of clients) client.end();
    clients.clear();
  });
  return server;
}
