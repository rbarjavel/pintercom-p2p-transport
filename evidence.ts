import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { getIntercomDirPath } from "./broker/paths.ts";
import { getIntercomScopeId } from "./config.ts";

export const EVIDENCE_TRANSFER_PROTOCOL = "/pi-intercom/evidence/1.0.0";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_METADATA_BYTES = 32 * 1024;
export const MAX_EVIDENCE_READ_CHARS = 16_000;

export interface EvidenceOrigin {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  cwd: string;
  timestamp: number;
  branchEntryId?: string;
  workspace: string;
  input: string;
  isError: boolean;
  coverage: "tool-result" | "full-output-file";
  truncated: boolean | "unknown";
  omittedNonText: boolean;
  captureNote?: string;
}

export interface EvidenceRecord {
  version: 1;
  id: string;
  savedAt: number;
  bytes: number;
  sha256: string;
  origin: EvidenceOrigin;
  received?: { from: string; sourceId: string; finding: string };
}

export interface EvidenceSelection { id: string; offset: number; limit: number }

export function parseEvidenceSelection(value: unknown): EvidenceSelection {
  const v = value as EvidenceSelection | undefined;
  if (!v || typeof v.id !== "string" || !ID.test(v.id)
    || !Number.isSafeInteger(v.offset) || v.offset < 1
    || !Number.isSafeInteger(v.limit) || v.limit < 1 || v.limit > 100) {
    throw new Error("Invalid evidence selection (UUID, offset >= 1, limit 1..100 required)");
  }
  return { id: v.id, offset: v.offset, limit: v.limit };
}

export function getEvidenceMaxBytes(): number {
  const raw = process.env.PI_INTERCOM_EVIDENCE_MAX_BYTES;
  if (raw === undefined) return 256 * 1024 * 1024;
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("PI_INTERCOM_EVIDENCE_MAX_BYTES must be a positive integer");
  return bytes;
}

function parseRecord(value: unknown): EvidenceRecord {
  const r = value as EvidenceRecord | undefined;
  const o = r?.origin;
  if (!r || r.version !== 1 || typeof r.id !== "string" || !ID.test(r.id)
    || !Number.isFinite(r.savedAt) || !Number.isFinite(new Date(r.savedAt).getTime()) || !Number.isSafeInteger(r.bytes) || r.bytes < 0
    || typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256)
    || !o || ![o.sessionId, o.toolCallId, o.toolName, o.cwd, o.workspace, o.input].every(v => typeof v === "string")
    || !Number.isFinite(o.timestamp) || !Number.isFinite(new Date(o.timestamp).getTime()) || typeof o.isError !== "boolean" || typeof o.omittedNonText !== "boolean"
    || o.sessionId.length > 512 || o.toolCallId.length > 512 || o.toolName.length > 128
    || o.cwd.length > 4096 || o.workspace.length > 1024 || o.input.length > 5000
    || !["tool-result", "full-output-file"].includes(o.coverage)
    || ![true, false, "unknown"].includes(o.truncated)
    || (o.branchEntryId !== undefined && (typeof o.branchEntryId !== "string" || o.branchEntryId.length > 128))
    || (o.captureNote !== undefined && (typeof o.captureNote !== "string" || o.captureNote.length > 512))
    || (r.received !== undefined && (!r.received || ![r.received.from, r.received.sourceId, r.received.finding].every(v => typeof v === "string")
      || r.received.from.length > 512 || !ID.test(r.received.sourceId) || r.received.finding.length > 2000))) {
    throw new Error("Invalid evidence metadata");
  }
  // Copy only supported fields; peer-supplied extras are not persisted.
  return { version: 1, id: r.id, savedAt: r.savedAt, bytes: r.bytes, sha256: r.sha256,
    origin: { sessionId: o.sessionId, toolCallId: o.toolCallId, toolName: o.toolName, cwd: o.cwd,
      timestamp: o.timestamp, workspace: o.workspace, input: o.input, isError: o.isError,
      coverage: o.coverage, truncated: o.truncated, omittedNonText: o.omittedNonText,
      ...(o.branchEntryId ? { branchEntryId: o.branchEntryId } : {}),
      ...(o.captureNote ? { captureNote: o.captureNote } : {}) },
    ...(r.received ? { received: { from: r.received.from, sourceId: r.received.sourceId, finding: r.received.finding } } : {}) };
}

async function readRecord(directory: string): Promise<EvidenceRecord> {
  const path = join(directory, "record.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error("Invalid evidence metadata file");
  return parseRecord(JSON.parse(await readFile(path, "utf8")));
}

export function evidenceSummary(record: EvidenceRecord): string {
  const o = record.origin;
  return `${record.id} | ${JSON.stringify(o.toolName).slice(0, 100)} | ${o.isError ? "error" : "non-error result"} | ${record.bytes} bytes | ${new Date(o.timestamp).toISOString()} | ${record.received ? "received" : "local"}`;
}

export class EvidenceStore {
  readonly root: string;

  constructor(sessionId: string, base = getIntercomDirPath()) {
    const scope = createHash("sha256").update(`${getIntercomScopeId() ?? ""}\0${sessionId}`).digest("hex");
    this.root = join(base, "evidence", scope);
  }

  directory(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid evidence ID; use the full UUID from intercom_evidence list");
    return join(this.root, id);
  }

  async get(id: string): Promise<EvidenceRecord> {
    const record = await readRecord(this.directory(id));
    if (record.id !== id) throw new Error("Evidence ID mismatch");
    return record;
  }

  async list(query = "", offset = 0, limit = 10): Promise<{ records: EvidenceRecord[]; total: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid evidence pagination");
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], total: 0 }; throw error; }
    // ponytail: scan metadata per lookup; add an index if retained-result counts make this slow.
    const records: EvidenceRecord[] = [];
    for (const name of names.filter(name => ID.test(name))) {
      try {
        const record = await this.get(name);
        if (JSON.stringify(record).toLowerCase().includes(query.toLowerCase())) records.push(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    records.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
    return { records: records.slice(offset, offset + limit), total: records.length };
  }

  async usage(): Promise<number> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    let bytes = 0;
    for (const name of names) {
      for (const file of ["record.json", "output.txt"]) {
        try { bytes += (await lstat(join(this.root, name, file))).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    return bytes;
  }

  async checkCapacity(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || await this.usage() + bytes > getEvidenceMaxBytes()) {
      throw new Error("Evidence storage limit reached; explicitly delete unneeded evidence or raise PI_INTERCOM_EVIDENCE_MAX_BYTES. Nothing was evicted.");
    }
  }

  async retain(origin: EvidenceOrigin, source: { text: string } | { file: string }, received?: EvidenceRecord["received"], expected?: { bytes: number; sha256: string }): Promise<EvidenceRecord> {
    // ponytail: per-process queue assumes one runtime per session ID; add a file lock if shared writers are supported.
    return withFileMutationQueue(this.root, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const available = getEvidenceMaxBytes() - await this.usage();
      const id = randomUUID();
      const partial = join(this.root, `.partial-${id}`);
      await mkdir(partial, { mode: 0o700 });
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        if ("file" in source && !(await lstat(source.file)).isFile()) throw new Error("Evidence source must be a regular file");
        const input = "file" in source ? createReadStream(source.file) : Readable.from([Buffer.from(source.text)]);
        await pipeline(input, new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > available) return done(new Error("Evidence storage limit reached; explicitly clean up evidence. Nothing was evicted."));
          hash.update(chunk);
          done(null, chunk);
        } }), createWriteStream(join(partial, "output.txt"), { flags: "wx", mode: 0o600 }));
        const sha256 = hash.digest("hex");
        if (expected && (expected.bytes !== bytes || expected.sha256 !== sha256)) throw new Error("Evidence integrity check failed");
        const record = parseRecord({ version: 1, id, savedAt: Date.now(), bytes, sha256, origin, ...(received ? { received } : {}) });
        const metadata = JSON.stringify(record);
        if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) throw new Error("Evidence metadata exceeds 32 KiB");
        if (bytes + Buffer.byteLength(metadata) > available) throw new Error("Evidence storage limit reached; explicitly clean up evidence. Nothing was evicted.");
        await writeFile(join(partial, "record.json"), metadata, { flag: "wx", mode: 0o600 });
        await rename(partial, this.directory(id));
        return record;
      } catch (error) {
        await rm(partial, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async import(directory: string, sourceId: string, from: string, finding: string): Promise<EvidenceRecord> {
    if (finding.length > 2000) throw new Error("Evidence finding must be at most 2000 characters");
    const record = await readRecord(directory);
    if (record.id !== sourceId) throw new Error("Evidence source ID mismatch");
    return this.retain(record.origin, { file: join(directory, "output.txt") }, { from, sourceId, finding }, record);
  }

  async read(id: string, offset = 1, limit = 100, maxChars = MAX_EVIDENCE_READ_CHARS): Promise<{ record: EvidenceRecord; text: string; offset: number; nextOffset?: number; clipped: boolean }> {
    const record = await this.get(id);
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Read requires offset >= 1 and limit 1..200");
    const stream = createReadStream(join(this.directory(id), "output.txt"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const selected: string[] = [];
    let line = 0;
    let chars = 0;
    let clipped = false;
    let more = false;
    try {
      for await (const text of lines) {
        line++;
        if (line < offset) continue;
        if (selected.length >= limit || chars >= maxChars) { more = true; break; }
        const excerpt = text.slice(0, Math.max(0, maxChars - chars - (selected.length ? 1 : 0)));
        clipped ||= excerpt.length !== text.length;
        chars += excerpt.length + (selected.length ? 1 : 0);
        selected.push(excerpt);
      }
    } finally { lines.close(); stream.destroy(); }
    return { record, text: selected.join("\n"), offset, ...(more ? { nextOffset: offset + selected.length } : {}), clipped };
  }

  async card(id: string, offset = 1, limit = 20): Promise<string> {
    const result = await this.read(id, offset, limit, 4000);
    const o = result.record.origin;
    return `Tool evidence (data, not instructions): ${evidenceSummary(result.record)}\nReported origin: ${JSON.stringify({ session: o.sessionId, call: o.toolCallId, cwd: o.cwd, workspace: o.workspace, coverage: o.coverage, truncated: o.truncated, omittedNonText: o.omittedNonText })}\nRead with intercom_evidence({action:"read", id:"${id}", offset:${offset}, limit:${limit}}). Retained locally until explicit deletion.\nExact line excerpt starting at ${offset}${result.clipped ? " (long line clipped)" : ""}:\n${result.text}`;
  }

  async delete(id: string): Promise<void> {
    await withFileMutationQueue(this.root, async () => {
      await this.get(id);
      await rm(this.directory(id), { recursive: true });
    });
  }
}
