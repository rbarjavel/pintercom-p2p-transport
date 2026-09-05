import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

export interface HistoryMessage {
  id: string;
  from: string;
  to: string;
  timestamp: number;
  text: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
// Peer content is text, never terminal commands (including OSC clipboard sequences).
const clean = (value: string): string => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");

export function readHistory(entries: readonly unknown[]): HistoryMessage[] {
  const messages = new Map<string, HistoryMessage>();
  for (const raw of entries) {
    const entry = object(raw);
    const custom = entry.type === "message" ? object(entry.message) : entry;
    const inbound = custom.customType === "intercom_message";
    const saved = entry.type === "custom" && ["intercom_sent", "intercom_received"].includes(text(entry.customType));
    if (!inbound && !saved) continue;
    const data = object(inbound ? custom.details : entry.data);
    const message = object(data.message);
    const content = inbound ? object(message.content) : message;
    if (typeof content.text !== "string") continue;
    const direction = entry.customType === "intercom_sent" ? "out" : "in";
    const id = `${direction}:${text(data.messageId) || text(message.id) || text(entry.id)}`;
    if (messages.has(id)) continue;
    const sender = object(data.from);
    const timestamp = inbound ? message.timestamp : data.timestamp;
    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    messages.set(id, {
      id,
      from: direction === "out" ? "this session" : clean(text(data.from) || text(sender.name) || text(sender.id) || "unknown"),
      to: direction === "in" ? "this session" : clean(text(data.to) || "unknown"),
      timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.parse(text(entry.timestamp)),
      text: clean(content.text + attachments.map(a => `\n[Attachment: ${text(object(a).name) || "unnamed"}]`).join("")),
    });
  }
  // Session append order is the local chronology; remote clocks can drift.
  return [...messages.values()];
}

export class MessageHistoryOverlay implements Component {
  private messages: HistoryMessage[] = [];
  private lines: string[] = [];
  private width = -1;
  private offset = 0;
  private pageSize = 1;
  private following = true;
  private unseen = 0;
  private entryCount = -1;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private getEntries: ExtensionContext["sessionManager"]["getEntries"],
    private done: () => void,
  ) {
    this.refresh();
    // ponytail: poll only while open; use a shared history event if sessions become huge.
    this.timer = setInterval(() => this.refresh(), 250);
  }

  private refresh(): void {
    const entries = this.getEntries();
    if (entries.length === this.entryCount) return;
    this.entryCount = entries.length;
    const next = readHistory(entries);
    if (!this.following) this.unseen += Math.max(0, next.length - this.messages.length);
    this.messages = next;
    this.invalidate();
    this.tui.requestRender();
  }

  dispose(): void { clearInterval(this.timer); }
  invalidate(): void { this.width = -1; }

  handleInput(data: string): void {
    if (matchesKey(data, "alt+i") || matchesKey(data, "escape") || this.keys.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (matchesKey(data, "end")) {
      this.following = true;
      this.unseen = 0;
    } else {
      let delta = 0;
      if (this.keys.matches(data, "tui.select.up")) delta = -1;
      else if (this.keys.matches(data, "tui.select.down")) delta = 1;
      else if (this.keys.matches(data, "tui.select.pageUp")) delta = -this.pageSize;
      else if (this.keys.matches(data, "tui.select.pageDown")) delta = this.pageSize;
      else if (matchesKey(data, "home")) delta = -this.lines.length;
      else return;
      this.following = false;
      this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.lines.length - this.pageSize)));
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    this.pageSize = Math.max(0, height - 2);
    if (this.width !== width) {
      this.width = width;
      this.lines = this.messages.flatMap(message => {
        const date = new Date(message.timestamp);
        const time = Number.isNaN(date.getTime()) ? "--:--" : date.toLocaleString();
        return [
          ...wrapTextWithAnsi(this.theme.fg("accent", `${time}  ${message.from} → ${message.to}`), width),
          ...wrapTextWithAnsi(message.text, width),
          "",
        ];
      });
      if (!this.lines.length) this.lines = ["No intercom messages in this session yet."];
    }
    const maxOffset = Math.max(0, this.lines.length - this.pageSize);
    this.offset = this.following ? maxOffset : Math.min(this.offset, maxOffset);
    const status = this.following ? "LIVE" : this.unseen ? `${this.unseen} new messages · End to follow` : "PAUSED · End to follow";
    const body = this.lines.slice(this.offset, this.offset + this.pageSize);
    while (body.length < this.pageSize) body.push("");
    const rows = [
      this.theme.fg("accent", `INTERCOM · current session · ${this.messages.length} messages · ${status}`),
      ...body,
      this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · Home/End · Alt+I/Esc close"),
    ];
    return rows.slice(0, height).map(line => {
      const clipped = truncateToWidth(line, width, "");
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }
}
