import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.js";
process.env.BEDROUTER_LOG=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"bedrouter-")),"log.jsonl");

// A stand-in for the Codex endpoint, started before server.js is imported because the real URL is read once at load.
import http from "node:http";
const codex:{mode:"ok"|"quota"|"dead"|"spent";calls:any[]}={mode:"ok",calls:[]};
const sse=(...events:any[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("");
const codexServer=http.createServer((req,res)=>{
 let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{
  codex.calls.push(JSON.parse(raw||"{}"));
  const quota={"x-codex-plan-type":"plus","x-codex-primary-used-percent":codex.mode==="spent"?"97":"3","x-codex-primary-reset-after-seconds":"600"};
  if(codex.mode==="dead"){res.writeHead(401,{"content-type":"application/json"});return res.end(JSON.stringify({error:{message:"Could not parse your authentication token."}}))}
  if(codex.mode==="quota"){res.writeHead(429,{"content-type":"application/json","retry-after":"120"});return res.end(JSON.stringify({detail:"rate limited"}))}
  res.writeHead(200,{"content-type":"text/event-stream",...quota});
  res.end(sse(
   {type:"response.created"},
   {type:"response.output_item.added",item:{id:"fc_1",type:"function_call",name:"do_it",call_id:"call_1"}},
   {type:"response.function_call_arguments.delta",item_id:"fc_1",delta:'{"a":1}'},
   {type:"response.completed",response:{usage:{input_tokens:70,output_tokens:9}}}));
 });
});
await new Promise<void>(r=>codexServer.listen(0,"127.0.0.1",()=>r()));
codexServer.unref();
process.env.BEDROUTER_CODEX_ENDPOINT=`http://127.0.0.1:${(codexServer.address() as AddressInfo).port}/responses`;
const jwt=(exp:number)=>`h.${Buffer.from(JSON.stringify({exp})).toString("base64url")}.s`;
const codexAuthFile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"bedrouter-codex-")),"auth.json");
fs.writeFileSync(codexAuthFile,JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:jwt(Math.floor(Date.now()/1000)+86400),account_id:"acct-1"}}));

const {createServer}=await import("../src/server.js");
const cap={transport:"bedrock-runtime" as const,api:"converse" as const,toolUse:true,streaming:true,imageInput:false,structuredOutputs:true,promptCaching:false,contextWindow:200000,maxOutput:64000};
const cfg:Config={stack:[
 {alias:"tiny",modelId:"t",vendor:"amazon",enabled:true,inputPerM:.1,outputPerM:.2,serves:["trivial"],capabilities:{...cap,promptCaching:true}},
 {alias:"work",modelId:"w",vendor:"openai",enabled:true,inputPerM:.2,outputPerM:.4,serves:["execute"],capabilities:cap},
 {alias:"deep",modelId:"d",vendor:"anthropic",enabled:true,inputPerM:1,outputPerM:5,serves:["execute","explore"],capabilities:{...cap,promptCaching:true,imageInput:true}}
],routing:{enabled:true,keywords:{explore:["design"],execute:["implement"]},classifier:{enabled:false}}};
const reply={output:{message:{role:"assistant",content:[{text:"hi"}]}},stopReason:"end_turn",usage:{inputTokens:10,outputTokens:5}};
const anthropic={body:Buffer.from(JSON.stringify({content:[{type:"text",text:"hi"}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:5}}))};
async function run(config:Config,send:(cmd:any)=>Promise<any>,fn:(base:string)=>Promise<void>){const server=createServer(config,{send});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;try{await fn(base)}finally{server.close()}}
const post=async(base:string,path:string,body:any)=>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return{r,json:await r.json()}};

test("messages remains a native path for pinned Anthropic rungs and refuses auto",async()=>{const sent:any[]=[];await run(cfg,async c=>{sent.push(c.input);return anthropic},async base=>{assert.equal((await post(base,"/v1/messages",{model:"deep",messages:[{role:"user",content:"hi"}],max_tokens:10})).r.status,200);assert.equal(sent[0].modelId,"d");assert.equal((await post(base,"/v1/messages",{model:"auto",messages:[{role:"user",content:"hi"}],max_tokens:10})).r.status,400)})});

test("auto uses chat/Converse, exposes stack metadata, and strips cache points only when needed",async()=>{const sent:any[]=[];await run(cfg,async c=>{sent.push(c.input);return reply},async base=>{const body={model:"auto",messages:[{role:"user",content:"implement it"},{cachePoint:{type:"default"}}]};const out=await post(base,"/v1/chat/completions",body);assert.equal(out.r.status,200);assert.equal(sent[0].modelId,"w");assert.doesNotMatch(JSON.stringify(sent[0]),/cachePoint/);const models=await(await fetch(base+"/v1/models")).json();const auto=models.data.find((m:any)=>m.id==="auto");assert.equal(auto.bedrouter.vendor,"openai");assert.deepEqual(auto.bedrouter.serves,["execute"]);assert.equal(auto.bedrouter.capabilities.maxOutput,64000)})});

test("the output cap is read from either OpenAI field, never steers selection, and is clamped per rung",async()=>{
 // a dearer rung that could deliver the full 128k must NOT be preferred: clients send a defensive ceiling, not a
 // requirement, so honouring it would silently buy capacity almost no turn uses
 const big={...cfg.stack[1],alias:"big",modelId:"b",inputPerM:9,capabilities:{...cap,maxOutput:128000}};
 const picked:string[]=[];
 await run({...cfg,stack:[...cfg.stack,big]},async c=>{picked.push(c.input.modelId);return reply},async base=>{
  assert.equal((await post(base,"/v1/chat/completions",{model:"auto",max_completion_tokens:128000,messages:[{role:"user",content:"implement it"}]})).r.status,200);
  assert.deepEqual(picked,["w"],"must stay on the cheap rung and clamp, not jump to the 128k rung");
 });
 // the outgoing value is brought down to the chosen rung's own limit
 const sent:any[]=[];
 await run(cfg,async c=>{sent.push(c.input);return reply},async base=>{
  const out=await post(base,"/v1/chat/completions",{model:"auto",max_completion_tokens:128000,messages:[{role:"user",content:"implement it"}]});
  assert.equal(out.r.status,200);
  assert.equal(sent[0].inferenceConfig.maxTokens,64000,"must be clamped to the rung limit, not sent as asked");
  const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);
  assert.ok(log.degraded.some((x:string)=>x.startsWith("work:clamp-maxTokens")),`expected a clamp note in ${log.degraded}`);
 });
});

test("an unentitled rung is dropped inside the request, then stays out of the pool",async()=>{
 const ids:string[]=[];
 const denied=(id:string)=>Object.assign(new Error(`anthropic.x is not available for this account`),{name:"AccessDeniedException",$metadata:{httpStatusCode:403}});
 // explore wants "deep" first; this account cannot invoke it, so the request must still be answered by "work".
 await run(cfg,async c=>{ids.push(c.input.modelId);if(c.input.modelId==="d")throw denied("d");return reply},async base=>{
  const first=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"design the whole system"}]});
  assert.equal(first.r.status,200);
  assert.deepEqual(ids,["d","w"]);
  const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);
  assert.equal(log.routedModel,"work");
  assert.ok(log.skipped.some((x:string)=>x==="deep:unavailable"),`expected deep:unavailable in ${log.skipped}`);
  // a different conversation must not pay the failed call again
  const second=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"design a different system"}]});
  assert.equal(second.r.status,200);
  assert.deepEqual(ids,["d","w","w"],"the denied rung must not be tried a second time");
 });
});

test("a rung denied for every eligible class surfaces the error instead of looping",async()=>{
 const only:Config={...cfg,stack:[cfg.stack[2]]};
 let calls=0;
 await run(only,async()=>{calls++;throw Object.assign(new Error("not available for this account"),{name:"AccessDeniedException",$metadata:{httpStatusCode:403}})},async base=>{
  const out=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"design it"}]});
  assert.equal(out.r.status,403);
  assert.equal(calls,1,"nothing left to reselect, so no retry");
 });
});

test("a capability ValidationException re-picks inside the same request and records the contradiction",async()=>{const ids:string[]=[];await run(cfg,async c=>{ids.push(c.input.modelId);if(ids.length===1)throw Object.assign(new Error("tool use is not supported"),{name:"ValidationException",$metadata:{httpStatusCode:400}});return reply},async base=>{const out=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]});assert.equal(out.r.status,200);assert.deepEqual(ids,["w","d"]);const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);assert.equal(log.vendor,"anthropic");assert.ok(log.skipped.some((x:string)=>x.includes("validation-contradiction")))})});

test("the dashboard serves the same view model as the page, and is not on the request path",async()=>{
 await run(cfg,async()=>reply,async base=>{
  await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]});
  const data=await(await fetch(base+"/dashboard/data.json")).json();
  // No baselineAlias is configured above, so the dearest enabled rung that serves explore stands in for "no router".
  assert.equal(data.baseline.alias,"deep");
  assert.ok(data.totals.requests>0);
  assert.ok(!JSON.stringify(data).includes("classifierNote"));
  const page=await fetch(base+"/dashboard");
  assert.equal(page.headers.get("content-type"),"text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy")??"",/default-src 'none'/);
  assert.match(await page.text(),/<svg/);
  const bad=await fetch(base+"/dashboard?since=not-a-time");
  assert.equal(bad.status,400,"a bad parameter answers for itself and leaves the router alone");
 });
});

test("a baselineAlias naming a rung that is not in the stack fails the dashboard, not the router",async()=>{
 await run({...cfg,routing:{...cfg.routing,baselineAlias:"ghost"}},async()=>reply,async base=>{
  assert.equal((await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"hi"}]})).r.status,200);
  const out=await fetch(base+"/dashboard/data.json");
  assert.equal(out.status,502);
  assert.match(JSON.stringify(await out.json()),/not a rung in the stack/);
 });
});

const codexCap={transport:"openai-responses" as const,api:"responses" as const,toolUse:true,streaming:true,imageInput:true,structuredOutputs:false,promptCaching:false,contextWindow:272000,maxOutput:272000};
const withCodex:Config={...cfg,stack:[
 {alias:"codex",modelId:"gpt-5.6-sol",vendor:"openai",enabled:true,inputPerM:0,outputPerM:0,serves:["execute","explore"],auth:{kind:"oauth-file",path:codexAuthFile},capabilities:codexCap},
 ...cfg.stack]};

test("a free rung sorts first, streams through the Responses transport, and is tallied in tokens not dollars",async()=>{
 codex.mode="ok";codex.calls.length=0;
 await run(withCodex,async()=>reply,async base=>{
  const r=await fetch(base+"/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"auto",stream:true,max_tokens:4096,messages:[{role:"system",content:"be terse"},{role:"user",content:"implement it"}],tools:[{type:"function",function:{name:"do_it",description:"d",parameters:{type:"object",properties:{}}}}]})});
  assert.equal(r.status,200);
  assert.equal(r.headers.get("x-bedrouter-provider"),"codex");
  const body=await r.text();
  const chunks=body.split("\n\n").filter(l=>l.startsWith("data: ")&&!l.includes("[DONE]")).map(l=>JSON.parse(l.slice(6)));
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls[0].function,{name:"do_it",arguments:""});
  assert.equal(chunks.at(-1).usage.prompt_tokens,70);

  // The endpoint answers 400 for max_output_tokens, so the cap is dropped rather than clamped, and the log says so.
  assert.equal(JSON.stringify(codex.calls[0]).includes("max_tokens"),false);
  assert.equal(codex.calls[0].instructions,"be terse");
  assert.equal(codex.calls[0].stream,true);
  const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);
  assert.equal(log.provider,"codex");
  assert.equal(log.costUsd,0,"a prepaid rung bills nothing");
  assert.equal(log.inputTokens,70,"and still spends an allocation, which is why tokens are recorded");
  assert.ok(log.degraded.includes("codex:drop-maxTokens"));
  assert.equal(log.quotaPercent,3);
 });
});

test("a client that did not ask for a stream still gets one assembled answer",async()=>{
 codex.mode="ok";codex.calls.length=0;
 await run(withCodex,async()=>reply,async base=>{
  const {r,json}=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}],tools:[{type:"function",function:{name:"do_it",description:"d",parameters:{type:"object",properties:{}}}}]});
  assert.equal(r.status,200);
  assert.equal(json.object,"chat.completion");
  assert.deepEqual(json.choices[0].message.tool_calls,[{id:"call_1",type:"function",function:{name:"do_it",arguments:'{"a":1}'}}]);
  assert.equal(json.choices[0].finish_reason,"tool_calls");
  // The endpoint refuses stream:false, so bedrouter asked for a stream anyway and folded it.
  assert.equal(codex.calls[0].stream,true);
 });
});

test("a spent allocation stands the rung down before the next request, and Bedrock answers instead",async()=>{
 codex.mode="spent";codex.calls.length=0;
 const picked:string[]=[];
 await run(withCodex,async c=>{picked.push(c.input.modelId);return reply},async base=>{
  const first=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]});
  assert.equal(first.r.status,200);
  assert.equal(codex.calls.length,1,"the first request is served by the free rung");
  // 97% of the window is past the stand-down threshold, so the rung is out until it resets.
  const second=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement something else"}]});
  assert.equal(second.r.status,200);
  assert.equal(codex.calls.length,1,"the second request never reaches the spent rung");
  assert.deepEqual(picked,["w"],"it falls to the cheapest eligible Bedrock rung");
  const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);
  assert.equal(log.provider,"bedrock");
  assert.ok(log.skipped.some((s:string)=>s.startsWith("codex:unavailable")));
 });
});

test("a 429 reroutes the same request to Bedrock, and a dead token does too",async()=>{
 for(const mode of ["quota","dead"] as const){
  codex.mode=mode;codex.calls.length=0;
  const picked:string[]=[];
  await run(withCodex,async c=>{picked.push(c.input.modelId);return reply},async base=>{
   const out=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]});
   assert.equal(out.r.status,200,`${mode} must not reach the client`);
   assert.deepEqual(picked,["w"],`${mode} falls through to Bedrock inside the same request`);
  });
 }
});

test("an expired Codex token takes the rung out without touching the endpoint",async()=>{
 const stale=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"bedrouter-stale-")),"auth.json");
 fs.writeFileSync(stale,JSON.stringify({tokens:{access_token:jwt(Math.floor(Date.now()/1000)-10),account_id:"a"}}));
 codex.mode="ok";codex.calls.length=0;
 const stackWithStale:Config={...withCodex,stack:[{...withCodex.stack[0],auth:{kind:"oauth-file",path:stale}},...cfg.stack]};
 await run(stackWithStale,async()=>reply,async base=>{
  assert.equal((await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]})).r.status,200);
  assert.equal(codex.calls.length,0,"an expired token is detected locally, so no request is sent");
 });
});
