---
name: pi-intercom
description: |
  Streamline session-to-session coordination with pi-intercom. Send messages,
  delegate tasks, and coordinate work across multiple pi sessions on the same
  machine. Also use when asked "Tell me what <agent> is doing", "What is he
  working on?", "What problem did <agent> encounter?", or to get another agent's
  context without interacting with it. Use watch for these read-only requests;
  use messaging for planner-worker coordination and collaborative workflows.
---

# Pi Intercom Skill

Use this skill when you need to coordinate work across multiple pi sessions
using the same broker or authenticated P2P LAN transport. Pi-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

When you are supervising `pi-subagents`, delegated child agents can escalate to
you via `contact_supervisor` if `pi-subagents` supplied child bridge metadata.
This skill covers how to handle those orchestrator-side escalations.

## When to Use

- **Silent context gathering**: "Tell me what worker is doing", "What is he working on?", "What problems did reviewer encounter?" — inspect recorded history with `watch`, without messaging or waking the agent
- **Workflow context**: Before continuing work, making a decision, or handing off a task, read another agent's recorded findings and failures without asking it for a status report
- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)
- **Cross-codebase peer messages**: Message an explicit live peer in another project, or open a visible Herdr project pane when a long-lived conversation is needed

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/name planner    # Terminal 1
/name worker     # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (blocks until answer):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns the planner's reply as the result
```

**Worker reports completion**:
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?"
})
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" })
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "planner", message: "Use exponential backoff starting at 100ms." })
```

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom({ action: "send", to: w, message: task })
);
```

### Pattern 5: Send Inline Attachments

Share small code snippets or context:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

When both sessions use the P2P transport, stream actual files or folders with the instruction message by passing paths relative to the sending session cwd:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Review this patch and run its checks.",
  paths: ["./patch.diff", "./fixtures"]
})
```

The receiver gets the protected inbox path after the transfer is complete. Symlinks and special files are rejected; `paths` is not supported by the broker transport.

### Pattern 6: Cross-Codebase Peer Messages

Use `to` alone to message any explicit live peer on the machine, even when it is
in another codebase. Use `cwd` alone when there should be exactly one live peer
in that repo. Use `to` plus `cwd` when the directory is a safety guard.

```typescript
intercom({
  action: "ask",
  cwd: "/path/to/other-repo",
  to: "workbench-agent",
  message: "Which module owns workbench source slices?"
})
```

Only open a Herdr project pane when you need a durable visible peer session in
that repo. For bounded work, prefer `pi-subagents` with an explicit `cwd`; the
child can use `contact_supervisor` for owner decisions and regular `intercom`
for explicit peer coordination.

```typescript
intercom({
  action: "send",
  cwd: "/path/to/other-repo",
  openProjectPaneIfMissing: true,
  message: "Let's discuss the workbench API ergonomics in this repo."
})
```

If a live session already exists in that `cwd`, intercom reuses it. If multiple
sessions are active there, pass `to` to select one by name or session ID.

### Pattern 7: Handle Subagent Escalations (Orchestrator Side)

When `pi-subagents` spawns a delegated child and supplies child bridge metadata,
that child can reach you through `contact_supervisor`. You receive a formatted
message that includes run metadata:

```
**From subagent-worker-78f659a3-1**

Subagent needs a supervisor decision.
Run: 78f659a3
Agent: worker
Child index: 0

Which API should I use?
```

**Reply using `reply`:**

```typescript
// The reply hint in the incoming message will show the exact call:
intercom({ action: "reply", message: "Use the stable v2 API." })
```

This works because `reply` resolves the correct sender and message ID automatically.

**Three types of escalations to expect:**

| Type | What it means | How to respond |
|------|---------------|----------------|
| `need_decision` | Subagent is blocked and waiting for your answer. Uses the shared ask timeout: 1 hour by default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`. | Reply promptly with a clear decision. If you need more context, ask follow-up questions via `reply`. |
| `interview_request` | Subagent needs multiple structured answers in one blocking exchange. Uses the shared ask timeout: 1 hour by default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`. | Reply with plain JSON or a fenced `json` block using the provided `{ "responses": [...] }` shape. |
| `progress_update` | Subagent is sharing meaningful progress or a plan-changing discovery. Not blocking. | Read and acknowledge. No reply required unless you want to redirect. |

**When a subagent asks:**

```typescript
// In the turn triggered by the incoming ask:
intercom({ action: "reply", message: "Use exponential backoff, max 3 retries." })
```

**When a subagent sends an interview request:**

Read the rendered questions in the incoming message and reply with the exact ids in JSON. `info` questions are context-only and do not need response entries:

```typescript
intercom({
  action: "reply",
  message: "```json\n{\n  \"responses\": [\n    { \"id\": \"api\", \"value\": \"Stable API\" },\n    { \"id\": \"constraints\", \"value\": \"Keep the public error shape unchanged.\" }\n  ]\n}\n```"
})
```

**If you receive multiple pending asks from different subagents:**

```typescript
intercom({ action: "pending" })
// → Shows all unresolved inbound asks with sender, elapsed time, and preview

intercom({ action: "reply", to: "subagent-worker-78f659a3-1", message: "Use the v2 API." })
```

**Important:** Only sessions where `pi-subagents` supplied child bridge metadata
get the `contact_supervisor` tool. Normal sessions use the regular `intercom`
tool. If you see the formatted supervisor decision/progress update message, treat
it as a `contact_supervisor` escalation. A subagent may use regular `intercom` for
peer coordination, including peers in other directories, but owner decisions and
new visible project panes should go through the supervisor.

## Watch: Read Recorded History Without Messaging

### Trigger: Ask What Another Agent Is Doing

Treat these requests as a **read-only context workflow**, not a request to contact
the agent:

- "Tell me what worker is doing."
- "What is he working on?"
- "What problem did api-worker encounter?"
- "Get reviewer’s context before we continue, without interrupting him."

1. Call `intercom({ action: "list" })` to resolve the named agent or pronoun to a
   live peer. Prefer its short ID if names are duplicated; never target yourself.
   If the referent remains ambiguous, ask the user which peer they mean.
2. Call `watch` for its latest recorded activity. For a specific problem or topic,
   pass `query`; follow `olderCursor` if the relevant context predates the page.
3. Read truncated decisive events with `eventId` and `nextOffset` as needed.
4. Summarize the task, latest recorded progress, encountered problems, and next
   step **only where the history supports them**. Say "last recorded activity"
   rather than inventing a current intention; distinguish a past failure from an
   unresolved blocker. State any gaps in the available history.

Do **not** use `send`, `ask`, or `reply` to obtain this context. Do not launch a
session or fall back to messaging if watch is unavailable: report that limitation.
This workflow can supply context for your own next action without involving the
other agent at all.

**Example — user asks "What problem did api-worker encounter?"**

```typescript
intercom({ action: "list" })
// → api-worker (7a3f), thinking
intercom({ action: "watch", to: "7a3f", query: "encountered failures, errors and blockers" })
// Use returned cursors/event IDs if more context is needed; no message is sent.
```

If the recorded history shows a failed test followed by a successful rerun, answer:
"api-worker was fixing API retries. It encountered a timeout test failure, then
recorded a successful rerun. The latest recorded activity is updating the patch;
I found no later evidence of a remaining blocker."

### Calls and Examples

`watch` reads a connected peer's current-branch transcript. It is a pull read on
either transport — not a message, model wake, subscription, telemetry request, or
session launcher — so it never interrupts the target. Use it to see what another
session actually did before you send work, or to follow its progress silently.

```typescript
intercom({ action: "watch", to: "worker" })                                  // latest page
intercom({ action: "watch", to: "worker", cursor: "<olderCursor>" })         // next page back
intercom({ action: "watch", to: "worker", direction: "newer", cursor: "<newerCursor>" }) // poll forward
intercom({ action: "watch", to: "worker", query: "the failing test" })       // system_one relevance filter
intercom({ action: "watch", to: "worker", eventId: "<event ID>", offset: 0 }) // full text of one event
```

**Example — read the latest page.** The default call returns chronological events
(up to 20 / 12 KiB) plus cursors for both directions:

```typescript
intercom({ action: "watch", to: "worker" })
```

```text
Watch worker (sess-7a3f) — tool:edit — endpoint e1
Page: 3 event(s), chronological — hasOlder=true hasNewer=false truncated=false — generation gk9Q
Filter: none — no query was sent, so system_one was NOT called (pass query to enable relevance filtering)
olderCursor: YWJj...
newerCursor: ZGVm...
1. [user] 2026-10-05T10:00:01.000Z id=gk9Q:0
   Add retry logic to the API client.
2. [tool_call] 2026-10-05T10:00:04.000Z id=gk9Q:1 toolCallId=call_1
   read {"path":"src/api/client.ts"}
3. [tool_result] 2026-10-05T10:00:04.120Z id=gk9Q:2 toolCallId=call_1
   export async function fetchUser(...) { ... }
```

`hasNewer=false` means this is the tail. Feed `olderCursor` back to page into the
past (snapshot-anchored), or `newerCursor` with `direction: "newer"` to pick up
events appended after this page. An empty live tail still returns a usable
cursor, so poll again:

```typescript
intercom({ action: "watch", to: "worker", direction: "newer", cursor: page.newerCursor })
// → 0 events, hasNewer=false, fresh newerCursor (idle — poll later)
```

**Example — read one event in full.** Previews are capped at 2 KiB. Fetch the rest
by `eventId`, following byte-based `nextOffset` (a UTF-8 boundary) until absent:

```typescript
let offset = 0;
do {
  const chunk = await intercom({ action: "watch", to: "worker", eventId: "gk9Q:2", offset });
  offset = chunk.nextOffset ?? -1; // undefined = end of text
} while (offset >= 0);
```

Do not combine `eventId` with cursor, direction or query. Without a cursor, either
direction starts with the latest page. A tiny metadata budget can return
`budget_too_small`; increase `maxBytes`. Tree/session/endpoint replacement yields
`stale_cursor`; ordinary appends/compaction do not. Re-list before reusing a
target ID.

What is included: history predating the read and normal compaction, recorded tool
calls and completed results. No abandoned branches or partial streams are
exposed. System/thinking content and opaque details are excluded; images are
placeholders. Nested metadata appears only if Pi saved it, with omission
indicators; nested results are not recorded by Pi.

**Example — filter by relevance.** Passing `query` makes the watcher launch one
batched `system_one` `noul` judgment — through normal permission hooks — over at
most 40 events/32 KiB of previews and keep only events with `p >= 0.5`, each
labeled with its probability:

```typescript
intercom({ action: "watch", to: "worker", query: "the failing test" })
```

```text
Filter: system_one LAUNCHED — tool=system_one type=noul candidates=20 query="the failing test" model=unreported kept=2/20 windowExhausted=false (approximate, preview-based; p>=0.5 kept)
...
5. [tool_result] p=0.91 2026-10-05T10:04:12.000Z id=gk9Q:11 toolCallId=call_4 (truncated)
   FAIL src/api/client.test.ts ...
```

**`query` is the relevance filter switch** (nonblank, ≤2,000 characters). Without
it, `system_one` is **never** called and the whole window is returned; a watch is
not implicitly filtered. Reading the transcript and then calling `system_one`
yourself to judge it is a different thing: that produces judgments, not a
relevance selection.

Read the `Filter:` line rather than assuming:

- `filter.mode: "filtered"` — the call was launched. `filter.launched` records it
  (`tool=system_one`, `type=noul`, `candidates`), plus `query`, `model` when
  reported, `examined`/`returned` and `windowExhausted`. Returned events carry
  `score` (their probability).
- `filter.mode: "fallback"` — no model work happened. `filter.reason` says why
  (tool absent/denied, invalid answers, provider failure, or the 15-second model
  timeout) and the unfiltered window is returned instead.
- `Filter: none` / no `filter` block — no `query` was sent.

Matching is approximate, preview-based, and not an exhaustive history search;
no matches can still advance the scan cursor. No alternative model, lexical
fallback, or automatic activation is used. Cancellation stops the read.

**Sensitive data:** history sharing defaults to enabled; targets may set
`"watchEnabled": false` in intercom config and restart. User input/tool output
may contain secrets and are not automatically redacted. Existing authenticated
trust scopes—not an extra permission prompt—are the access boundary. Older peers
return `unsupported`, opted-out peers `disabled`, and excess concurrent reads
`busy` (eight/requester, 32/target; 10-second transport timeout). No stopped-session
or filesystem browsing is supported.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget; infers the sole pending ask as its reply | You don't need a response |
| `ask` | Blocks until reply (1 hour default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`) | You need an answer to continue |
| `reply` | Responds to the active or pending inbound ask | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions with live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |
| `watch` | Pulls a bounded recorded-history page without messaging or waking | Inspect a connected peer's work |

## Visible Peer Sessions

For bounded cross-codebase work, prefer `pi-subagents` with an explicit `cwd`.
Use `intercom({ action: "send", cwd: "/path", openProjectPaneIfMissing: true, ... })`
only when a long-lived visible peer session is useful.

If Herdr is unavailable, do not invent a terminal fallback inside this workflow.
Ask the user before opening another visible surface manually.

## Important Constraints

### `ask` Limitations

- **Connected targets only**: `ask` fails immediately when the target is not in the live intercom roster. Use `list` before asking when liveness is uncertain; use `send` for non-blocking mailbox delivery.
- **Configurable timeout**: If no reply arrives before the shared ask timeout, the ask fails. The default is 1 hour; set `PI_INTERCOM_ASK_TIMEOUT_MS` to a positive millisecond value to change it.
- **One at a time**: Cannot have multiple pending asks from the same session
- **Cannot self-target**: A session cannot ask itself, including through disconnected-mailbox remapping

```typescript
// Check if already waiting before asking
const result = await intercom({ action: "ask", to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Sole pending ask inference**: If the destination has exactly one pending inbound ask, `send` attaches its `replyTo` and reports `Reply sent to <target> (inferred from pending ask)`
- **Ambiguity stays unthreaded**: Zero or multiple matching asks leave the send as an ordinary message
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions confirm ordinary and inferred sends
- **Explicit replies skip confirmation**: A caller-supplied `replyTo` skips the dialog

## Best Practices

### Exchange code when discussing code or logic

When discussing implementation, algorithms, control flow, or bugs with another agent, include a fenced pseudocode or real-code block in your message instead of relying on prose alone. Use real code for exact APIs or existing behavior, and pseudocode for proposed logic. Keep snippets focused, identify the relevant file or symbol when known, and clearly label pseudocode so it is not mistaken for runnable code. Code attachments (`type: "snippet"`, with `language`) are also suitable.

Example message:

````text
Proposed logic for ui/message-history.ts peerName (pseudocode, not runnable):

```text
hash = SHA256(peer.id)
color = theme.peerPalette[hash[0] modulo palette.length]
label = theme.foreground(color, peer.name)
return bold(label) if hash[1] is odd else label
```

Please check that the same peer ID and theme produce the same style after reopening.
````

Example reply:

````text
Stability check (pseudocode):

```text
before = peerStyle(peer.id, theme)
reopen()
after = peerStyle(peer.id, theme)
assert before == after
```
````

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
const reply = await intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// Continue with the answer...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Name sessions meaningfully

Use `/name` so others can target you easily; explicit names are preserved. Unnamed sessions use a runtime-only normalized `<project>@<machine>` name. Duplicate names are shown with a short ID.

```
/name api-worker
/name frontend-dev
/name planner
```

In the prompt editor, type `@@` at the start of a line or after whitespace to autocomplete live peers by name, cwd, hostname, or short ID. Unique peers insert `@name`; duplicate names insert `@short-id`.

## Error Handling

### Common Errors and Solutions

**"Ask was cancelled" / "No active message"**

The displayed message may have been injected before its sender cancelled the blocking ask. Do not retry the acknowledgement with `send`: it may be unrelated or could target another pending ask. Use `pending` to find requests that are still active.

**"Already waiting for a reply"**
```typescript
// You can only have one pending ask at a time
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });

// Option 2: Wait for current ask to complete first
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```
With the broker transport, replies to recently disconnected explicitly named senders can be queued and delivered if that sender reconnects with the same name and directory. P2P delivery is live-only. Runtime-only `subagent-chat-...` aliases are not reconnect identities. In broker mode, new `send` calls may target a known live or recently disconnected session. P2P sends and all blocking `ask` calls require a live target.

**Ask timeout**
```typescript
// The ask will reject with a timeout error
// Default: 1 hour
// Override: set PI_INTERCOM_ASK_TIMEOUT_MS to a positive millisecond value
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded pi-intercom
3. Broker mode requires the same machine; P2P mode requires the same LAN and `PI_INTERCOM_P2P_KEY`

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. P2P sessions are rediscovered over mDNS. If persistently disconnected:

```typescript
intercom({ action: "status" })
// In broker mode, check if the broker is running. In P2P mode, check the shared key and mDNS reachability.
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code
intercom({
  action: "send",
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom({
  action: "ask",
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom({
  action: "reply",
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom({ action: "send", to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom({ action: "send", to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom({ action: "send", to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For tasks that might exceed the ask timeout, use send + periodic asks

// 1. Initial send with full context
intercom({
  action: "send",
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom({ action: "send", to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with decision...
```
