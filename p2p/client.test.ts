import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { confirmP2PListenAddresses, p2pMdnsAnswers, P2PIntercomClient } from "./client.ts";
import type { Message, SessionRegistration } from "../types.ts";
import { EvidenceStore, EVIDENCE_TRANSFER_PROTOCOL, type EvidenceOrigin } from "../evidence.ts";
import { registerEvidence } from "../evidence-extension.ts";

function registration(name: string): SessionRegistration {
  return {
    name,
    cwd: process.cwd(),
    model: "test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

test("p2p confirms every bound address for link-local mDNS advertisement", () => {
  const addresses = [{ id: "loopback" }, { id: "public-range-lan" }];
  const confirmed: Array<{ address: unknown; type: string }> = [];

  confirmP2PListenAddresses({
    transportManager: { getAddrs: () => addresses },
    addressManager: {
      confirmObservedAddr: (address, { type }) => confirmed.push({ address, type }),
    },
  } as never);

  assert.deepEqual(confirmed, addresses.map((address) => ({ address, type: "transport" })));
});

test("p2p mDNS advertises bound public-range LAN addresses", () => {
  const answers = p2pMdnsAnswers("_pi-intercom._udp.local", "peer", [
    { toString: () => "/ip4/70.0.0.138/tcp/52180/p2p/peer" },
  ]);

  assert.equal(answers[1]?.data, "dnsaddr=/ip4/70.0.0.138/tcp/52180/p2p/peer");
});

async function wirePair(sender: P2PIntercomClient, receiver: P2PIntercomClient): Promise<void> {
  const senderNode = Reflect.get(sender, "node");
  const receiverNode = Reflect.get(receiver, "node");
  await senderNode.dial(receiverNode.getMultiaddrs());
  await Reflect.apply(Reflect.get(sender, "announceToPeer"), sender, [receiverNode.peerId]);
  await Reflect.apply(Reflect.get(receiver, "announceToPeer"), receiver, [senderNode.peerId]);
}

test("p2p clients exchange authenticated messages over an encrypted libp2p stream", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();

  try {
    await sender.connect(registration("sender"), "sender-id");
    await receiver.connect({
      ...registration("receiver"),
      hostname: "remote-device",
      os: "Linux arm64",
      sshRemote: "root@device.local",
    }, "receiver-id");

    // Make discovery deterministic in the test; production uses the same
    // announce handshake after mDNS emits peer:discovery.
    await wirePair(sender, receiver);

    const sessions = await sender.listSessions();
    assert.deepEqual(sessions.map((session) => session.id).sort(), ["receiver-id", "sender-id"]);
    assert.partialDeepStrictEqual(sessions.find((session) => session.id === "receiver-id"), {
      hostname: "remote-device",
      os: "Linux arm64",
      sshRemote: "root@device.local",
    });

    const received = new Promise<string>((resolve) => {
      receiver.once("message", (_from, message) => resolve(message.content.text));
    });
    const result = await sender.send("receiver-id", { text: "hello over p2p" });

    assert.equal(result.delivered, true);
    assert.equal(await received, "hello over p2p");
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    if (previousKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY;
    else process.env.PI_INTERCOM_P2P_KEY = previousKey;
  }
});

test("p2p clients stream a folder and deliver its instruction message after commit", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-intercom-p2p-transfer-"));
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();

  try {
    await mkdir(join(root, "source", "folder"), { recursive: true });
    await writeFile(join(root, "source", "folder", "hello.bin"), Uint8Array.from([0, 1, 2, 255]));
    await sender.connect(registration("sender"), "sender-id");
    await receiver.connect(registration("receiver"), "receiver-id");
    await wirePair(sender, receiver);

    const received = new Promise<{ text: string; transferPath: string }>((resolve) => {
      receiver.once("message", (_from, message) => {
        const attachment = message.content.attachments?.at(-1);
        const transferPath = attachment?.content.match(/Saved under ([^\n]+)/)?.[1] ?? "";
        resolve({ text: message.content.text, transferPath });
      });
    });
    const result = await sender.sendTransfer("receiver-id", {
      text: "Inspect this folder",
      paths: ["folder"],
      cwd: join(root, "source"),
    });
    const message = await received;

    assert.equal(result.delivered, true);
    assert.equal(message.text, "Inspect this folder");
    assert.deepEqual(await readFile(join(message.transferPath, "folder", "hello.bin")), Buffer.from([0, 1, 2, 255]));
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    await rm(root, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY;
    else process.env.PI_INTERCOM_P2P_KEY = previousKey;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("P2P evidence survives sender shutdown, source deletion, compaction and receiver extension restart", async () => {
  const keys = ["PI_INTERCOM_P2P_KEY", "PI_CODING_AGENT_DIR", "PI_INTERCOM_EVIDENCE_MAX_BYTES"] as const;
  const previous = keys.map(key => process.env[key]);
  const root = await mkdtemp(join(tmpdir(), "pi-intercom-evidence-p2p-"));
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES;
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();
  try {
    const source = new EvidenceStore("sender-evidence");
    const origin: EvidenceOrigin = { sessionId: "sender-evidence", toolCallId: "large-test-log", toolName: "bash", cwd: "/sender/repo",
      timestamp: Date.now(), workspace: "abc123; dirty", input: "npm test", isError: true, coverage: "full-output-file", truncated: false, omittedNonText: false };
    const text = Array.from({ length: 60_000 }, (_, i) => `${i + 1}: ${i === 30_000 ? "EXACT MIDDLE FAILURE" : "normal output"} ${"x".repeat(100)}`).join("\n");
    const record = await source.retain(origin, { text });
    assert.ok(record.bytes > 5 * 1024 * 1024);
    await sender.connect(registration("sender"), "sender-evidence");
    await receiver.connect(registration("receiver"), "receiver-evidence");
    await wirePair(sender, receiver);
    const received = new Promise<Message>(resolve => receiver.once("message", (_from, message) => resolve(message)));
    const result = await sender.sendTransfer("receiver-evidence", { text: "Cancellation may be responsible; unconfirmed.", paths: [source.directory(record.id)], cwd: root,
      evidence: { id: record.id, offset: 30_001, limit: 2 } });
    assert.equal(result.delivered, true);
    const message = await received;
    const card = message.content.attachments![0]!.content;
    assert.match(card, /EXACT MIDDLE FAILURE/);
    assert.ok(card.length < 6000, "full multi-megabyte output must not enter model context");
    assert.ok(!card.includes(source.directory(record.id)), "recipient uses its own reference, not the sender's path");
    await sender.disconnect();
    await source.delete(record.id);
    await receiver.disconnect();
    const resumed = new EvidenceStore("receiver-evidence");
    const imported = (await resumed.list("Cancellation")).records[0]!;
    assert.deepEqual(imported.origin, origin);
    assert.equal(imported.sha256, record.sha256);
    assert.equal((await resumed.read(imported.id, 30_001, 1)).text, text.split("\n")[30_000]);
    for (let i = 0; i < 2; i++) {
      let contextHook: Function = () => undefined;
      registerEvidence({ registerTool: () => undefined, on: (name: string, handler: Function) => { if (name === "context") contextHook = handler; } } as never,
        () => "receiver-evidence");
      const context = await contextHook({ messages: [{ role: "compactionSummary", summary: "Compacted", tokensBefore: 100000, timestamp: 1 }] }, {});
      assert.match(context.messages.at(-1).content, new RegExp(imported.id));
    }
    await resumed.delete(imported.id);
    assert.equal((await resumed.list()).total, 0);
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

test("P2P rejects evidence when storage is full or the peer lacks evidence support", async () => {
  const keys = ["PI_INTERCOM_P2P_KEY", "PI_CODING_AGENT_DIR", "PI_INTERCOM_EVIDENCE_MAX_BYTES"] as const;
  const previous = keys.map(key => process.env[key]);
  const root = await mkdtemp(join(tmpdir(), "pi-intercom-evidence-reject-"));
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES;
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();
  try {
    const source = new EvidenceStore("sender-evidence");
    const record = await source.retain({ sessionId: "sender-evidence", toolCallId: "test", toolName: "bash", cwd: root, timestamp: Date.now(), workspace: "unknown",
      input: "test", isError: false, coverage: "tool-result", truncated: false, omittedNonText: false }, { text: "output" });
    await sender.connect(registration("sender"), "sender-evidence");
    await receiver.connect(registration("receiver"), "receiver-evidence");
    await wirePair(sender, receiver);
    let delivered = 0;
    receiver.on("message", () => delivered++);
    const options = { text: "finding", paths: [source.directory(record.id)], cwd: root, evidence: { id: record.id, offset: 1, limit: 2 } };
    process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES = "1";
    const result = await sender.sendTransfer("receiver-evidence", options);
    assert.equal(result.delivered, false);
    assert.match(result.reason!, /storage limit/);
    assert.equal(delivered, 0);
    assert.equal((await new EvidenceStore("receiver-evidence").list()).total, 0);
    delete process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES;
    await Reflect.get(receiver, "node").unhandle(EVIDENCE_TRANSFER_PROTOCOL);
    await assert.rejects(sender.sendTransfer("receiver-evidence", options));
    assert.equal(delivered, 0);
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

test("p2p requests time out when a peer stops responding", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  const previousTimeout = process.env.PI_INTERCOM_P2P_TIMEOUT_MS;
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();

  try {
    await sender.connect(registration("sender"), "sender-id");
    await receiver.connect(registration("receiver"), "receiver-id");
    await wirePair(sender, receiver);
    process.env.PI_INTERCOM_P2P_TIMEOUT_MS = "100";
    Reflect.set(receiver, "handleStream", async () => {});

    await assert.rejects(sender.send("receiver-id", { text: "no reply" }), /timed out/i);
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    if (previousKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY;
    else process.env.PI_INTERCOM_P2P_KEY = previousKey;
    if (previousTimeout === undefined) delete process.env.PI_INTERCOM_P2P_TIMEOUT_MS;
    else process.env.PI_INTERCOM_P2P_TIMEOUT_MS = previousTimeout;
  }
});

test("p2p prunes routes for a disconnected peer after session rebinding", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  try {
    const client = new P2PIntercomClient();
    const peer = (id: string) => ({ toString: () => id, equals: (other: { toString(): string }) => other.toString() === id });
    const oldPeer = peer("old-peer");
    const newPeer = peer("new-peer");
    const session = { ...registration("peer"), id: "peer-id", endpointEpoch: "old" };
    Reflect.set(client, "_sessionId", "self-id");
    Reflect.apply(Reflect.get(client, "upsertPeer"), client, [oldPeer, session]);
    Reflect.get(client, "inboundRoutes").set("inbound", oldPeer);
    Reflect.get(client, "outboundRoutes").set("outbound", oldPeer);
    Reflect.apply(Reflect.get(client, "upsertPeer"), client, [newPeer, { ...session, endpointEpoch: "new" }]);

    Reflect.apply(Reflect.get(client, "removePeer"), client, [oldPeer]);

    assert.equal(Reflect.get(client, "inboundRoutes").has("inbound"), false);
    assert.equal(Reflect.get(client, "outboundRoutes").has("outbound"), false);
    assert.equal(Reflect.get(client, "sessionByPeer").get("new-peer"), "peer-id");
    const cancelled = await client.cancelMessage("outbound");
    assert.equal(cancelled.delivered, false);
    assert.match(cancelled.reason ?? "", /no longer connected/i);
  } finally {
    if (previousKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY;
    else process.env.PI_INTERCOM_P2P_KEY = previousKey;
  }
});
