/** Shared telemetry v1 wire contract. No Pi runtime or collector dependencies. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";
import type { TransferManifestEntry } from "./transfer.ts";

export const TELEMETRY_PROTOCOL = "/pi-intercom/telemetry/1.0.0";
export const MAX_FRAME = 64 * 1024;
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024;
const text = new TextEncoder();
const decode = new TextDecoder();
export type TodoTask = { id: number; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
export type TodoSnapshot = { tasks: TodoTask[]; completed: number; total: number; omitted: number };
const MAX_TASKS = 80, MAX_SUBJECT = 80;


export type Endpoint = { id: string; epoch: string; name?: string; hostname?: string };
export type TelemetryPresence = { reporter: Endpoint & { peerId: string }; active: boolean };
export type TelemetryTodo = { reporter: Endpoint & { peerId: string }; snapshot: TodoSnapshot };
export type TelemetryEvent = {
  version: 1; reporter: Endpoint & { peerId: string }; eventId: string; sequence: number;
  messageId: string; from: Endpoint; to: Endpoint;
  action: "send" | "ask" | "reply" | "cancel" | "receipt";
  timestamp: number; status: "attempted" | "socket_delivered" | "failed" | "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";
  replyTo?: string; retryOf?: string; supersedes?: string;
  /** Message text, shared only when the reporting agent explicitly opts in. Never attachment content. */
  body?: string; bodyTruncated?: boolean;
  artifacts?: { attachments: { name: string; type: string }[]; manifest: TransferManifestEntry[]; totalCount: number; totalBytes: number; omitted: number };
};


export function agentServiceTag(key: string, scope?: string): string {
  return `_pi-intercom-${createHash("sha256").update(`${key}\0${scope ?? ""}`).digest("hex").slice(0, 12)}._udp.local`;
}
export function observerServiceTag(key: string, scope?: string): string {
  return `_pi-intercom-view-${createHash("sha256").update(`${key}\0${scope ?? ""}\0observer`).digest("hex").slice(0, 12)}._udp.local`;
}
export function telemetryKey(): string {
  const key = process.env.PI_INTERCOM_P2P_KEY?.trim();
  if (!key || key.length < 16) throw new Error("PI_INTERCOM_P2P_KEY must contain at least 16 characters");
  return key;
}
export function sign(key: string, payload: unknown) {
  return { payload, mac: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") };
}
export function verify(key: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid telemetry envelope");
  const wire = value as { payload?: unknown; mac?: unknown };
  if (typeof wire.mac !== "string" || !/^[a-f0-9]{64}$/.test(wire.mac)) throw new Error("Invalid telemetry signature");
  const expected = createHmac("sha256", key).update(JSON.stringify(wire.payload)).digest();
  if (!timingSafeEqual(expected, Buffer.from(wire.mac, "hex"))) throw new Error("Invalid telemetry signature");
  if (!wire.payload || typeof wire.payload !== "object" || Array.isArray(wire.payload)) throw new Error("Invalid telemetry payload");
  return wire.payload as Record<string, unknown>;
}
export function framed(stream: Stream) { return lpStream(stream, { maxDataLength: MAX_FRAME, maxBufferSize: MAX_FRAME * 2 }); }
export async function writeFrame(frame: ReturnType<typeof framed>, value: unknown): Promise<void> {
  const bytes = text.encode(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) throw new Error("Telemetry frame too large");
  await frame.write(bytes);
}
export async function readFrame(frame: ReturnType<typeof framed>, signal?: AbortSignal): Promise<unknown> {
  try { return JSON.parse(decode.decode((await frame.read({ signal })).subarray())); }
  catch { throw new Error("Invalid telemetry JSON frame"); }
}
export const bounded = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export const onlyKeys = (value: unknown, keys: string[]) => value !== null && typeof value === "object" && Object.keys(value).every((key) => keys.includes(key));
export function validEndpoint(value: unknown): value is Endpoint {
  if (!value || typeof value !== "object") return false;
  const e = value as Endpoint;
  return onlyKeys(e, ["id", "epoch", "name", "hostname", "peerId"]) && bounded(e.id) && bounded(e.epoch) && (e.name === undefined || (typeof e.name === "string" && e.name.length <= 128)) && (e.hostname === undefined || bounded(e.hostname));
}
export function validTelemetryEvent(value: unknown, reporter: Endpoint & { peerId: string }): value is TelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as TelemetryEvent;
  const statuses = ["attempted", "socket_delivered", "failed", "receiver_received", "queued", "injected", "acknowledged", "expired", "cancelled", "superseded", "cancellation_requested"];
  const actions = ["send", "ask", "reply", "cancel", "receipt"];
  if (!onlyKeys(e, ["version", "reporter", "eventId", "sequence", "messageId", "from", "to", "action", "timestamp", "status", "replyTo", "retryOf", "supersedes", "body", "bodyTruncated", "artifacts"]) || e.version !== 1 || !validEndpoint(e.reporter) || e.reporter.peerId !== reporter.peerId || e.reporter.id !== reporter.id || e.reporter.epoch !== reporter.epoch || !bounded(e.eventId) || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || !bounded(e.messageId) || !validEndpoint(e.from) || !validEndpoint(e.to) || !actions.includes(e.action) || !statuses.includes(e.status) || !Number.isFinite(e.timestamp)) return false;
  if (!onlyKeys(e.from, ["id", "epoch", "name", "hostname"]) || !onlyKeys(e.to, ["id", "epoch", "name", "hostname"]) || ![e.from, e.to].some((p) => p.id === reporter.id && p.epoch === reporter.epoch)) return false;
  if ([e.replyTo, e.retryOf, e.supersedes].some((s) => s !== undefined && !bounded(s))) return false;
  if (e.body !== undefined && (typeof e.body !== "string" || text.encode(e.body).length > MAX_TELEMETRY_BODY_BYTES || e.action === "cancel" || e.action === "receipt")) return false;
  if (e.bodyTruncated !== undefined && (typeof e.bodyTruncated !== "boolean" || e.body === undefined)) return false;
  if (e.artifacts !== undefined) {
    const a = e.artifacts;
    if (!a || !onlyKeys(a, ["attachments", "manifest", "totalCount", "totalBytes", "omitted"]) || !Array.isArray(a.attachments) || !Array.isArray(a.manifest) || a.attachments.length + a.manifest.length > 100 || !Number.isSafeInteger(a.totalCount) || a.totalCount < 0 || !Number.isSafeInteger(a.totalBytes) || a.totalBytes < 0 || !Number.isSafeInteger(a.omitted) || a.omitted < 0) return false;
    if (a.attachments.some((x) => !x || !onlyKeys(x, ["name", "type"]) || !bounded(x.name, 256) || !["file", "snippet", "context"].includes(x.type))) return false;
    if (a.manifest.some((x) => !x || !onlyKeys(x, ["path", "type", "size"]) || !bounded(x.path, 512) || (isAbsolute(x.path) || /^[a-z]:/i.test(x.path)) || x.path.includes("\\") || x.path.split("/").some((s) => !s || s === "." || s === "..") || !["file", "directory"].includes(x.type) || (x.size !== undefined && (!Number.isSafeInteger(x.size) || x.size < 0)))) return false;
  }
  return true;
}

export function validTodos(value: unknown): value is TodoSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as TodoSnapshot;
  return Object.keys(s).every(k => ["tasks", "completed", "total", "omitted"].includes(k)) && Array.isArray(s.tasks) && s.tasks.length <= MAX_TASKS &&
    [s.completed, s.total, s.omitted].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10_000) && s.completed <= s.total && s.omitted === s.total - s.tasks.length &&
    s.tasks.every(t => t && Object.keys(t).every(k => ["id", "subject", "status", "activeForm"].includes(k)) && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.subject === "string" && t.subject.length > 0 && t.subject.length <= MAX_SUBJECT && ["pending", "in_progress", "completed"].includes(t.status) && (t.activeForm === undefined || t.status === "in_progress" && typeof t.activeForm === "string" && t.activeForm.length <= MAX_SUBJECT)) &&
    s.tasks.filter(t => t.status === "completed").length <= s.completed;
}

