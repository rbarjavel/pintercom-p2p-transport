import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore, parseEvidenceSelection, type EvidenceOrigin } from "./evidence.ts";
import { registerEvidence } from "./evidence-extension.ts";

const origin: EvidenceOrigin = { sessionId: "producer", toolCallId: "call-1", toolName: "bash", cwd: "/repo",
  timestamp: Date.now(), workspace: "abc123; dirty", input: '{"command":"npm test"}', isError: true,
  coverage: "tool-result", truncated: "unknown", omittedNonText: false };

function harness(sessionId: string, cwd: string) {
  const handlers = new Map<string, Function>();
  let tool: any;
  registerEvidence({ on: (name: string, handler: Function) => handlers.set(name, handler), registerTool: (t: unknown) => { tool = t; } } as never,
    ctx => ctx.sessionManager.getSessionId());
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => sessionId, getLeafId: () => "branch-1" } };
  return { ctx, capture: (event: unknown) => handlers.get("tool_result")!(event, ctx),
    context: (messages: unknown[] = []) => handlers.get("context")!({ messages }, ctx),
    execute: (params: unknown) => tool.execute("lookup", params, undefined, undefined, ctx) };
}

async function isolated(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-"));
  const keys = ["PI_CODING_AGENT_DIR", "PI_INTERCOM_SCOPE_ID", "PI_INTERCOM_EVIDENCE_MAX_BYTES"] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_INTERCOM_SCOPE_ID;
  delete process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES;
  try { await fn(root); }
  finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
}

test("evidence persists offline with exact bounded reads, metadata lookup, and explicit local deletion", async () => isolated(async root => {
  const store = new EvidenceStore("producer");
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
  const record = await store.retain(origin, { text });
  const resumed = new EvidenceStore("producer");
  assert.equal((await resumed.list("npm test")).total, 1);
  assert.equal((await resumed.list("line 4000")).total, 0, "lookup searches metadata, not output bodies");
  const result = await resumed.read(record.id, 4000, 2);
  assert.equal(result.text, "line 4000\nline 4001");
  assert.equal(result.nextOffset, 4002);
  assert.deepEqual(result.record.origin, origin);
  assert.equal((await new EvidenceStore("another-session").list()).total, 0);
  process.env.PI_INTERCOM_SCOPE_ID = "another-scope";
  assert.equal((await new EvidenceStore("producer").list()).total, 0);
  delete process.env.PI_INTERCOM_SCOPE_ID;
  if (process.platform !== "win32") {
    assert.equal((await stat(store.directory(record.id))).mode & 0o777, 0o700);
    assert.equal((await stat(join(store.directory(record.id), "output.txt"))).mode & 0o777, 0o600);
  }
  await resumed.delete(record.id);
  assert.equal((await resumed.list()).total, 0);
  await assert.rejects(resumed.get(record.id), /ENOENT/);
  assert.ok(root);
}));

test("quota failures and parallel captures never evict existing evidence or leave partial writes", async () => isolated(async () => {
  process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES = "2500";
  const store = new EvidenceStore("producer");
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.retain(origin, { text: "x".repeat(900) })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const kept = (await store.list()).records[0]!;
  assert.equal((await store.read(kept.id)).text.length, 900);
  assert.ok(await store.usage() <= 2500);
  assert.deepEqual(await readdir(store.root), [kept.id]);
  await assert.rejects(store.retain(origin, { text: "x".repeat(5000) }), /storage limit/);
  assert.equal((await store.list()).total, 1);
}));

test("imports verify hashes and preserve reported origin separately from the actual sending peer", async () => isolated(async () => {
  const source = new EvidenceStore("producer");
  const target = new EvidenceStore("receiver");
  const record = await source.retain(origin, { text: "failure\ndetail" });
  const received = await target.import(source.directory(record.id), record.id, "relay-peer", "Possible cancellation issue");
  assert.notEqual(received.id, record.id);
  assert.deepEqual(received.origin, record.origin);
  assert.equal(received.received?.from, "relay-peer");
  assert.equal((await target.list("cancellation")).total, 1);
  await writeFile(join(source.directory(record.id), "output.txt"), "tampered");
  await assert.rejects(target.import(source.directory(record.id), record.id, "peer", "finding"), /integrity/);
  assert.equal((await target.list()).total, 1);
  assert.equal((await target.read(received.id)).text, "failure\ndetail");
}));

test("selection and imported metadata reject malformed IDs, paths, sizes and coverage", async () => isolated(async () => {
  for (const value of [null, {}, { id: "../escape", offset: 1, limit: 1 }]) assert.throws(() => parseEvidenceSelection(value), /Invalid evidence/);
  const store = new EvidenceStore("producer");
  const record = await store.retain(origin, { text: "output" });
  assert.throws(() => store.directory(".."), /Invalid evidence ID/);
  assert.throws(() => parseEvidenceSelection({ id: record.id, offset: 0, limit: 1 }), /Invalid evidence/);
  assert.throws(() => parseEvidenceSelection({ id: record.id, offset: 1, limit: 101 }), /Invalid evidence/);
  await assert.rejects(store.read(record.id, 0, 2), /Read requires/);
  const path = join(store.directory(record.id), "record.json");
  await writeFile(path, JSON.stringify({ ...record, bytes: -1 }));
  await assert.rejects(store.get(record.id), /Invalid evidence metadata/);
  await writeFile(path, JSON.stringify({ ...record, origin: { ...origin, coverage: "made-up" } }));
  await assert.rejects(store.get(record.id), /Invalid evidence metadata/);
}));

test("tool hooks retain full bash spill files, flag missing spills and preserve tool error status", async () => isolated(async root => {
  const h = harness("producer", root);
  const file = join(root, "full.log");
  await writeFile(file, "start\nexact middle failure\nend");
  const event = { toolName: "bash", toolCallId: "call-full", input: { command: "npm test" }, isError: true,
    content: [{ type: "text", text: "truncated display" }], details: { fullOutputPath: file, truncation: { truncated: true } } };
  const patch = await h.capture(event);
  assert.equal(patch, undefined, "shell retention must not modify visible output or error status");
  const store = new EvidenceStore("producer");
  const record = (await store.list("call-full")).records[0]!;
  assert.equal((await store.read(record.id)).text, await readFile(file, "utf8"));
  assert.equal(record.origin.coverage, "full-output-file");
  assert.equal(record.origin.truncated, false);
  assert.equal(record.origin.isError, true);
  assert.equal(record.origin.branchEntryId, "branch-1");
  const index = (await h.context()).messages.at(-1);
  assert.equal(index.display, false);
  assert.ok(index.content.includes(record.id), "shell evidence remains discoverable by the model");
  await rm(file);
  await h.capture({ ...event, toolCallId: "call-missing" });
  const missing = (await store.list("call-missing")).records[0]!;
  assert.equal(missing.origin.truncated, true);
  assert.equal(missing.origin.coverage, "tool-result");
  assert.match(missing.origin.captureNote!, /unavailable/);
  assert.equal((await store.read(missing.id)).text, "truncated display");
  assert.equal(await h.capture({ ...event, toolName: "intercom_evidence" }), undefined);
  assert.equal(await h.capture({ ...event, toolName: "intercom" }), undefined);
  assert.equal(await h.capture({ ...event, toolName: "read", input: { path: join(store.directory(record.id), "output.txt") } }), undefined);
}));

test("shell notices are hidden without changing non-shell notices or retained output", async () => isolated(async root => {
  const h = harness("producer", root);
  for (const toolName of ["bash", "powershell", "search"]) {
    const event = { toolName, toolCallId: `call-${toolName}`, input: {}, content: [{ type: "text", text: "exact output" }] };
    const patch = await h.capture(event);
    if (toolName === "search") {
      assert.deepEqual(patch.content[0], event.content[0]);
      assert.match(patch.content[1].text, /Retained evidence/);
    } else {
      assert.equal(patch, undefined);
    }
    const store = new EvidenceStore("producer");
    const record = (await store.list(`call-${toolName}`)).records[0]!;
    assert.equal((await store.read(record.id)).text, "exact output");
  }
}));

test("bounded evidence index is reconstructed after repeated compaction-shaped contexts and extension restart", async () => isolated(async root => {
  const store = new EvidenceStore("producer");
  const records = [];
  for (let i = 0; i < 8; i++) records.push(await store.retain({ ...origin, toolCallId: `call-${i}` }, { text: `private output ${i}` }));
  let h = harness("producer", root);
  const original = [{ role: "user", content: "task", timestamp: 1 }];
  const before = await h.context(original);
  assert.equal(original.length, 1, "must not mutate saved history");
  assert.equal(before.messages.length, 2);
  const index = before.messages.at(-1);
  assert.equal(index.content.match(/bytes/g).length, 5);
  assert.ok(!index.content.includes("private output"));
  const repeated = await h.context(before.messages);
  assert.equal(repeated.messages.filter((m: any) => m.customType === "intercom_evidence_index").length, 1);
  for (let i = 0; i < 2; i++) {
    h = harness("producer", root);
    const compacted = await h.context([{ role: "compactionSummary", summary: "Prior context compacted", tokensBefore: 99999, timestamp: 2 }]);
    assert.match(compacted.messages.at(-1).content, /8 results/);
    const lookup = await h.execute({ action: "list", query: "call-0" });
    assert.equal(lookup.details.records[0].id, records[0].id);
    const read = await h.execute({ action: "read", id: records[0].id });
    assert.match(read.content[0].text, /private output 0/);
  }
}));

test("capture failures stay visible and oversized line excerpts stay bounded", async () => isolated(async root => {
  const store = new EvidenceStore("producer");
  const record = await store.retain(origin, { text: "x".repeat(30_000) });
  const excerpt = await store.read(record.id);
  assert.equal(excerpt.text.length, 16_000);
  assert.equal(excerpt.clipped, true);
  assert.ok((await store.card(record.id)).length < 6000);
  process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES = "1";
  const patch = await harness("producer", root).capture({ toolName: "search", toolCallId: "failure", input: {}, content: [{ type: "text", text: "original result" }], isError: false });
  assert.equal(patch.content[0].text, "original result");
  assert.match(patch.content[1].text, /NOT retained.*storage limit/);
  assert.equal((await store.list()).total, 1);
}));
