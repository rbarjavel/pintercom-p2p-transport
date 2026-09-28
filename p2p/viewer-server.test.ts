import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { Script } from "node:vm";
import { request } from "node:http";
import { createViewerServer, type ViewerEvent } from "./viewer-server.ts";

function event(messageId: string, status = "attempted"): ViewerEvent {
  return {
    version: 1, reporter: { id: "sender", epoch: "epoch", peerId: "peer" },
    eventId: `${messageId}-${status}`, sequence: 1, messageId,
    from: { id: "sender", epoch: "epoch", name: "Sender" },
    to: { id: "receiver", epoch: "epoch", name: "Receiver" },
    action: "send", timestamp: Date.now(), status,
  };
}

test("viewer serves local HTML, bounded snapshot and live interaction updates", async () => {
  const observer = new EventEmitter();
  const server = createViewerServer(observer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(root);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /P2P agent board/);
    assert.match(html, /overflow-wrap:anywhere/);
    assert.match(html, /id="window-layer"/);
    assert.match(html, /id="zoom-in"/);
    assert.match(html, /resize:both/);
    const browserScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    assert.doesNotThrow(() => new Script(browserScript));
    const markdownFns = browserScript.slice(browserScript.indexOf("function renderInline("), browserScript.indexOf("function matches("));
    const node = (localName: string) => ({ localName, children: [] as unknown[], append(...children: unknown[]) { this.children.push(...children); }, set textContent(value: string) { this.children = [{ text: value }]; } });
    const document = { createElement: node, createTextNode: (text: string) => ({ text }) };
    const renderMarkdown = new Script(`${markdownFns}\nrenderMarkdown`).runInNewContext({ document, URL }) as (source: string, parent: ReturnType<typeof node>) => void;
    const rendered = node("div");
    renderMarkdown("# Heading\n\n**Bold** <script>alert(1)</script>\n\n```\n<img src=x onerror=alert(1)>\n```", rendered);
    assert.deepEqual(rendered.children.map((child) => (child as { localName: string }).localName), ["h1", "p", "pre"]);
    assert.doesNotMatch(JSON.stringify(rendered), /"localName":"(script|img)"/);
    const pairFns = browserScript.slice(browserScript.indexOf("const laneKey ="), browserScript.indexOf("const label ="));
    const keys = new Script(`${pairFns}\n({ laneKey, pairKey, pairMembers })`).runInNewContext({ JSON, Array });
    const a = keys.laneKey({ id: "agent", epoch: "one" });
    const restarted = keys.laneKey({ id: "agent", epoch: "two" });
    const b = keys.laneKey({ id: "other", epoch: "one" });
    assert.notEqual(a, restarted);
    assert.equal(keys.pairKey(a, b), keys.pairKey(b, a));
    assert.equal(keys.pairMembers("broken").length, 0);
    assert.equal(keys.pairMembers(keys.pairKey(a, a)).length, 2);
    const zoomFns = browserScript.slice(browserScript.indexOf("function setZoom("), browserScript.indexOf("function fit("));
    const zoomState = new Script(`let x=60,y=60,zoom=1; const board={clientWidth:800,clientHeight:600}; function camera() {} ${zoomFns} setZoom(2,300,250); ({x,y,zoom})`).runInNewContext({ Math });
    assert.deepEqual([zoomState.x, zoomState.y, zoomState.zoom], [-180,-130,2]);
    assert.equal((await fetch(`${root}/missing`)).status, 404);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      request(root, { headers: { Host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode!); }).on("error", reject).end();
    });
    assert.equal(invalidHost, 403);
    assert.equal((await fetch(root, { headers: { Origin: "http://evil.example" } })).status, 403);
    assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /unsafe-inline/);

    for (let i = 0; i < 1_001; i++) observer.emit("event", event(`message-${i}`));
    const controller = new AbortController();
    const response = await fetch(`${root}/events`, { signal: controller.signal });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function nextFrame() {
      while (!buffer.includes("\n\n")) {
        const result = await reader.read();
        assert.equal(result.done, false);
        buffer += decoder.decode(result.value, { stream: true });
      }
      const boundary = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      return { type: frame.match(/^event: (.*)$/m)?.[1], data: JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null") };
    }
    try {
      const snapshot = await nextFrame();
      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.data.interactions.length, 1_000);
      assert.equal(snapshot.data.truncated, true);
      assert.equal(snapshot.data.connectedReporters, 0);
      assert.equal(snapshot.data.interactions[0].messageId, "message-1");
      observer.emit("event", { ...event("message-1000", "receiver_received"), body: "# Shared **Markdown**\n<script>not executable</script>" });
      const update = await nextFrame();
      assert.equal(update.type, "interaction");
      assert.equal(update.data.interaction.updates.length, 2);
      assert.equal(update.data.interaction.updates[1].status, "receiver_received");
      assert.equal(update.data.interaction.body, "# Shared **Markdown**\n<script>not executable</script>");
      observer.emit("event", { ...event("message-1000", "failed"), timestamp: 1 });
      const late = await nextFrame();
      assert.equal(late.data.interaction.status, "receiver_received", "late failures cannot downgrade a receiver receipt");
      assert.equal(late.data.interaction.body, update.data.interaction.body, "status updates cannot erase shared text");
      assert.equal(late.data.interaction.updates.at(-1).status, "failed", "observations retain collector arrival order");
      observer.emit("event", event("message-1000", "receiver_received"));
      const cancel = { ...event("message-1000", "cancellation_requested"), action: "cancel", eventId: "cancel-1" };
      observer.emit("event", cancel);
      const cancellation = await nextFrame();
      assert.equal(cancellation.data.interaction.linkedTo, update.data.interaction.id);
      assert.equal(cancellation.data.interaction.action, "cancel");
      observer.emit("event", event("message-1001"));
      const insertion = await nextFrame();
      assert.equal(insertion.data.evicted, snapshot.data.interactions[1].id);
      observer.emit("event", { ...event("message-1001"), eventId: "restart", from: { id: "sender", epoch: "new-epoch", name: "Sender" } });
      const restarted = await nextFrame();
      assert.notEqual(restarted.data.interaction.id, insertion.data.interaction.id, "restarted endpoints remain distinct despite duplicate names and IDs");
      observer.emit("status", { connected: true, reporter: { peerId: "remote-peer" } });
      assert.equal((await nextFrame()).data.connectedReporters, 1);
      observer.emit("status", { partial: true, dropped: 2 });
      assert.deepEqual(await nextFrame(), { type: "status", data: { partial: true, dropped: 2, connectedReporters: 1, truncated: true } });
      observer.emit("status", { connected: false, peerId: "remote-peer" });
      assert.equal((await nextFrame()).data.connectedReporters, 0);
    } finally { controller.abort(); }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(observer.listenerCount("event"), 0);
  assert.equal(observer.listenerCount("status"), 0);
});

test("large shared-text histories yield bounded reconnect snapshots", async () => {
  const observer = new EventEmitter();
  const server = createViewerServer(observer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  try {
    for (let i = 0; i < 1_000; i++) observer.emit("event", { ...event(`body-${i}`), body: "x".repeat(16_384) });
    const response = await fetch(`http://127.0.0.1:${address.port}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let frame = "";
    while (!frame.includes("\n\n")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      frame += new TextDecoder().decode(result.value);
    }
    const snapshot = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null");
    assert.equal(snapshot.interactions.length, 1_000);
    assert.equal(snapshot.interactions[0].body.length, 512);
    assert.equal(snapshot.interactions[0].bodyTruncated, true);
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
