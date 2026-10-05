import type { TodoTask, TodoSnapshot } from "./telemetry-contract.ts";
export { validTodos } from "./telemetry-contract.ts";
export type { TodoTask, TodoSnapshot } from "./telemetry-contract.ts";
const MAX_TASKS = 80, MAX_SUBJECT = 80;

/** Copy only display-safe todo fields from rpiv-todo's persisted tool-result details. */
export function projectTodos(details: unknown): TodoSnapshot | undefined {
  if (!details || typeof details !== "object" || !Array.isArray((details as { tasks?: unknown }).tasks)) return;
  const input = (details as { tasks: unknown[] }).tasks;
  if (input.length > 10_000) return;
  const tasks: TodoTask[] = [];
  let completed = 0, total = 0;
  let active: TodoTask | undefined;
  for (const item of input) {
    if (!item || typeof item !== "object") return;
    const t = item as Record<string, unknown>;
    if (!Number.isSafeInteger(t.id) || (t.id as number) < 1 || typeof t.subject !== "string" || !t.subject.trim() || !["pending", "in_progress", "completed", "deleted"].includes(t.status as string) || (t.activeForm !== undefined && typeof t.activeForm !== "string")) return;
    if (t.status === "deleted") continue;
    total++;
    if (t.status === "completed") completed++;
    const task: TodoTask = { id: t.id as number, subject: t.subject.slice(0, MAX_SUBJECT), status: t.status as TodoTask["status"], ...(t.status === "in_progress" && t.activeForm ? { activeForm: t.activeForm.slice(0, MAX_SUBJECT) } : {}) };
    if (task.status === "in_progress") active = task;
    if (tasks.length < MAX_TASKS) tasks.push(task);
  }
  if (active && !tasks.some(t => t.id === active.id)) tasks[MAX_TASKS - 1] = active;
  return { tasks, completed, total, omitted: total - tasks.length };
}

export function replayTodos(entries: Iterable<unknown>): TodoSnapshot {
  let snapshot: TodoSnapshot = { tasks: [], completed: 0, total: 0, omitted: 0 };
  for (const entry of entries) {
    const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
    if (e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") snapshot = projectTodos(e.message.details) ?? snapshot;
  }
  return snapshot;
}
