import test from "node:test";
import assert from "node:assert/strict";
import { projectTodos, replayTodos, validTodos } from "./todo.ts";

test("todo projection excludes private fields, deleted tasks and bounds large lists", () => {
  const details = { tasks: [
    { id: 1, subject: "Build", status: "completed", description: "secret", metadata: { token: "secret" } },
    { id: 2, subject: "Review", status: "in_progress", activeForm: "reviewing" },
    { id: 3, subject: "Gone", status: "deleted" },
  ] };
  const snapshot = projectTodos(details)!;
  assert.deepEqual(snapshot, { tasks: [{ id: 1, subject: "Build", status: "completed" }, { id: 2, subject: "Review", status: "in_progress", activeForm: "reviewing" }], completed: 1, total: 2, omitted: 0 });
  assert.ok(validTodos(snapshot));
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(projectTodos({ tasks: [{ id: 1, subject: "x", status: "broken" }] }), undefined);
  const many = projectTodos({ tasks: Array.from({ length: 150 }, (_, i) => ({ id: i + 1, subject: "x".repeat(500), status: "pending" })) })!;
  assert.equal(many.tasks.length, 80);
  assert.equal(many.omitted, 70);
  assert.ok(validTodos(many));
  assert.equal(validTodos({ ...many, omitted: -1 }), false);
  const lateActive = projectTodos({ tasks: [...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, subject: `Task ${i}`, status: "pending" })), { id: 101, subject: "Now", status: "in_progress" }] })!;
  assert.ok(lateActive.tasks.some(t => t.subject === "Now"), "active task survives overflow");
});

test("todo replay follows branch snapshots and clears after clear", () => {
  const entry = (tasks: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks } } });
  assert.equal(replayTodos([entry([{ id: 1, subject: "Old", status: "pending" }]), entry([])]).total, 0);
  assert.equal(replayTodos([entry([{ id: 1, subject: "Old", status: "pending" }]), entry("invalid")]).total, 1);
});
