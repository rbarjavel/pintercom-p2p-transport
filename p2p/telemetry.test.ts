import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PIntercomClient } from "./client.ts";
import { AgentTelemetry, MAX_TELEMETRY_BODY_BYTES, endpoint, projectMessage, projectArtifacts, validTelemetryEvent, type TelemetryEvent } from "./telemetry.ts";
import type { SessionRegistration } from "../types.ts";

const registration = (name: string): SessionRegistration => ({ name, cwd: "/private/secret", model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
// Keep multicast discovery isolated from p2p/client.test.ts when Node runs files concurrently.
const key = "telemetry-test-key-9876";

async function pair(a: P2PIntercomClient, b: P2PIntercomClient) {
  const an = Reflect.get(a, "node");
  const bn = Reflect.get(b, "node");
  await an.dial(bn.getMultiaddrs());
  await Reflect.apply(Reflect.get(a, "announceToPeer"), a, [bn.peerId]);
  await Reflect.apply(Reflect.get(b, "announceToPeer"), b, [an.peerId]);
}

const wait = async (predicate: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Timed out waiting for telemetry");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("projection whitelists metadata, classifies actions and preserves unknown sizes", () => {
  const from = endpoint({ ...registration("agent"), id: "a", endpointEpoch: "1", hostname: "host-a" }), to = { id: "b", epoch: "2", hostname: "host-b" };
  const message = { id: "m", timestamp: 1, replyTo: "prior", expectsReply: true, retryOf: "retry", supersedes: "old", content: { text: "PRIVATE BODY", attachments: [{ name: "safe", type: "context" as const, content: "SECRET ATTACHMENT" }] } };
  const projected = projectMessage(message, from, to, "failed", [{ path: "folder/file", type: "file", size: 3 }, { path: "folder", type: "directory" }]);
  assert.equal(projected.action, "reply");
  assert.equal(projected.status, "failed");
  assert.equal(projected.retryOf, "retry");
  assert.equal(projected.supersedes, "old");
  assert.equal(projected.from.hostname, "host-a");
  assert.equal(projected.to.hostname, "host-b");
  assert.deepEqual(projected.artifacts?.manifest[1], { path: "folder", type: "directory" });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE BODY|SECRET ATTACHMENT|\/private\/secret/);
  const withBody = projectMessage(message, from, to, "attempted", undefined, true);
  assert.equal(withBody.body, "PRIVATE BODY");
  assert.doesNotMatch(JSON.stringify(withBody), /SECRET ATTACHMENT/);
  const clipped = projectMessage({ ...message, content: { text: "😃".repeat(MAX_TELEMETRY_BODY_BYTES) } }, from, to, "attempted", undefined, true);
  assert.equal(clipped.bodyTruncated, true);
  assert.ok(Buffer.byteLength(clipped.body!, "utf8") <= MAX_TELEMETRY_BODY_BYTES);
  assert.equal(projectMessage({ ...message, replyTo: undefined }, from, to, "attempted").action, "ask");
  assert.equal(projectMessage({ ...message, replyTo: undefined, expectsReply: false }, from, to, "attempted").action, "send");
  const bounded = projectArtifacts([], Array.from({ length: 110 }, (_, i) => ({ path: `file${i}`, type: "file" as const, size: 2 })));
  assert.equal(bounded?.manifest.length, 100);
  assert.equal(bounded?.totalBytes, 220);
  assert.equal(bounded?.omitted, 10);
});

test("schema rejects unrelated reporters, absolute artifact paths and invalid fields", () => {
  const reporter = { id: "a", epoch: "1", peerId: "peer" };
  const event: TelemetryEvent = { version: 1, reporter, eventId: "x", sequence: 1, messageId: "m", from: { id: "a", epoch: "1" }, to: { id: "b", epoch: "1" }, action: "send", timestamp: Date.now(), status: "attempted" };
  assert.equal(validTelemetryEvent(event, reporter), true);
  assert.equal(validTelemetryEvent({ ...event, from: { id: "a", epoch: "1", hostname: "host-a" } }, reporter), true);
  assert.equal(validTelemetryEvent({ ...event, from: { id: "a", epoch: "1", hostname: "x".repeat(129) } }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, from: { id: "c", epoch: "1" } }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, reporter: { ...reporter, peerId: "fake" } }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, body: "safe **markdown**" }, reporter), true);
  assert.equal(validTelemetryEvent({ ...event, body: "x".repeat(MAX_TELEMETRY_BODY_BYTES + 1) }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, action: "receipt", body: "secret" }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, artifacts: { attachments: [], manifest: [{ path: "/etc/shadow", type: "file", size: 1 }], totalCount: 1, totalBytes: 1, omitted: 0 } }, reporter), false);
});

test("P2P telemetry and content default on; explicit opt-outs keep bodies private", async () => {
  const oldKey = process.env.PI_INTERCOM_P2P_KEY;
  const oldTelemetry = process.env.PI_INTERCOM_TELEMETRY;
  const oldContent = process.env.PI_INTERCOM_TELEMETRY_CONTENT;
  delete process.env.PI_INTERCOM_TELEMETRY;
  process.env.PI_INTERCOM_TELEMETRY_CONTENT = "0";
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-intercom-viewer-") );
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_INTERCOM_P2P_KEY = key;
  const emit = AgentTelemetry.prototype.emit;
  const updateTodos = AgentTelemetry.prototype.updateTodos;
  const a = new P2PIntercomClient();
  const b = new P2PIntercomClient();
  const c = new P2PIntercomClient();
  const events: TelemetryEvent[] = [];
  const todos: { reporter: { id: string } }[] = [];
  AgentTelemetry.prototype.emit = function(event) { events.push({ ...event, version: 1, reporter: { id: "test", epoch: "1", peerId: "test" }, eventId: "test", sequence: events.length + 1 }); };
  AgentTelemetry.prototype.updateTodos = function(snapshot) { todos.push({ reporter: { id: Reflect.get(this, "session").id } }); updateTodos.call(this, snapshot); };
  try {
    await a.connect(registration("duplicate"), "a");
    process.env.PI_INTERCOM_TELEMETRY = "0";
    await b.connect(registration("duplicate"), "b");
    await pair(a, b);
    assert.equal((await a.listSessions()).length, 2);
    assert.deepEqual((await b.listSessions()).map((s) => s.id).sort(), ["a", "b"]);
    assert.equal(Reflect.get(b, "telemetry"), null);
    a.updateTodos({ tasks: [{ id: 1, subject: "PRIVATE TODO", status: "pending" }], completed: 0, total: 1, omitted: 0 });
    b.updateTodos({ tasks: [{ id: 1, subject: "PRIVATE TODO", status: "pending" }], completed: 0, total: 1, omitted: 0 });
    assert.equal(todos.length, 0);
    await a.send("b", { text: "SECRET BODY", attachments: [{ name: "source", type: "snippet", content: "SECRET SOURCE" }], expectsReply: true });
    await wait(() => events.length >= 2);
    assert.equal(events[0]?.action, "ask");
    assert.equal(events.at(-1)?.status, "socket_delivered");
    assert.equal(events[0]?.to.id, "b");
    assert.doesNotMatch(JSON.stringify(events), /SECRET BODY|SECRET SOURCE|\/private\/secret/);
    await mkdir(join(root, "files"));
    await writeFile(join(root, "files", "data.txt"), "secret transfer content");
    await a.sendTransfer("b", { text: "SECRET TRANSFER BODY", cwd: root, paths: ["files"] });
    await wait(() => events.some((e) => e.artifacts?.manifest.some((m) => m.path === "files/data.txt") && e.status === "socket_delivered"));
    assert.doesNotMatch(JSON.stringify(events), /secret transfer content|SECRET TRANSFER BODY|\/private\/secret/);
    delete process.env.PI_INTERCOM_TELEMETRY;
    delete process.env.PI_INTERCOM_TELEMETRY_CONTENT;
    await c.connect(registration("content-opt-in"), "c");
    await pair(c, b);
    c.updateTodos({ tasks: [{ id: 1, subject: "Public task", status: "pending" }], completed: 0, total: 1, omitted: 0 });
    await wait(() => todos.some(t => t.reporter.id === "c"));
    assert.doesNotMatch(JSON.stringify(todos), /PRIVATE TODO/);
    await c.send("b", { text: "# Shared heading\n**Markdown body**", attachments: [{ name: "note", type: "context", content: "PRIVATE ATTACHMENT" }] });
    await wait(() => events.some((e) => e.from.id === "c" && e.status === "socket_delivered"));
    assert.equal(events.find((e) => e.from.id === "c")?.body, "# Shared heading\n**Markdown body**");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE ATTACHMENT/);
  } finally {
    await Promise.allSettled([a.disconnect(), b.disconnect(), c.disconnect()]);
    AgentTelemetry.prototype.emit = emit;
    AgentTelemetry.prototype.updateTodos = updateTodos;
    await rm(root, { recursive: true, force: true });
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY; else process.env.PI_INTERCOM_P2P_KEY = oldKey;
    if (oldTelemetry === undefined) delete process.env.PI_INTERCOM_TELEMETRY; else process.env.PI_INTERCOM_TELEMETRY = oldTelemetry;
    if (oldContent === undefined) delete process.env.PI_INTERCOM_TELEMETRY_CONTENT; else process.env.PI_INTERCOM_TELEMETRY_CONTENT = oldContent;
  }
});
