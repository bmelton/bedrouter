import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, ToolJsonCheck } from "../src/router.js";
import { modelTable, resolveModel, type Config, type Rung } from "../src/config.js";

const caps = (patch = {}) => ({ transport: "bedrock-runtime" as const, api: "converse" as const, toolUse: true, streaming: true, imageInput: false, structuredOutputs: true, promptCaching: false, contextWindow: 10000, maxOutput: 1000, ...patch });
const rr = (alias:string,vendor:string,serves:Rung["serves"],patch:Partial<Rung>={}):Rung=>({alias,vendor,serves,enabled:true,bedrockId:alias,inputPerM:1,outputPerM:2,capabilities:caps(),...patch});
const cfg:Config={stack:[rr("tiny","a",["trivial"]),rr("work-a","a",["execute"]),rr("work-b","b",["execute"]),rr("deep-b","b",["execute","explore"]),rr("deep-a","a",["explore"],{capabilities:caps({promptCaching:true,imageInput:true})})],routing:{enabled:true,keywords:{explore:["design"],execute:["implement"]},retryWindowMs:-1}};
const table=modelTable(cfg),model=(id:string)=>resolveModel(table,id)!;
const msg=(text:string,extra={})=>({model:"auto",messages:[{role:"user",content:text}],...extra});

test("routing uses the cheapest eligible serving rung and preserves an incumbent vendor",()=>{const r=new Router(cfg);assert.equal(r.route(msg("implement it"),model("auto")).rung.alias,"work-a");
 // deep-a is the only caching rung, so at the default 0.8 hit rate it is the cheapest explore rung despite an equal list price
 const first=r.route(msg("design it"),model("auto"));assert.equal(first.rung.alias,"deep-a");
 const next=r.route({model:"auto",messages:[{role:"user",content:"design it"},{role:"assistant",content:"ok"},{role:"user",content:"implement"}]},model("auto"));
 assert.equal(next.rung.vendor,"a");assert.equal(next.rung.alias,"work-a")});
test("capability filtering records skips and cache degradation",()=>{const r=new Router(cfg);const d=r.route(msg("implement",{tools:[{}],max_tokens:900}),model("auto"));assert.equal(d.rung.alias,"work-a");const image=r.route({model:"auto",messages:[{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,eA=="}}]}]},model("auto"),"explore");assert.equal(image.rung.alias,"deep-a");assert.ok(image.skipped.some(x=>x.includes("no-image-input")));
 // a cache point only degrades on a rung without caching, so pin the execute tier to see it
 const cached=r.route(msg("design",{system:[{cachePoint:{type:"default"}}]}),model("auto"),"execute");assert.ok(cached.degraded.some(x=>x.includes("strip-cachePoint")),`got ${cached.degraded}`)});
test("caching is priced into the order, so a dearer rung can rank ahead of a cheaper one",()=>{
 const plain=rr("plain","a",["execute"],{inputPerM:.5}),caching=rr("caching","b",["execute"],{inputPerM:1,capabilities:caps({promptCaching:true})});
 const c:Config={stack:[plain,caching],routing:{enabled:true,cacheHitRate:.8,keywords:{explore:[],execute:[]}}};
 // 1.0 * (1 - 0.9*0.8) = 0.28 beats a flat 0.5
 assert.equal(new Router(c).ranked.map(r=>r.alias).join(","),"caching,plain");
 // at a zero hit rate nothing is cached, so list price decides again
 assert.equal(new Router({...c,routing:{...c.routing,cacheHitRate:0}}).ranked.map(r=>r.alias).join(","),"plain,caching");
});
test("injected harness turns never set the class, and a human turn can lower it again",()=>{
 const r=new Router(cfg);
 // the real failure: a 17KB session digest mentioning "design" once, sent as a user turn after a plain "hi"
 const digest="⁣FIRSTMATE_OP: v1 session-start: "+"x".repeat(4000)+" design the architecture ";
 const first=r.route({model:"auto",messages:[{role:"user",content:"hi"},{role:"user",content:digest}]},model("auto"));
 assert.notEqual(first.class,"explore");
 // an unmarked but oversized injection is caught by the size cap alone
 const big=r.route({model:"auto",messages:[{role:"user",content:"hi"},{role:"user",content:"design ".repeat(2000)}]},model("auto"));
 assert.notEqual(big.class,"explore");
 // a genuine explore turn still works, then a genuine execute turn escapes it instead of sticking forever
 const up=r.route({model:"auto",messages:[{role:"user",content:"design it"}]},model("auto"));
 assert.equal(up.class,"explore");
 const down=r.route({model:"auto",messages:[{role:"user",content:"design it"},{role:"assistant",content:"ok"},{role:"user",content:"implement it"}]},model("auto"));
 assert.equal(down.class,"execute");
 assert.match(down.classReason,/^downgrade:/);
});
test("a classifier verdict of trivial is floored at execute when the request carries tools",()=>{
 const r=new Router(cfg);
 const withTools={model:"auto",tools:[{}],messages:[{role:"user",content:"hi"}]};
 const d=r.route(withTools,model("auto"));
 // "hi" with tools attached: an agentic harness can still ask for a tool call, as firstmate's startup checks do
 const floored=r.reclassify(d,model("auto"),"trivial","classifier:trivial",withTools);
 assert.equal(floored.class,"execute");
 assert.match(floored.classReason,/tools-floor$/);
 // with no tools in the request the verdict stands
 const bare={model:"auto",messages:[{role:"user",content:"hi"}]};
 const plain=r.reclassify(r.route(bare,model("auto")),model("auto"),"trivial","classifier:trivial",bare);
 assert.equal(plain.class,"trivial");
 assert.equal(plain.classReason,"classifier:trivial");
});
test("retry and observed failure walk right and raise class at the end",()=>{const r=new Router(cfg);const d=r.route(msg("implement"),model("auto"));assert.equal(r.observe(d,{errorStatus:429}).escalated,true);const n=r.route({model:"auto",messages:[{role:"user",content:"implement"},{role:"assistant",content:"x"},{role:"user",content:"continue"}]},model("auto"));assert.equal(n.rung.alias,"work-b")});
test("pinned cheap model bypasses routing and tool fragments validate",()=>{const r=new Router(cfg);assert.equal(r.route(msg("design"),model("tiny")).classReason,"client-model:pinned");const t=new ToolJsonCheck();t.add(0,'{"x":');t.add(0,"1}");assert.equal(t.malformed(),false);t.add(1,"{");assert.equal(t.malformed(),true)});
