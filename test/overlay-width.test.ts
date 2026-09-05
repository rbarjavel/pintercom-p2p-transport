import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth, matchesKey } from "@earendil-works/pi-tui";
import { MessageHistoryOverlay, readHistory } from "../ui/message-history.ts";
import { ComposeOverlay } from "../ui/compose.ts";
import { SessionListOverlay } from "../ui/session-list.ts";
import type { SessionInfo } from "../types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

const keybindings = {
  matches(): boolean {
    return false;
  },
  getKeys(id: string): string[] {
    return id.includes("confirm") ? ["enter"] : ["escape", "ctrl+c"];
  },
};

const session: SessionInfo = {
  id: "session-12345678",
  name: "subagent-chat-019ecaf6",
  cwd: "/Users/envvar/.config/ghostty",
  model: "bsy-deepseek-v4-pro",
  hostname: "remote-device",
  os: "Linux arm64",
  sshRemote: "root@device.local",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

function assertLineWidths(label: string, lines: string[], expectedWidth: number): void {
  assert.ok(lines.length > 0, `${label} should render lines`);
  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), expectedWidth, `${label} line ${index} should match overlay width`);
  }
}

test("compose overlay renders lines at the declared overlay width", () => {
  const overlay = new ComposeOverlay(
    { requestRender() {} } as any,
    theme as any,
    keybindings as any,
    session,
    "subagent-chat-019ecaf6",
    { send: async () => ({ delivered: true, id: "message-1" }) } as any,
    () => {},
  );

  for (const width of [1, 2, 20, 40, 72]) {
    assertLineWidths("compose overlay", overlay.render(width), width);
  }
});

test("session list overlay renders lines at the declared overlay width", () => {
  const overlay = new SessionListOverlay(theme as any, keybindings as any, session, [session], () => {});

  for (const width of [1, 2, 20, 50, 88]) {
    assertLineWidths("session list overlay", overlay.render(width), width);
  }
  const sshOverlay = new SessionListOverlay(
    theme as any,
    keybindings as any,
    { ...session, name: "ssh-agent", cwd: "/w", model: "m" },
    [],
    () => {},
  );
  assert.match(sshOverlay.render(88).join("\n"), /SSH root@device\.local.*remote-device.*Linux arm64/);
});

const sent = (id: string, body = id) => ({
  type: "custom", id, customType: "intercom_sent",
  data: { messageId: id, to: "builder", timestamp: 1, message: { text: body } },
});

test("history restores all record formats, deduplicates and sanitizes peer text", () => {
  const details = {
    from: { id: "peer", name: "builder" },
    message: { id: "reply", timestamp: 2, content: { text: "answer", attachments: [{ name: "a.ts", content: "secret" }] } },
  };
  const messages = readHistory([
    null, {}, sent("one", "hello\x1b]52;c;secret\x07\x1b[31m!"), sent("one"),
    { type: "custom_message", customType: "intercom_message", details },
    { type: "message", message: { role: "custom", customType: "intercom_message", details } },
    { type: "custom", customType: "intercom_received", data: { from: "builder", messageId: "reply", message: { text: "answer" } } },
    { type: "custom", customType: "intercom_sent", data: { message: null } },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "hello!");
  assert.equal(messages[1].from, "builder");
  assert.equal(messages[1].text, "answer\n[Attachment: a.ts]");
});

test("history follows arrivals, pauses while reading, resizes and closes", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => sent(String(i), `message ${i} 中文`));
  const tui = { terminal: { rows: 8 }, requestRender() {} };
  const keys = { matches: (data: string, id: string) => matchesKey(data, id.split(".").at(-1) as any) };
  let closed = false;
  const overlay = new MessageHistoryOverlay(tui as any, theme as any, keys as any, () => entries as any, () => { closed = true; });
  try {
    assert.match(overlay.render(100).join("\n"), /message 9/);
    overlay.handleInput("\x1b[H"); // Home
    const body = overlay.render(100).slice(1, -1);
    entries.push(sent("new", "new arrival"));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(overlay.render(100).slice(1, -1), body);
    assert.match(overlay.render(100)[0], /1 new messages/);
    overlay.handleInput("\x1b[F"); // End
    assert.match(overlay.render(100).join("\n"), /LIVE[\s\S]*new arrival/);
    for (const width of [1, 2, 20, 100]) {
      for (const height of [1, 2, 8]) {
        tui.terminal.rows = height;
        const lines = overlay.render(width);
        assert.equal(lines.length, height);
        assertLineWidths("history", lines, width);
      }
    }
    overlay.handleInput("\x1bi");
    assert.equal(closed, true);
  } finally {
    overlay.dispose();
  }
});
