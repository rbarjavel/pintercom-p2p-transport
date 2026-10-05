import test from "node:test";
import assert from "node:assert/strict";
import { WatchHistory, projectHistory, filterWatch, formatWatchResult, jsonBytes, validateWatchRequest, validWatchResult, watchDeadline, watchError, type WatchPage, type WatchResult, type WatchToolContext } from "./watch.ts";
import type { SessionInfo } from "./types.ts";
const target: SessionInfo = { id: "target", endpointEpoch: "epoch", name: "worker", status: "tool:bash", cwd: "/test", model: "test", pid: 1, startedAt: 0, lastActivity: 0 };
const entry = (id: string, role = "user", content: unknown = id) => ({ type: "message", id, timestamp: "2026-10-05", message: { role, content } });
const history = (n: number) => Array.from({length:n}, (_,i) => entry(String(i)));
function page(result: WatchResult): WatchPage { assert.ok(!("error" in result), JSON.stringify(result)); assert.ok(validWatchResult(result)); return result; }

test("projection includes recorded conversation only, in branch order", () => {
  const events = projectHistory([
    null, { type: "custom", id: "state", data: "SECRET" }, entry("sys", "system", "SECRET"),
    entry("u", "user", [{type:"text",text:"hello\u001b[31m!"},{type:"image",data:"SECRET"}]),
    entry("a", "assistant", [{type:"thinking",thinking:"SECRET",signature:"SECRET"},{type:"text",text:"done"},{type:"toolCall",id:"call",name:"bash",arguments:{command:"pwd"}}]),
    { ...entry("r", "toolResult", [{type:"text",text:"failed"}]), message: {role:"toolResult",content:[{type:"text",text:"failed"}],toolCallId:"call",isError:true,details:{secret:"SECRET"}, nestedCalls:{complete:false,calls:[{id:"call/1",name:"read",status:"error",argumentsBytes:99999,error:"not found"}]}}},
    { ...entry("b"), message:{role:"bashExecution",command:"ls",output:"output",exitCode:1,truncated:true,cancelled:true,fullOutputPath:"SECRET"}},
    {type:"custom_message",id:"c",timestamp:"now",content:"custom",details:{secret:"SECRET"}},
    {type:"compaction",id:"compact",summary:"summary",details:"SECRET"}, {type:"branch_summary",id:"branch",summary:"other branch"},
    entry("unknown", "unknown", "SECRET"), entry("bad", "assistant", [null,{type:"unknown",data:"SECRET"}]),
  ], "g");
  assert.deepEqual(events.map(e=>e.kind), ["user","user","assistant","tool_call","tool_error","nested_calls","bash","custom","compaction","branch_summary"]);
  assert.equal(events[0].text, "hello!");
  assert.equal(events[3].toolCallId, "call"); assert.equal(events[4].toolCallId,"call");
  assert.match(events[5].text, /"complete":false/); assert.match(events[5].text, /argumentsBytes/); assert.match(events[5].text, /not recorded/);
  assert.equal(events[6].truncated,true);
  assert.ok(!JSON.stringify(events).includes("SECRET"));
});

test("older snapshot traverses without duplicates/gaps despite appends and compaction", () => {
  const h = new WatchHistory(), branch = history(55);
  let p = page(h.page(branch,"pi",target,{limit:7}));
  const ids = p.events.map(e=>e.entryId);
  const newer = p.newerCursor;
  branch.push(entry("55"), {type:"compaction",id:"compact",summary:"compacted"} as never);
  while (p.hasOlder) { p = page(h.page(branch,"pi",target,{limit:7,cursor:p.olderCursor})); ids.unshift(...p.events.map(e=>e.entryId)); }
  assert.deepEqual(ids, history(55).map(e=>e.id));
  const fresh = page(h.page(branch,"pi",target,{direction:"newer",cursor:newer}));
  assert.deepEqual(fresh.events.map(e=>e.entryId),["55","compact"]);
  const empty = page(h.page(branch,"pi",target,{direction:"newer",cursor:fresh.newerCursor}));
  assert.equal(empty.events.length,0); assert.equal(empty.hasNewer,false); assert.ok(empty.newerCursor);
  branch.push(entry("56"));
  assert.equal(page(h.page(branch,"pi",target,{direction:"newer",cursor:empty.newerCursor})).events[0].entryId,"56");
});

test("initial newer returns latest page and empty history establishes poll boundary", () => {
  const h = new WatchHistory();
  assert.deepEqual(page(h.page(history(30),"pi",target,{direction:"newer",limit:3})).events.map(e=>e.entryId),["27","28","29"]);
  const empty = page(h.page([],"pi",target,{direction:"newer"}));
  assert.ok(empty.newerCursor);
  assert.equal(page(h.page([entry("first")],"pi",target,{direction:"newer",cursor:empty.newerCursor})).events.length,1);
});

test("cursor authentication, identity, tree generation and anchors reject stale reads", () => {
  const h = new WatchHistory(), branch = history(5);
  const p = page(h.page(branch,"pi",target,{limit:2}));
  for (const [b,s,t,c] of [[branch,"different",target,p.olderCursor],[branch,"pi",{...target,id:"other"},p.olderCursor],[branch,"pi",{...target,endpointEpoch:"new"},p.olderCursor],[branch.slice(0,2),"pi",target,p.olderCursor],[branch,"pi",target,p.olderCursor!.slice(0,-3)+"abc"]] as const) {
    assert.equal((h.page(b,s,t,{cursor:c}) as {error:string}).error,"stale_cursor");
  }
  assert.equal((new WatchHistory().page(branch,"pi",target,{cursor:p.olderCursor}) as {error:string}).error,"stale_cursor");
  h.reset();
  assert.equal((h.page(branch,"pi",target,{cursor:p.olderCursor}) as {error:string}).error,"stale_cursor");
  assert.equal((h.page(branch,"pi",target,{eventId:p.events[0].id}) as {error:string}).error,"stale_event");
});

test("byte/count limits always consume a prefix, with bounded Unicode/escaped previews", () => {
  for (const text of ["😀".repeat(5000), '"\\\n'.repeat(5000)]) {
    const h = new WatchHistory(), branch = history(12).map(e=>entry(e.id,"user",text));
    let p = page(h.page(branch,"pi",target,{limit:5,maxBytes:1024}));
    const ids = p.events.map(e=>e.entryId);
    assert.ok(jsonBytes(p)<=1024); assert.ok(p.truncated);
    while (p.hasOlder) { p=page(h.page(branch,"pi",target,{limit:5,maxBytes:1024,cursor:p.olderCursor})); assert.ok(jsonBytes(p)<=1024); ids.unshift(...p.events.map(e=>e.entryId)); }
    assert.deepEqual(ids,history(12).map(e=>e.id));
    assert.ok(p.events.every(e=>Buffer.byteLength(e.text)<=2048 && !e.text.includes("�")));
  }
});

test("event text reconstructs with valid UTF-8 chunk offsets", () => {
  const h = new WatchHistory(), text='😀"\\\n'.repeat(4000), branch=[entry("large","assistant",[{type:"toolCall",id:"call",name:"bash",arguments:{command:text}}])];
  const p=page(h.page(branch,"pi",target,{}));
  assert.ok(p.events[0].truncated);
  let offset=0, rebuilt="";
  do { const chunk=page(h.page(branch,"pi",target,{eventId:p.events[0].id,offset,maxBytes:1024})); assert.ok(jsonBytes(chunk)<=1024); rebuilt+=chunk.events[0].text; if (chunk.nextOffset===undefined) break; assert.ok(chunk.nextOffset>offset); offset=chunk.nextOffset; } while(true);
  assert.equal(rebuilt,projectHistory(branch,p.generation)[0].text);
  const emoji=page(h.page([entry("emoji","user","😀")],"pi",target,{})).events[0];
  assert.equal((h.page([entry("emoji","user","😀")],"pi",target,{eventId:emoji.id,offset:1}) as {error:string}).error,"invalid_offset");
  assert.equal((h.page(branch,"pi",target,{eventId:"/etc/passwd"}) as {error:string}).error,"stale_event");
});

const mockJudge = (probability: (id:string)=>number, count: {calls:number}): WatchToolContext => ({ tools:[{name:"system_one"}], executeTool:async (_name,args) => {count.calls++; const q=(args as {questions:Record<string,unknown>}).questions; return {isError:false,result:{details:{model:"mock-jev",answers:Object.fromEntries(Object.keys(q).map(id=>[id,{type:"noul",noul:probability(id)}]))}}}; } });

test("filter batches bounded previews once, preserves order and usage accounting", async () => {
  const h=new WatchHistory(), count={calls:0};
  const candidates=page(h.page(history(100),"pi",target,{window:true}));
  assert.equal(candidates.events.length,40); assert.ok(jsonBytes(candidates)<96*1024);
  await filterWatch(candidates,{},mockJudge(()=>1,count)); assert.equal(count.calls,0);
  const filtered=page(await filterWatch(candidates,{query:"topic",limit:50},mockJudge(id=>Number(id.split(":")[1])%2===0?0.5:0.1,count)));
  assert.equal(count.calls,1); assert.equal(filtered.filter?.model,"mock-jev");
  assert.deepEqual(filtered.events.map(e=>e.entryId),Array.from({length:20},(_,i)=>String(60+i*2)));
  assert.ok(filtered.events.every(e=>!("scanCursor" in e))); assert.ok(!("usage" in filtered));
});

test("empty filtered page advances and limited results leave candidates for continuation", async () => {
  const h=new WatchHistory(), branch=history(90), count={calls:0};
  const candidates=page(h.page(branch,"pi",target,{window:true}));
  const empty=page(await filterWatch(candidates,{query:"none"},mockJudge(()=>0,count)));
  assert.equal(empty.events.length,0); assert.ok(empty.hasOlder);
  const next=page(h.page(branch,"pi",target,{window:true,cursor:empty.olderCursor}));
  assert.deepEqual(next.events.map(e=>e.entryId),Array.from({length:40},(_,i)=>String(i+10)));
  const limited=page(await filterWatch(candidates,{query:"all",limit:3},mockJudge(()=>1,count)));
  assert.deepEqual(limited.events.map(e=>e.entryId),["87","88","89"]);
  const continuation=page(h.page(branch,"pi",target,{cursor:limited.olderCursor,limit:3}));
  assert.deepEqual(continuation.events.map(e=>e.entryId),["84","85","86"]);
});

test("filtered output records the launched system_one call and per-event probabilities", async () => {
  const count = { calls: 0 };
  const candidates = page(new WatchHistory().page(history(8), "pi", target, { window: true }));
  const filtered = page(await filterWatch(candidates, { query: "topic", limit: 8 }, mockJudge(id => Number(id.split(":")[1]) % 2 === 0 ? 0.9 : 0.1, count)));
  assert.deepEqual(filtered.filter?.launched, { tool: "system_one", type: "noul", candidates: 8 });
  assert.equal(count.calls, 1);
  assert.deepEqual(filtered.events.map(e => e.score), [0.9, 0.9, 0.9, 0.9]);
  assert.ok(filtered.filter?.returned === 4 && filtered.filter.examined === 8);
  assert.ok(validWatchResult(filtered));
});

test("model-facing text is human readable and states clearly whether system_one ran", async () => {
  const candidates = page(new WatchHistory().page(history(4), "pi", target, { window: true }));
  const plain = formatWatchResult(candidates);
  assert.match(plain, /Watch worker \(target\) — tool:bash/);
  assert.match(plain, /Filter: none — no query was sent, so system_one was NOT called/);
  assert.match(plain, /^1\. \[user\] /m);
  assert.match(plain, /olderCursor: /);
  const filtered = formatWatchResult(page(await filterWatch(candidates, { query: "q" }, mockJudge(() => 0.9, { calls: 0 }))));
  assert.match(filtered, /Filter: system_one LAUNCHED — tool=system_one type=noul candidates=4 query="q"/);
  assert.match(filtered, /p=0\.9/);
  const fallback = formatWatchResult(page(await filterWatch(candidates, { query: "q" }, {})));
  assert.match(fallback, /Filter: NOT used \(fallback\).*system_one unavailable or not callable/s);
  assert.equal(formatWatchResult(watchError("not_found")), "Watch failed: not_found");
  assert.match(formatWatchResult(candidates, 10), /"generation"/);
});

test("unavailable, denied, failed and invalid filters fall back to the same window", async () => {
  const h=new WatchHistory(), candidates=page(h.page(history(8),"pi",target,{window:true}));
  for (const ctx of [{},{tools:[{name:"system_one"}],executeTool:async()=>({isError:true})},{tools:[{name:"system_one"}],executeTool:async()=>{throw new Error("provider failed");}},{tools:[{name:"system_one"}],executeTool:async()=>({result:{details:{answers:{wrong:{type:"noul",noul:1}}}}})}] satisfies WatchToolContext[]) {
    const p=page(await filterWatch(candidates,{query:"topic"},ctx));
    assert.equal(p.filter?.mode,"fallback"); assert.ok(p.filter?.reason); assert.deepEqual(p.events.map(e=>e.id),candidates.events.map(e=>e.id));
  }
  assert.equal((await filterWatch(candidates,{query:"x".repeat(2000),maxBytes:1024},{}) as {error:string}).error,"budget_too_small");
});

test("deadlines and cancellation stop noncooperative work without fallback", async () => {
  await assert.rejects(watchDeadline(()=>new Promise(()=>{}),10),/timeout/);
  const c=new AbortController();
  const p=page(new WatchHistory().page(history(2),"pi",target,{window:true}));
  const call=filterWatch(p,{query:"q"},{tools:[{name:"system_one"}],executeTool:()=>new Promise(()=>{})},c.signal);
  c.abort(new Error("cancelled"));
  await assert.rejects(call,/cancelled/);
});

test("model deadline falls back without a live backend", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const candidates = page(new WatchHistory().page(history(2), "pi", target, { window: true }));
  const pending = filterWatch(candidates, { query: "q" }, { tools: [{ name: "system_one" }], executeTool: () => new Promise(() => {}) });
  t.mock.timers.tick(15_000);
  const result = page(await pending);
  assert.equal(result.filter?.mode, "fallback"); assert.match(result.filter?.reason ?? "", /timeout/);
  assert.equal(result.events.length, 2);
});

test("large preview windows and filtered budgets remain bounded without skipping matches", async () => {
  const h = new WatchHistory(), branch = history(100).map(e => entry(e.id, "user", "😀".repeat(2000)));
  const window = page(h.page(branch, "pi", target, { window: true }));
  assert.equal(window.events.length, 16);
  assert.equal(window.events.reduce((n, e) => n + Buffer.byteLength(e.text), 0), 32768);
  const count = { calls: 0 };
  const filtered = page(await filterWatch(window, { query: "all", maxBytes: 1024 }, mockJudge(() => 1, count)));
  assert.ok(jsonBytes(filtered) <= 1024); assert.equal(count.calls, 1); assert.ok(filtered.events[0].truncated);
  const next = page(h.page(branch, "pi", target, { cursor: filtered.olderCursor, limit: 1 }));
  assert.equal(Number(next.events[0].entryId), Number(filtered.events[0].entryId) - 1);
});

test("response validators reject opaque extras, malformed metadata and caller-budget violations", () => {
  const valid = page(new WatchHistory().page(history(2), "pi", target, {}));
  assert.equal(validWatchResult({ ...valid, details: { secret: "hidden" } }), false);
  assert.equal(validWatchResult({ ...valid, nextOffset: -1 }), false);
  assert.equal(validWatchResult({ ...valid, events: [{ ...valid.events[0], opaque: "hidden" }] }), false);
  assert.equal(validWatchResult(valid, { limit: 1 }), false);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.equal(validWatchResult(cycle), false);
});

test("request validator rejects malformed, oversized and conflicting inputs", () => {
  for (const input of [null,[],{limit:0},{limit:51},{maxBytes:1023},{maxBytes:32769},{query:" "},{query:"x".repeat(2001)},{cursor:"x".repeat(2049)},{direction:"sideways"},{offset:0},{eventId:"id",direction:"older"},{eventId:"id",query:"q"},{eventId:"id",cursor:"c"},{eventId:"id",offset:0.5},{path:"/tmp/history"}]) assert.throws(()=>validateWatchRequest(input));
  assert.doesNotThrow(()=>validateWatchRequest({eventId:"id",offset:0}));
});
