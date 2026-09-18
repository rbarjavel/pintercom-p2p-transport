import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { IntercomWebServer, type WebServerSessionProvider } from "../web/server.ts";
import type { SessionInfo } from "../types.ts";

class MockProvider extends EventEmitter implements WebServerSessionProvider {
  public sessions: SessionInfo[] = [];

  listSessions(): Promise<SessionInfo[]> {
    return Promise.resolve(this.sessions);
  }
}

test("IntercomWebServer starts, serves endpoints, and stops cleanly", async () => {
  const provider = new MockProvider();
  provider.sessions = [
    {
      id: "test-session-1",
      name: "AlphaAgent",
      cwd: "/Users/remy/Project/demo",
      model: "gemini-3.7-flash",
      hostname: "MacBook-Pro",
      os: "darwin",
      pid: 12345,
      startedAt: Date.now() - 60000,
      lastActivity: Date.now() - 5000,
      status: "thinking",
      contextPct: 42,
      contextTokens: 42000,
      contextWindow: 100000,
    },
  ];

  // Port 0 picks an available random port
  const server = new IntercomWebServer({
    provider,
    port: 0,
    host: "127.0.0.1",
  });

  try {
    const info = await server.start();
    assert.ok(server.isRunning());
    assert.ok(info.port > 0);

    const base = `http://127.0.0.1:${info.port}`;

    // 1. Test HTML Dashboard
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes("Intercom Monitor"));
    assert.ok(htmlText.includes("/api/events"));

    // 2. Test /ping
    const pingRes = await fetch(`${base}/ping`);
    assert.equal(pingRes.status, 200);
    const pingJson = await pingRes.json();
    assert.equal(pingJson.ok, true);

    // 3. Test /manifest.json
    const manifestRes = await fetch(`${base}/manifest.json`);
    assert.equal(manifestRes.status, 200);
    const manifestJson = await manifestRes.json();
    assert.equal(manifestJson.name, "Pi Intercom Monitor");

    // 4. Test /api/sessions
    const sessionsRes = await fetch(`${base}/api/sessions`);
    assert.equal(sessionsRes.status, 200);
    const sessionsJson = await sessionsRes.json();
    assert.equal(Array.isArray(sessionsJson), true);
    assert.equal(sessionsJson.length, 1);
    assert.equal(sessionsJson[0].name, "AlphaAgent");
    assert.equal(sessionsJson[0].status, "thinking");
  } finally {
    // 5. Test stop always runs cleanly
    await server.stop();
    assert.equal(server.isRunning(), false);
  }
});
