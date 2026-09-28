import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { Script } from "node:vm";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
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
    assert.match(html, /--bg: #000000; --panel: #0a0a0a/);
    assert.match(html, /--border-focus: #38bdf8/);
    assert.match(html, /\.edge path\.visible \{ stroke:var\(--text-muted\)/);
    assert.match(html, /\.agent\.working \{ border-color:var\(--green\)/);
    assert.match(html, /\.edge\.sending path\.visible \{ stroke:var\(--orange\)/);
    assert.match(html, /prefers-reduced-motion:reduce/);
    assert.match(html, /stream\.addEventListener\('presence'/);
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
    const keys = new Script(`${pairFns}\n({ laneKey, pairKey, pairMembers, machineKey })`).runInNewContext({ JSON, Array });
    const a = keys.laneKey({ id: "agent", epoch: "one" });
    const restarted = keys.laneKey({ id: "agent", epoch: "two" });
    const b = keys.laneKey({ id: "other", epoch: "one" });
    assert.notEqual(a, restarted);
    assert.equal(keys.pairKey(a, b), keys.pairKey(b, a));
    assert.equal(keys.pairMembers("broken").length, 0);
    assert.equal(keys.pairMembers(keys.pairKey(a, a)).length, 2);
    assert.equal(keys.machineKey({ id: "agent", epoch: "one", hostname: "Host-A" }), keys.machineKey({ id: "agent", epoch: "one", hostname: "host-a" }));
    assert.notEqual(keys.machineKey({ id: "agent", epoch: "one" }), keys.machineKey({ id: "other", epoch: "one" }));
    const selection = browserScript.slice(browserScript.indexOf("  const peers=new Map(),pairs=new Map();"), browserScript.indexOf("  for (const key of positions.keys())"));
    const visible = new Script(`${pairFns}\n${selection}\n({ peers: [...peers.keys()], pairs: [...pairs.keys()] })`).runInNewContext({
      items: new Map([["message", { from: { id: "agent", epoch: "one", hostname: "host-a" }, to: { id: "other", epoch: "one" } }]]),
      presence: new Map([[a, { peer: { id: "agent", epoch: "one" } }]]),
    });
    assert.deepEqual(Array.from(visible.peers), [a]);
    assert.equal(visible.pairs.length, 0);
    const layoutFns = browserScript.slice(browserScript.indexOf("function acceptPosition("), browserScript.indexOf("async function publishGroup("));
    const testPositions = new Map([[a, [0, 0]], [b, [490, 0]], [restarted, [0, 120]]]);
    const versions = new Map<string, number>();
    const layout = new Script(`${layoutFns}\n({ moveGroup, acceptPosition })`).runInNewContext({
      positions: testPositions, layoutVersions: versions, machineOf: new Map([[a, "host-a"], [b, "host-b"], [restarted, "host-a"]]), moving: null, paint: () => {},
    });
    layout.moveGroup("host-a", 25, -10);
    assert.deepEqual(Array.from(testPositions.values(), p => Array.from(p)), [[25, -10], [490, 0], [25, 110]]);
    layout.acceptPosition(a, [100, 100], 5);
    layout.acceptPosition(a, [0, 0], 4);
    assert.deepEqual(Array.from(testPositions.get(a)!), [100, 100]);
    const animationFn = browserScript.slice(browserScript.indexOf("function animateConnection("), browserScript.indexOf("function reconcile("));
    const classes = new Set<string>();
    const edge = { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) }, getBoundingClientRect: () => ({}) };
    let endPulse = () => {};
    const animate = new Script(`${pairFns}\n${animationFn}\nanimateConnection`).runInNewContext({
      lines: new Map([[keys.pairKey(a, b), edge]]), clearTimeout: () => {},
      setTimeout: (callback: () => void, duration: number) => { assert.equal(duration, 1800); endPulse = callback; return 1; },
    }) as (item: { action: string; from: { id: string; epoch: string }; to: { id: string; epoch: string } }) => void;
    const from = { id: "agent", epoch: "one" }, to = { id: "other", epoch: "one" };
    animate({ action: "receipt", from, to });
    assert.equal(classes.has("sending"), false);
    animate({ action: "send", from, to });
    assert.equal(classes.has("sending"), true);
    endPulse();
    assert.equal(classes.has("sending"), false);
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
      assert.equal((await nextFrame()).type, "layout");
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
  assert.equal(observer.listenerCount("presence"), 0);
  assert.equal(observer.listenerCount("status"), 0);
});

test("viewer accepts LAN IP requests while rejecting host spoofing and cross-origin reads", async () => {
  const observer = new EventEmitter();
  const server = createViewerServer(observer);
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const withHost = (host: string) => new Promise<number>((resolve, reject) => {
    request(root, { headers: { Host: host } }, reply => { reply.resume(); resolve(reply.statusCode!); }).on("error", reject).end();
  });
  try {
    assert.equal((await fetch(root)).status, 200);
    assert.equal(await withHost(`example.test:${address.port}`), 403);
    const ip = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (ip) {
      assert.equal((await fetch(`http://${ip}:${address.port}/`)).status, 200);
      assert.equal(await withHost(`${ip}:${address.port}`), 403);
      assert.equal((await fetch(`http://${ip}:${address.port}/events`, { headers: { Origin: "http://evil.example" } })).status, 403);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("agent positions are shared across viewers and validated before broadcast", async () => {
  const observer = new EventEmitter();
  const server = createViewerServer(observer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  const updates = { method: "POST", headers: { "Content-Type": "application/json" } };
  const key = JSON.stringify(["sender", "epoch"]);
  function readFrames(response: Response) {
    const reader = response.body!.getReader();
    let buffer = "";
    return async () => {
      while (!buffer.includes("\n\n")) { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += new TextDecoder().decode(chunk.value); }
      const end = buffer.indexOf("\n\n"), frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return { type: frame.match(/^event: (.*)$/m)?.[1], data: JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null") };
    };
  }
  try {
    observer.emit("event", { ...event("shared"), from: { id: "sender", epoch: "epoch", hostname: "Host-A" }, to: { id: "receiver", epoch: "epoch", hostname: "Host-B" } });
    observer.emit("event", { ...event("team"), from: { id: "sender", epoch: "epoch", hostname: "Host-A" }, to: { id: "teammate", epoch: "epoch", hostname: "host-a" } });
    const first = readFrames(await fetch(`${root}/events`, { signal: controller.signal }));
    const second = readFrames(await fetch(`${root}/events`, { signal: controller.signal }));
    assert.deepEqual((await first()).data.layout, [[key, [0, 0]], [JSON.stringify(["receiver", "epoch"]), [490, 0]], [JSON.stringify(["teammate", "epoch"]), [0, 120]]]);
    assert.equal((await second()).data.layout[0][0], key);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: "not json" })).status, 400);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: "x".repeat(1025) })).status, 413);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: JSON.stringify({ key: "missing", x: 1, y: 2 }) })).status, 400);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: JSON.stringify({ key, x: 1e9, y: 2 }) })).status, 400);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: JSON.stringify({ key, x: null, y: 2 }) })).status, 400);
    assert.equal((await fetch(`${root}/layout`, { method: "POST", body: JSON.stringify({ key, x: 1, y: 2 }) })).status, 415);
    assert.equal((await fetch(`${root}/layout`, { ...updates, headers: { ...updates.headers, Origin: "http://evil.example" }, body: JSON.stringify({ key, x: 1, y: 2 }) })).status, 403);
    assert.equal((await fetch(`${root}/layout`, { ...updates, body: JSON.stringify({ key, x: 99, y: -42 }) })).status, 204);
    const singleUpdate = await first();
    assert.equal(singleUpdate.type, "layout");
    assert.deepEqual(singleUpdate.data.position, [99, -42]);
    assert.equal(singleUpdate.data.key, key);
    assert.deepEqual(await second(), singleUpdate);
    const reconnect = readFrames(await fetch(`${root}/events`, { signal: controller.signal }));
    assert.deepEqual((await reconnect()).data.layout[0], [key, [99, -42]]);
    assert.equal((await fetch(`${root}/layout/group`, { ...updates, body: JSON.stringify({ machine: "other", dx: 50, dy: 20 }) })).status, 400);
    assert.equal((await fetch(`${root}/layout/group`, { ...updates, body: JSON.stringify({ machine: "host-a", dx: 1e9, dy: 0 }) })).status, 400);
    const groupMove = await fetch(`${root}/layout/group`, { ...updates, body: JSON.stringify({ machine: "host-a", dx: 50, dy: 20 }) });
    assert.equal(groupMove.status, 200);
    const moved = [[key, [149, -22]], [JSON.stringify(["teammate", "epoch"]), [50, 140]]];
    const groupUpdate = await groupMove.json();
    assert.deepEqual(groupUpdate.moved, moved);
    assert.ok(groupUpdate.revision > singleUpdate.data.revision);
    assert.deepEqual(await first(), { type: "layout", data: groupUpdate });
    assert.deepEqual(await second(), { type: "layout", data: groupUpdate });
    assert.equal((await fetch(`${root}/layout/reset`, { method: "POST" })).status, 204);
    assert.deepEqual((await first()).data.positions, [[key, [0, 0]], [JSON.stringify(["receiver", "epoch"]), [490, 0]], [JSON.stringify(["teammate", "epoch"]), [0, 120]]]);
    assert.deepEqual((await second()).data.positions[0], [key, [0, 0]]);
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("viewer snapshots current agent activity and clears disconnected reporters", async () => {
  const observer = new EventEmitter();
  const server = createViewerServer(observer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const reporter = { id: "remote", epoch: "new", name: "Remote", peerId: "remote-peer" };
  try {
    observer.emit("status", { connected: true, reporter });
    observer.emit("presence", { reporter, active: true });
    const response = await fetch(`http://127.0.0.1:${address.port}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += new TextDecoder().decode(chunk.value);
    }
    const snapshot = JSON.parse(buffer.match(/^data: (.*)$/m)?.[1] ?? "null");
    assert.deepEqual(snapshot.presence, [{ peer: { id: "remote", epoch: "new", name: "Remote" }, active: true }]);
    observer.emit("status", { connected: false, peerId: "remote-peer" });
    let next = buffer.slice(buffer.indexOf("\n\n") + 2);
    while (!next.includes("\n\n")) { const chunk = await reader.read(); assert.equal(chunk.done, false); next += new TextDecoder().decode(chunk.value); }
    assert.match(next, /^event: presence/m);
    assert.match(next, /"connected":false/);
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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
