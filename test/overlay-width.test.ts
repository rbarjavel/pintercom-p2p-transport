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
  assert.equal(messages[0].response, false);
  assert.equal(messages[1].response, true);
  const reply = sent("reply");
  Object.assign(reply.data.message, { replyTo: "one" });
  assert.equal(readHistory([reply])[0].response, true);
  assert.equal(readHistory([{ type: "custom_message", customType: "intercom_message",
    details: { ...details, message: { ...details.message, replyTo: "one" } } }])[0].response, true);
});

test("history follows arrivals, pauses while selecting, resizes and closes", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => sent(String(i), `message ${i} 中文`));
  const tui = { terminal: { rows: 8 }, requestRender() {} };
  const keys = { matches: (data: string, id: string) => matchesKey(data, id.split(".").at(-1) as any) };
  let closed = false;
  const overlay = new MessageHistoryOverlay(tui as any, theme as any, keys as any, () => entries as any, () => { closed = true; });
  try {
    assert.match(overlay.render(100).join("\n"), /message 9/);
    assert.match(overlay.render(100).join("\n"), /> ▸ MESSAGE/);
    overlay.handleInput("\x1b[A"); // Up selects previous message
    assert.match(overlay.render(100).join("\n"), /> ▸ MESSAGE[^\n]*\n  message 8/);
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

test("Tab expands only the selection and source text stays anchored on resize", async () => {
  const longText = Array.from({ length: 300 }, (_, i) => `token${String(i).padStart(3, "0")}`).join(" ");
  const entries = [sent("first", longText), sent("second", "reply body\nhidden second line")];
  Object.assign(entries[1].data.message, { replyTo: "first" });
  const tui = { terminal: { rows: 8 }, requestRender() {} };
  const keys = { matches: (data: string, id: string) => matchesKey(data, id.split(".").at(-1) as any) };
  const overlay = new MessageHistoryOverlay(tui as any, theme as any, keys as any, () => entries as any, () => {});
  try {
    const collapsed = overlay.render(120).join("\n");
    assert.match(collapsed, /▸ MESSAGE/);
    assert.match(collapsed, /▸ ↳ RESPONSE/);
    assert.doesNotMatch(collapsed, /│ hidden second line/);
    overlay.handleInput("\t");
    assert.match(overlay.render(120).join("\n"), /▾ ↳ RESPONSE[\s\S]*│ hidden second line/);
    overlay.handleInput("\t");
    assert.doesNotMatch(overlay.render(120).join("\n"), /│ hidden second line/);
    overlay.handleInput("\x1b[H");
    overlay.handleInput("\t");
    overlay.render(40);
    overlay.handleInput("\x1b[6~"); // Page down inside expanded first message
    const anchor = overlay.render(40)[1].match(/token\d+/)?.[0];
    assert.ok(anchor, "viewport starts within a wrapped body");
    assert.ok(overlay.render(75)[1].includes(anchor), "widening keeps the original source position visible");
    const newAnchor = overlay.render(75)[1].match(/token\d+/)?.[0];
    assert.ok(newAnchor);
    assert.ok(overlay.render(30)[1].includes(newAnchor), "narrowing keeps the source position visible");
    const beforeArrival = overlay.render(30).slice(1, -1);
    entries.push(sent("third", "fresh message"));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(overlay.render(30).slice(1, -1), beforeArrival);
    overlay.handleInput("\x1b[F");
    assert.match(overlay.render(120).join("\n"), /LIVE[\s\S]*> ▸ MESSAGE[\s\S]*fresh message/);
  } finally {
    overlay.dispose();
  }
});

test("arrow keys read overflowing expanded content before selecting another message", () => {
  const entries = [sent("long", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")), sent("next", "next message")];
  const tui = { terminal: { rows: 8 }, requestRender() {} };
  const keys = { matches: (data: string, id: string) => matchesKey(data, id.split(".").at(-1) as any) };
  const overlay = new MessageHistoryOverlay(tui as any, theme as any, keys as any, () => entries as any, () => {});
  try {
    overlay.render(120);
    overlay.handleInput("\x1b[H");
    overlay.handleInput("\t");
    const top = overlay.render(120).slice(1, -1);
    const seen = new Set<number>();
    for (let i = 0; i < 15; i++) {
      for (const line of overlay.render(120)) {
        const match = line.match(/│ line (\d+)/);
        if (match) seen.add(Number(match[1]));
      }
      overlay.handleInput("\x1b[B");
    }
    const bottom = overlay.render(120).join("\n");
    assert.match(bottom, /│ line 19/);
    assert.doesNotMatch(bottom, /> ▸ MESSAGE/);
    for (const match of bottom.matchAll(/│ line (\d+)/g)) seen.add(Number(match[1]));
    assert.equal(seen.size, 20, "every body line is reachable with Down");
    for (let i = 0; i < 15; i++) {
      overlay.handleInput("\x1b[A");
      overlay.render(120);
    }
    assert.deepEqual(overlay.render(120).slice(1, -1), top, "Up scrolls back to the expanded header");
    for (let i = 0; i < 16; i++) {
      overlay.handleInput("\x1b[B");
      overlay.render(120);
    }
    assert.match(overlay.render(120).join("\n"), /> ▸ MESSAGE[^\n]*\n  next message/);
  } finally {
    overlay.dispose();
  }
});

test("message and response colors persist through selection and expansion", () => {
  const entries = [sent("question", "question body"), sent("reply", "reply body")];
  Object.assign(entries[1].data.message, { replyTo: "question" });
  const colors: Record<string, string> = { accent: "\x1b[36m", success: "\x1b[32m" };
  const coloredTheme = { fg: (color: string, value: string) => `${colors[color] ?? ""}${value}\x1b[0m` };
  const tui = { terminal: { rows: 10 }, requestRender() {} };
  const keys = { matches: (data: string, id: string) => matchesKey(data, id.split(".").at(-1) as any) };
  const overlay = new MessageHistoryOverlay(tui as any, coloredTheme as any, keys as any, () => entries as any, () => {});
  try {
    for (const key of ["", "\t", "\x1b[A", "\t"]) {
      if (key) overlay.handleInput(key);
      const lines = overlay.render(120);
      for (const line of lines.filter(line => /MESSAGE|question body/.test(line))) {
        assert.ok(line.startsWith(colors.accent), "messages use accent even when selected");
      }
      for (const line of lines.filter(line => /RESPONSE|reply body/.test(line))) {
        assert.ok(line.startsWith(colors.success), "responses retain their distinct color");
      }
      assertLineWidths("colored history", lines, 120);
    }
  } finally {
    overlay.dispose();
  }
});
