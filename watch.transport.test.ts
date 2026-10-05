import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WatchHistory, watchError, type WatchPage, type WatchResult } from "./watch.ts";
import type { SessionRegistration } from "./types.ts";
const registration = (name: string, watchEnabled?: boolean): SessionRegistration => ({ name, ...(watchEnabled === undefined ? {} : {watchEnabled}), cwd:process.cwd(),model:"test",pid:process.pid,startedAt:1,lastActivity:1 });
const recorded = (id:string) => ({type:"message",id,timestamp:"now",message:{role:"user",content:id}});
const asPage = (r:WatchResult):WatchPage => {assert.ok(!("error" in r),JSON.stringify(r));return r;};

async function eventually(check:()=>boolean):Promise<void> {
  const end=Date.now()+3000;
  while (!check()) { if(Date.now()>end) assert.fail("Condition timed out"); await new Promise(r=>setTimeout(r,5)); }
}

test("broker watch uses dedicated live routes, authorization and bounded lifecycle", {timeout:60_000}, async t => {
  const root=mkdtempSync(join(tmpdir(),"intercom-watch-")), previous=process.env.PI_CODING_AGENT_DIR, scope=process.env.PI_INTERCOM_SCOPE_ID;
  process.env.PI_CODING_AGENT_DIR=root; delete process.env.PI_INTERCOM_SCOPE_ID;
  const {IntercomClient}=await import("./broker/client.ts");
  const {writeMessage}=await import("./broker/framing.ts");
  const broker=spawn(process.execPath,[join(process.cwd(),"node_modules/tsx/dist/cli.mjs"),"broker/broker.ts"],{env:process.env,stdio:["ignore","pipe","pipe"]});
  const clients:InstanceType<typeof IntercomClient>[]=[];
  const connect=async(id:string,enabled?:boolean) => {const c=new IntercomClient();c.on("error",()=>{});clients.push(c);await c.connect(registration(id,enabled),id);return c;};
  try {
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Broker startup timeout")),5000);broker.stdout!.on("data",b=>{if(b.toString().includes("Intercom broker started")){clearTimeout(timer);resolve();}});broker.once("exit",()=>{clearTimeout(timer);reject(new Error("Broker exited"));});});
    const requester=await connect("watcher",true), target=await connect("target",true), disabled=await connect("disabled",false), old=await connect("old");
    const h=new WatchHistory(), branch=[recorded("earlier")];
    target.setWatchProvider(request=>h.page(branch,"pi",{...registration("target",true),id:"target",endpointEpoch:target.endpointEpoch},request));
    let injections=0, broadcasts=0;
    target.on("message",()=>injections++); requester.onBrokerMessage(m=>{if(!["session_joined","session_left"].includes(m.type)) broadcasts++;});
    await t.test("earlier history, appends and polling cause no conversational messages or broadcasts",async()=>{
      const p=asPage(await requester.watch("target",{}));assert.equal(p.events[0].text,"earlier");
      branch.push(recorded("new"));
      const newer=asPage(await requester.watch("target",{direction:"newer",cursor:p.newerCursor}));assert.deepEqual(newer.events.map(e=>e.text),["new"]);
      assert.equal(injections,0);assert.equal(broadcasts,0);assert.deepEqual(readdirSync(join(root,"intercom/pending-asks")),[]);
      const empty=asPage(await requester.watch("target",{direction:"newer",cursor:newer.newerCursor}));assert.equal(empty.events.length,0);assert.ok(empty.newerCursor);
    });
    await t.test("disabled, mixed version, self and cross-scope targets refuse reads",async()=>{
      assert.equal((await requester.watch("disabled",{}) as {error:string}).error,"disabled");
      assert.equal((await requester.watch("old",{}) as {error:string}).error,"unsupported");
      assert.equal((await requester.watch("watcher",{}) as {error:string}).error,"self_target");
      process.env.PI_INTERCOM_SCOPE_ID="other";const isolated=await connect("isolated",true);delete process.env.PI_INTERCOM_SCOPE_ID;
      assert.equal((await isolated.watch("target",{}) as {error:string}).error,"not_found");
      assert.equal((await requester.watch("missing",{}) as {error:string}).error,"not_found");
    });
    await t.test("eight in-flight reads, cancellation and late replies clean up",async()=>{
      target.setWatchProvider((_r,signal)=>new Promise(resolve=>signal.addEventListener("abort",()=>resolve(watchError("late")),{once:true})));
      const controller=new AbortController();
      const reads=Array.from({length:8},()=>requester.watch("target",{},controller.signal).catch(e=>e));
      await eventually(()=>Reflect.get(target,"inboundWatches").size===8);
      assert.equal((await requester.watch("target",{}) as {error:string}).error,"busy");
      controller.abort(new Error("cancelled"));await Promise.all(reads);
      await eventually(()=>Reflect.get(target,"inboundWatches").size===0);
      assert.equal(Reflect.get(requester,"pendingWatches").size,0);
    });
    await t.test("spoofed replies cannot satisfy another target's route",async()=>{
      target.setWatchProvider(()=>new Promise(()=>{}));const attacker=await connect("attacker",true),controller=new AbortController();
      const read=requester.watch("target",{},controller.signal).catch(e=>e);
      await eventually(()=>Reflect.get(target,"inboundWatches").size===1);
      const id=Reflect.get(target,"inboundWatches").keys().next().value;
      writeMessage(Reflect.get(attacker,"socket"),{type:"watch_response",requestId:id,result:watchError("spoofed")});
      await eventually(()=>!attacker.isConnected());
      assert.equal(Reflect.get(requester,"pendingWatches").size,1);
      controller.abort();await read;await eventually(()=>Reflect.get(target,"inboundWatches").size===0);
    });
    await t.test("32 target routes reject excess readers and replacement clears routes",async()=>{
      target.setWatchProvider(()=>new Promise(()=>{}));const controller=new AbortController();const extra=[];
      for(let i=0;i<4;i++)extra.push(await connect(`reader-${i}`,true));
      const reads=extra.flatMap(c=>Array.from({length:8},()=>c.watch("target",{},controller.signal).catch(e=>e)));
      await eventually(()=>Reflect.get(target,"inboundWatches").size===32);
      assert.equal((await requester.watch("target",{}) as {error:string}).error,"busy");
      const replacement=await connect("target",true);replacement.setWatchProvider(()=>watchError("replacement"));
      const results=await Promise.all(reads);assert.ok(results.every(r=>r.error==="disconnected"));
      assert.equal((await requester.watch("target",{}) as {error:string}).error,"replacement");
      controller.abort();
    });
    await t.test("malformed and oversized requests/replies are rejected before exposing history",async()=>{
      const victim=await connect("victim",true), attacker=await connect("malformed",true);
      victim.setWatchProvider(()=>new Promise(()=>{}));
      writeMessage(Reflect.get(attacker,"socket"),{type:"watch_request",requestId:"bad",to:"victim",targetEpoch:victim.endpointEpoch,request:{cursor:"x".repeat(9000)}});
      await eventually(()=>!attacker.isConnected());assert.equal(Reflect.get(victim,"inboundWatches").size,0);
      const read=requester.watch("victim",{});
      await eventually(()=>Reflect.get(victim,"inboundWatches").size===1);
      const id=Reflect.get(victim,"inboundWatches").keys().next().value;
      writeMessage(Reflect.get(victim,"socket"),{type:"watch_response",requestId:id,result:{error:"bad",reason:"x".repeat(100_000)}});
      assert.equal((await read as {error:string}).error,"disconnected");
    });
    await t.test("history timeout cancels a noncooperative provider",async()=>{
      const timeout=await connect("timeout",true);let aborted=false;
      timeout.setWatchProvider((_r,s)=>{s.addEventListener("abort",()=>aborted=true);return new Promise(()=>{});});
      const result=await requester.watch("timeout",{}).catch(e=>({error:e.message}));
      assert.match((result as {error:string}).error,/timeout/);
      await eventually(()=>aborted && Reflect.get(timeout,"inboundWatches").size===0);
    });
    void disabled;void old;
  } finally {
    await Promise.allSettled(clients.map(c=>c.disconnect()));
    if(broker.exitCode===null){const exited=once(broker,"exit");broker.kill("SIGTERM");await exited;}
    rmSync(root,{recursive:true,force:true});
    if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
    if(scope===undefined)delete process.env.PI_INTERCOM_SCOPE_ID;else process.env.PI_INTERCOM_SCOPE_ID=scope;
  }
});

test("P2P watch retains authenticated encrypted request/response isolation",{timeout:60_000},async t=>{
  const previous=process.env.PI_INTERCOM_P2P_KEY,scope=process.env.PI_INTERCOM_SCOPE_ID;process.env.PI_INTERCOM_P2P_KEY="watch-test-key-12345678";delete process.env.PI_INTERCOM_SCOPE_ID;
  const {P2PIntercomClient}=await import("./p2p/client.ts");
  const watcher=new P2PIntercomClient(),target=new P2PIntercomClient();
  const wire=async()=>{const a=Reflect.get(watcher,"node"),b=Reflect.get(target,"node");await a.dial(b.getMultiaddrs());await Reflect.apply(Reflect.get(watcher,"announceToPeer"),watcher,[b.peerId]);await Reflect.apply(Reflect.get(target,"announceToPeer"),target,[a.peerId]);};
  try {
    await watcher.connect(registration("watcher",true),"watcher");await target.connect(registration("target",true),"target");await wire();
    const h=new WatchHistory(),branch=[recorded("before watch")];let injected=0,telemetry=0;
    target.on("message",()=>injected++);Reflect.set(target,"report",()=>telemetry++);Reflect.set(watcher,"report",()=>telemetry++);
    const provide=()=>target.setWatchProvider(request=>h.page(branch,"pi",{...registration("target",true),id:"target",endpointEpoch:target.endpointEpoch},request));provide();
    await t.test("backfill and polling do not inject, wake or report telemetry",async()=>{
      const p=asPage(await watcher.watch("target",{}));assert.equal(p.events[0].text,"before watch");branch.push(recorded("later"));
      assert.equal(asPage(await watcher.watch("target",{cursor:p.newerCursor,direction:"newer"})).events[0].text,"later");assert.equal(injected,0);assert.equal(telemetry,0);
      assert.equal((await watcher.watch("watcher",{}) as {error:string}).error,"self_target");
      assert.equal((await watcher.watch("missing",{}) as {error:string}).error,"not_found");
    });
    await t.test("peer/session, epoch, destination, scope and malformed envelopes refuse history",async()=>{
      const peer=Reflect.get(watcher,"node").peerId,from=Reflect.get(watcher,"registration");
      const base={type:"watch",from,to:"target",targetEpoch:target.endpointEpoch,requestId:"r",request:{}};
      for(const bad of [{...base,from:{...from,id:"impostor"}},{...base,from:{...from,endpointEpoch:"wrong"}},{...base,to:"wrong"},{...base,targetEpoch:"wrong"},{...base,scopeId:"other"},{...base,request:{query:" "}},{...base,request:{cursor:"x".repeat(9000)}}]){
        const response=await Reflect.apply(Reflect.get(target,"handleEnvelope"),target,[bad,peer]);assert.partialDeepStrictEqual(response, { ok: false });
      }
      const stranger=Reflect.get(target,"node").peerId;
      assert.partialDeepStrictEqual(await Reflect.apply(Reflect.get(target,"handleEnvelope"),target,[base,stranger]), { ok: false });
      assert.throws(()=>Reflect.apply(Reflect.get(target,"verify"),target,[{payload:base,mac:"0".repeat(64)}]),/authentication/);
    });
    await t.test("sharing disabled and older peers are identified without sending history requests",async()=>{
      const peer=Reflect.get(watcher,"peers").get("target"),epoch=peer.session.endpointEpoch;
      peer.session.watchEnabled=false;assert.equal((await watcher.watch("target",{}) as {error:string}).error,"disabled");
      delete peer.session.watchEnabled;assert.equal((await watcher.watch("target",{}) as {error:string}).error,"unsupported");peer.session.watchEnabled=true;
      Reflect.get(target,"registration").watchEnabled=false;assert.equal((await watcher.watch("target",{}) as {error:string}).error,"disabled");Reflect.get(target,"registration").watchEnabled=true;
      peer.session.endpointEpoch="wrong";assert.equal((await watcher.watch("target",{}) as {error:string}).error,"unauthorized");peer.session.endpointEpoch=epoch;
    });
    await t.test("concurrent reads cancel and clean up both sides",async()=>{
      target.setWatchProvider(()=>new Promise(()=>{}));const c=new AbortController();
      const reads=Array.from({length:8},()=>watcher.watch("target",{},c.signal).catch(e=>e));
      await eventually(()=>Reflect.get(target,"incomingWatches").size===8);
      assert.equal((await watcher.watch("target",{}) as {error:string}).error,"busy");c.abort(new Error("cancelled"));await Promise.all(reads);
      await eventually(()=>Reflect.get(target,"incomingWatches").size===0);assert.equal(Reflect.get(watcher,"outgoingWatches").size,0);
      provide();assert.equal(asPage(await watcher.watch("target",{})).events.length,2);
    });
    await t.test("target-wide limit rejects a 33rd authenticated read", async () => {
      target.setWatchProvider(() => new Promise(() => {}));
      const controller = new AbortController(), reads = [];
      for (let i = 0; i < 4; i++) {
        const id = `fake-reader-${i}`;
        const peer = { toString: () => id, equals: (other: { toString(): string }) => other.toString() === id };
        const from = { ...registration(id, true), id, endpointEpoch: id };
        Reflect.apply(Reflect.get(target, "upsertPeer"), target, [peer, from]);
        for (let j = 0; j < 8; j++) reads.push(Reflect.apply(Reflect.get(target, "handleEnvelope"), target, [{ type: "watch", from, to: "target", targetEpoch: target.endpointEpoch, requestId: `${i}-${j}`, request: {} }, peer, controller.signal]));
      }
      assert.equal(Reflect.get(target, "incomingWatches").size, 32);
      const from = Reflect.get(watcher, "registration"), peer = Reflect.get(watcher, "node").peerId;
      const excess = await Reflect.apply(Reflect.get(target, "handleEnvelope"), target, [{ type: "watch", from, to: "target", targetEpoch: target.endpointEpoch, requestId: "excess", request: {} }, peer]);
      assert.partialDeepStrictEqual(excess, { watch: { error: "busy" } });
      controller.abort(); await Promise.all(reads); assert.equal(Reflect.get(target, "incomingWatches").size, 0);
    });
    await t.test("wrong response correlation and oversized wire replies are refused", async () => {
      const originalRequest = Reflect.get(watcher, "request");
      Reflect.set(watcher, "request", async () => ({ ok: true, requestId: "wrong", endpointEpoch: target.endpointEpoch, watch: watchError("spoofed") }));
      assert.equal((await watcher.watch("target", {}) as { error: string }).error, "stale_target");
      Reflect.set(watcher, "request", originalRequest);
      const handler = Reflect.get(target, "handleEnvelope");
      Reflect.set(target, "handleEnvelope", async () => ({ ok: true, requestId: "wrong", endpointEpoch: target.endpointEpoch, watch: { error: "bad", reason: "x".repeat(100_000) } }));
      try { await assert.rejects(watcher.watch("target", {}), /Oversized watch response/); }
      finally { Reflect.set(target, "handleEnvelope", handler); }
    });
    await t.test("history timeout cleans up a noncooperative provider",async()=>{
      target.setWatchProvider(()=>new Promise(()=>{}));const r=await watcher.watch("target",{}).catch(e=>({error:e.message}));assert.match((r as {error:string}).error,/timeout|timed out/);
      await eventually(()=>Reflect.get(target,"incomingWatches").size===0);
    });
    await t.test("disconnect aborts in-flight history rather than delivering late results",async()=>{
      target.setWatchProvider(()=>new Promise(()=>{}));const read=watcher.watch("target",{}).catch(e=>({error:e.message}));await eventually(()=>Reflect.get(target,"incomingWatches").size===1);
      await target.disconnect();const result=await read;assert.ok("error" in result);assert.equal(Reflect.get(target,"incomingWatches").size,0);
    });
  } finally {await Promise.allSettled([watcher.disconnect(),target.disconnect()]);if(previous===undefined)delete process.env.PI_INTERCOM_P2P_KEY;else process.env.PI_INTERCOM_P2P_KEY=previous;if(scope===undefined)delete process.env.PI_INTERCOM_SCOPE_ID;else process.env.PI_INTERCOM_SCOPE_ID=scope;}
});
