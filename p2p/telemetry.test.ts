import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lpStream } from "@libp2p/utils";
import { P2PIntercomClient } from "./client.ts";
import { AgentTelemetry, TelemetryObserver, TELEMETRY_PROTOCOL, MAX_TELEMETRY_BODY_BYTES, projectMessage, projectArtifacts, validTelemetryEvent, type TelemetryEvent } from "./telemetry.ts";
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
  const from = { id: "a", epoch: "1" }, to = { id: "b", epoch: "2" };
  const message = { id: "m", timestamp: 1, replyTo: "prior", expectsReply: true, retryOf: "retry", supersedes: "old", content: { text: "PRIVATE BODY", attachments: [{ name: "safe", type: "context" as const, content: "SECRET ATTACHMENT" }] } };
  const projected = projectMessage(message, from, to, "failed", [{ path: "folder/file", type: "file", size: 3 }, { path: "folder", type: "directory" }]);
  assert.equal(projected.action, "reply");
  assert.equal(projected.status, "failed");
  assert.equal(projected.retryOf, "retry");
  assert.equal(projected.supersedes, "old");
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
  assert.equal(validTelemetryEvent({ ...event, from: { id: "c", epoch: "1" } }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, reporter: { ...reporter, peerId: "fake" } }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, body: "safe **markdown**" }, reporter), true);
  assert.equal(validTelemetryEvent({ ...event, body: "x".repeat(MAX_TELEMETRY_BODY_BYTES + 1) }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, action: "receipt", body: "secret" }, reporter), false);
  assert.equal(validTelemetryEvent({ ...event, artifacts: { attachments: [], manifest: [{ path: "/etc/shadow", type: "file", size: 1 }], totalCount: 1, totalBytes: 1, omitted: 0 } }, reporter), false);
});

test("observer rejects wrong key, scope, oversized frames and unrelated reports", async () => {
  const oldKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = key;
  const observer = new TelemetryObserver();
  // Exercise the legacy inbound authentication path without automatic subscriptions racing it.
  Reflect.set(observer, "subscribe", async () => undefined);
  const connectPeer = AgentTelemetry.prototype.connectPeer;
  Reflect.set(AgentTelemetry.prototype, "connectPeer", async () => undefined);
  const agent = new P2PIntercomClient();
  const seen: unknown[] = [];
  const activities: unknown[] = [];
  observer.on("event", (event) => seen.push(event));
  observer.on("presence", (activity) => activities.push(activity));
  const signed = (payload: unknown, secret = key) => ({ payload, mac: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") });
  try {
    await observer.start();
    await agent.connect(registration("agent"), "agent");
    const node = Reflect.get(agent, "node");
    await node.peerStore.merge(observer.node!.peerId, { multiaddrs: observer.node!.getMultiaddrs() });
    const reporter = { id: "agent", epoch: (await agent.listSessions())[0]!.endpointEpoch!, peerId: node.peerId.toString() };
    const send = async (payload: unknown, secret = key) => {
      const stream = await node.dialProtocol(observer.node!.peerId, TELEMETRY_PROTOCOL);
      const frame = lpStream(stream);
      await frame.write(new TextEncoder().encode(JSON.stringify(signed(payload, secret))));
      return { stream, frame };
    };
    const hello = { type: "subscribe", version: 1, reporter, scope: undefined };
    const badKey = await send(hello, "different-shared-key");
    badKey.stream.abort(new Error("test done"));
    const badScope = await send({ ...hello, scope: "wrong" });
    badScope.stream.abort(new Error("test done"));
    const malformed = await node.dialProtocol(observer.node!.peerId, TELEMETRY_PROTOCOL);
    await lpStream(malformed).write(new TextEncoder().encode("{not json"));
    malformed.abort(new Error("test done"));
    const oversized = await node.dialProtocol(observer.node!.peerId, TELEMETRY_PROTOCOL);
    await lpStream(oversized).write(new Uint8Array(70_000));
    oversized.abort(new Error("test done"));
    const good = await send(hello);
    await good.frame.read(); // signed subscription acknowledgement
    const invalid: TelemetryEvent = { version: 1, reporter, eventId: "x", sequence: 1, messageId: "m", from: { id: "other", epoch: "1" }, to: { id: "stranger", epoch: "1" }, action: "send", status: "attempted", timestamp: Date.now() };
    await good.frame.write(new TextEncoder().encode(JSON.stringify(signed({ type: "event", scope: undefined, event: invalid, dropped: 0 }))));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(seen, []);
    good.stream.abort(new Error("test done"));
    const forged = await send(hello);
    await forged.frame.read();
    await forged.frame.write(new TextEncoder().encode(JSON.stringify(signed({ type: "presence", scope: undefined, presence: { reporter: { id: "other", epoch: "1", peerId: reporter.peerId }, active: true } }))));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(activities, [], "an agent cannot claim another agent is working");
    forged.stream.abort(new Error("test done"));
  } finally {
    await Promise.allSettled([agent.disconnect(), observer.stop()]);
    Reflect.set(AgentTelemetry.prototype, "connectPeer", connectPeer);
    if (oldKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY; else process.env.PI_INTERCOM_P2P_KEY = oldKey;
  }
});

test("observer discovers and subscribes to agents even without an inbound observer connection", async () => {
  const oldKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = key;
  const observer = new TelemetryObserver();
  const agent = new P2PIntercomClient();
  const seen: TelemetryEvent[] = [];
  const presence: { reporter: { id: string }; active: boolean }[] = [];
  const connectPeer = AgentTelemetry.prototype.connectPeer;
  observer.on("event", (event: TelemetryEvent) => seen.push(event));
  observer.on("presence", (update) => presence.push(update));
  try {
    await observer.start();
    // Simulate a blocked viewer TCP port: the agent cannot initiate a subscription.
    Reflect.set(AgentTelemetry.prototype, "connectPeer", async () => undefined);
    await agent.connect(registration("outbound-only"), "outbound-only");
    await wait(() => Reflect.get(observer, "active").size === 1, 10_000);
    assert.equal(Reflect.get(Reflect.get(agent, "telemetry"), "observers").size, 1);
    await wait(() => presence.length >= 1);
    assert.equal(presence[0]?.active, false);
    agent.updatePresence({ status: "thinking · private note" });
    await wait(() => presence.length === 2);
    assert.deepEqual(presence.map((update) => update.active), [false, true]);
    agent.updatePresence({ status: "tool:bash" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(presence.length, 2, "working-to-working transitions do not flood telemetry");
    agent.updatePresence({ status: "idle" });
    await wait(() => presence.length === 3);
    assert.equal(presence[2]?.active, false);
    assert.doesNotMatch(JSON.stringify(presence), /private note|tool:bash/);
    const session = (await agent.listSessions())[0]!;
    Reflect.get(agent, "telemetry").emit({ messageId: "mac-to-mac", from: { id: session.id, epoch: session.endpointEpoch! }, to: { id: "other-mac", epoch: "other-epoch" }, action: "send", timestamp: Date.now(), status: "attempted", body: "# Mac conversation" });
    await wait(() => seen.some((event) => event.messageId === "mac-to-mac"));
    assert.equal(seen.at(-1)?.body, "# Mac conversation");
  } finally {
    Reflect.set(AgentTelemetry.prototype, "connectPeer", connectPeer);
    await Promise.allSettled([agent.disconnect(), observer.stop()]);
    if (oldKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY; else process.env.PI_INTERCOM_P2P_KEY = oldKey;
  }
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
  const observer = new TelemetryObserver();
  const a = new P2PIntercomClient();
  const b = new P2PIntercomClient();
  const c = new P2PIntercomClient();
  const events: TelemetryEvent[] = [];
  observer.on("event", (e: TelemetryEvent) => events.push(e));
  try {
    await observer.start();
    await a.connect(registration("duplicate"), "a");
    process.env.PI_INTERCOM_TELEMETRY = "0";
    await b.connect(registration("duplicate"), "b");
    await pair(a, b);
    const telemetry = Reflect.get(a, "telemetry");
    const observerNode = observer.node!;
    const aNode = Reflect.get(a, "node");
    await aNode.peerStore.merge(observerNode.peerId, { multiaddrs: observerNode.getMultiaddrs() });
    await telemetry.connectPeer(observerNode.peerId);
    await wait(() => Reflect.get(telemetry, "observers").size > 0);
    assert.equal((await a.listSessions()).length, 2);
    assert.deepEqual((await b.listSessions()).map((s) => s.id).sort(), ["a", "b"]);
    assert.equal(Reflect.get(b, "telemetry"), null);
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
    const cTelemetry = Reflect.get(c, "telemetry");
    const cNode = Reflect.get(c, "node");
    await cNode.peerStore.merge(observerNode.peerId, { multiaddrs: observerNode.getMultiaddrs() });
    await cTelemetry.connectPeer(observerNode.peerId);
    await wait(() => Reflect.get(cTelemetry, "observers").size > 0);
    await c.send("b", { text: "# Shared heading\n**Markdown body**", attachments: [{ name: "note", type: "context", content: "PRIVATE ATTACHMENT" }] });
    await wait(() => events.some((e) => e.from.id === "c" && e.status === "socket_delivered"));
    assert.equal(events.find((e) => e.from.id === "c")?.body, "# Shared heading\n**Markdown body**");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE ATTACHMENT/);
  } finally {
    await Promise.allSettled([a.disconnect(), b.disconnect(), c.disconnect(), observer.stop()]);
    await rm(root, { recursive: true, force: true });
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY; else process.env.PI_INTERCOM_P2P_KEY = oldKey;
    if (oldTelemetry === undefined) delete process.env.PI_INTERCOM_TELEMETRY; else process.env.PI_INTERCOM_TELEMETRY = oldTelemetry;
    if (oldContent === undefined) delete process.env.PI_INTERCOM_TELEMETRY_CONTENT; else process.env.PI_INTERCOM_TELEMETRY_CONTENT = oldContent;
  }
});
