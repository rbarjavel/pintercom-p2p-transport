import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export interface HistoryMessage {
  id: string;
  from: string;
  to: string;
  timestamp: number;
  text: string;
  response: boolean;
  peerId: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
// Peer content is text, never terminal commands (including OSC clipboard sequences).
const clean = (value: string): string => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
const label = (value: string): string => clean(value).replace(/\s+/g, " ");

export function readHistory(entries: readonly unknown[]): HistoryMessage[] {
  const messages = new Map<string, HistoryMessage>();
  const peers = new Map<string, string>();
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
    // intercom_received records are replies consumed by ask waiters, including legacy records without replyTo.
    const response = Boolean(text(message.replyTo)) || entry.customType === "intercom_received";
    const sender = object(data.from);
    if (text(sender.id)) peers.set(text(sender.id), text(sender.name));
    const existing = messages.get(id);
    if (existing) {
      existing.response ||= response;
      continue;
    }
    const timestamp = inbound ? message.timestamp : data.timestamp;
    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    messages.set(id, {
      id,
      from: direction === "out" ? "local" : label(text(data.from) || text(sender.name) || text(sender.id) || "unknown"),
      to: direction === "in" ? "local" : label(text(data.to) || "unknown"),
      timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.parse(text(entry.timestamp)),
      text: clean(content.text + attachments.map(a => `\n[Attachment: ${text(object(a).name) || "unnamed"}]`).join("")),
      response,
      peerId: direction === "out" ? text(data.to) : text(sender.id) || text(data.from),
    });
  }
  // Session append order is the local chronology; remote clocks can drift.
  return [...messages.values()].map(message => {
    // Saved sends may contain a name or short ID; resolve only unambiguous aliases.
    const matches = [...peers].filter(([id, name]) => message.peerId === id || message.peerId === name
      || (message.peerId.length >= 4 && id.startsWith(message.peerId)));
    if (matches.length === 1) message.peerId = matches[0][0];
    return message;
  });
}

interface HistoryRow {
  message: HistoryMessage;
  paragraph: number; // -1 is the message header
  char: number; // Visible non-whitespace text position, independent of wrapping
  text: string;
}

export class MessageHistoryOverlay implements Component {
  private messages: HistoryMessage[] = [];
  private rows: HistoryRow[] = [];
  private expanded = new Set<string>();
  private peerColors = new Map<string, number>();
  private availableColors = [39, 45, 75, 81, 111, 141, 171, 207, 203, 215, 221, 155];
  private selectedId: string | undefined;
  private revealSelection = false;
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
    for (const message of next) {
      const name = message.id.startsWith("out:") ? message.to : message.from;
      let color = this.peerColors.get(message.peerId) ?? this.peerColors.get(name);
      if (color === undefined) {
        // ponytail: twelve distinct colors, reuse once the palette is exhausted.
        if (!this.availableColors.length) this.availableColors = [39, 45, 75, 81, 111, 141, 171, 207, 203, 215, 221, 155];
        color = this.availableColors.splice(Math.floor(Math.random() * this.availableColors.length), 1)[0];
      }
      this.peerColors.set(message.peerId, color);
      this.peerColors.set(name, color);
    }
    this.messages = next;
    if (this.following) this.selectedId = next.at(-1)?.id;
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
    const selected = this.messages.findIndex(message => message.id === this.selectedId);
    if (this.selectedId && this.expanded.has(this.selectedId) && !matchesKey(data, "tab")) {
      const first = this.rows.findIndex(row => row.message.id === this.selectedId);
      const last = this.rows.findLastIndex(row => row.message.id === this.selectedId && row.paragraph !== -2);
      let offset = this.offset;
      if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "k")) offset--;
      else if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "j")) offset++;
      else if (this.keys.matches(data, "tui.select.pageUp")) offset -= this.pageSize;
      else if (this.keys.matches(data, "tui.select.pageDown")) offset += this.pageSize;
      else if (matchesKey(data, "home")) offset = first;
      else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) offset = last;
      else return;
      this.following = false;
      if (first >= 0) this.offset = Math.max(first, Math.min(offset, Math.max(first, last - this.pageSize + 1)));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.following = true;
      this.unseen = 0;
      this.selectedId = this.messages.at(-1)?.id;
    } else if (matchesKey(data, "tab")) {
      if (!this.selectedId) return;
      this.following = false;
      if (!this.expanded.delete(this.selectedId)) this.expanded.add(this.selectedId);
      this.revealSelection = true;
      this.invalidate();
    } else if (this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.select.pageDown")) {
      this.following = false;
      const delta = this.keys.matches(data, "tui.select.pageUp") ? -this.pageSize : this.pageSize;
      this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.rows.length - this.pageSize)));
    } else {
      let index = selected;
      if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "k")) index--;
      else if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "j")) index++;
      else if (matchesKey(data, "home")) index = 0;
      else return;
      this.following = false;
      this.selectedId = this.messages[Math.max(0, Math.min(index, this.messages.length - 1))]?.id;
      this.revealSelection = true;
    }
    this.tui.requestRender();
  }

  private reflow(width: number): void {
    const anchor = this.rows[this.offset];
    this.rows = this.messages.flatMap((message, index) => {
      const date = new Date(message.timestamp);
      const time = Number.isNaN(date.getTime()) ? "--:--" : date.toLocaleString();
      const expanded = this.expanded.has(message.id);
      const kind = message.response ? "↳ RESPONSE" : "MESSAGE";
      const rows: HistoryRow[] = [{ message, paragraph: -1, char: 0,
        text: `${expanded ? "▾" : "▸"} ${kind} · ${time} · ` }];
      if (!expanded) {
        rows.push({ message, paragraph: 0, char: 0, text: `  ${truncateToWidth(message.text.replace(/\s+/g, " "), Math.max(1, width - 2))}` });
      } else {
        const markdown = new Markdown(message.text, 0, 0, getMarkdownTheme(), {
          color: value => this.theme.fg("text", value),
        });
        let cursor = 0;
        for (const line of markdown.render(Math.max(1, width - 2))) {
          rows.push({ message, paragraph: 0, char: cursor, text: `│ ${line}` });
          // Ignore whitespace and layout borders so rewrapping doesn't shift the anchor.
          cursor += stripVTControlCharacters(line).replace(/[\s│─┌┐└┘├┤┬┴┼]/g, "").length;
        }
      }
      if (index < this.messages.length - 1) rows.push({ message, paragraph: -2, char: 0, text: "" });
      return rows;
    });
    // Anchor the source text, not a rendered line number, across reflow and live appends.
    if (anchor && !this.following) {
      const index = this.rows.findLastIndex(row => row.message.id === anchor.message.id
        && row.paragraph === anchor.paragraph && row.char <= anchor.char);
      if (index >= 0) this.offset = index;
    }
    this.width = width;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    this.pageSize = Math.max(0, height - 2);
    if (this.width !== width) this.reflow(width);
    if (this.revealSelection) {
      const index = this.rows.findIndex(row => row.message.id === this.selectedId);
      if (index >= 0 && (index < this.offset || index >= this.offset + this.pageSize)) this.offset = index;
      this.revealSelection = false;
    }
    // While paused, allow blank space below the anchor instead of shifting the content on resize.
    this.offset = this.following ? Math.max(0, this.rows.length - this.pageSize)
      : Math.min(this.offset, Math.max(0, this.rows.length - 1));
    const hint = this.selectedId && this.expanded.has(this.selectedId) ? "Tab to collapse" : "End/G to follow";
    const status = this.following ? "LIVE" : `${this.unseen ? `${this.unseen} new messages` : "PAUSED"} · ${hint}`;
    const body = this.rows.slice(this.offset, this.offset + this.pageSize).map(row => {
      const selected = row.message.id === this.selectedId;
      const content = row.paragraph === -1 ? `${selected ? ">" : " "} ${row.text}` : row.text;
      if (row.paragraph === -1) {
        const color = row.message.response ? "success" : "accent";
        const outgoing = row.message.id.startsWith("out:");
        const name = (value: string, local: boolean) => `\x1b[${local ? "97" : `38;5;${this.peerColors.get(row.message.peerId)}`}m${value}\x1b[39m`;
        return this.theme.fg(color, content) + name(row.message.from, outgoing)
          + this.theme.fg(color, " → ") + name(row.message.to, !outgoing);
      }
      return this.expanded.has(row.message.id) ? content : this.theme.fg("text", content);
    });
    if (!this.rows.length && this.pageSize) body.push("No intercom messages recorded in this session yet.");
    while (body.length < this.pageSize) body.push("");
    const rows = [
      this.theme.fg("accent", `INTERCOM · all branches · ${this.messages.length} recorded messages · ${status}`),
      ...body,
      this.theme.fg("dim", "↑↓/jk select/scroll · Tab unlock/toggle · PgUp/PgDn · End/G bottom/live · Esc close"),
    ];
    return rows.slice(0, height).map(line => {
      const clipped = truncateToWidth(line, width, "");
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }
}
