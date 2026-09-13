import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.js";
process.env.BEDROUTER_LOG=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"bedrouter-")),"log.jsonl");
const {createServer}=await import("../src/server.js");
const cap={transport:"bedrock-runtime" as const,api:"converse" as const,toolUse:true,streaming:true,imageInput:false,structuredOutputs:true,promptCaching:false,contextWindow:200000,maxOutput:64000};
const cfg:Config={stack:[
 {alias:"tiny",bedrockId:"t",vendor:"amazon",enabled:true,inputPerM:.1,outputPerM:.2,serves:["trivial"],capabilities:{...cap,promptCaching:true}},
 {alias:"work",bedrockId:"w",vendor:"openai",enabled:true,inputPerM:.2,outputPerM:.4,serves:["execute"],capabilities:cap},
 {alias:"deep",bedrockId:"d",vendor:"anthropic",enabled:true,inputPerM:1,outputPerM:5,serves:["execute","explore"],capabilities:{...cap,promptCaching:true,imageInput:true}}
],routing:{enabled:true,keywords:{explore:["design"],execute:["implement"]},classifier:{enabled:false}}};
const reply={output:{message:{role:"assistant",content:[{text:"hi"}]}},stopReason:"end_turn",usage:{inputTokens:10,outputTokens:5}};
const anthropic={body:Buffer.from(JSON.stringify({content:[{type:"text",text:"hi"}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:5}}))};
async function run(config:Config,send:(cmd:any)=>Promise<any>,fn:(base:string)=>Promise<void>){const server=createServer(config,{send});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;try{await fn(base)}finally{server.close()}}
const post=async(base:string,path:string,body:any)=>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return{r,json:await r.json()}};

test("messages remains a native path for pinned Anthropic rungs and refuses auto",async()=>{const sent:any[]=[];await run(cfg,async c=>{sent.push(c.input);return anthropic},async base=>{assert.equal((await post(base,"/v1/messages",{model:"deep",messages:[{role:"user",content:"hi"}],max_tokens:10})).r.status,200);assert.equal(sent[0].modelId,"d");assert.equal((await post(base,"/v1/messages",{model:"auto",messages:[{role:"user",content:"hi"}],max_tokens:10})).r.status,400)})});

test("auto uses chat/Converse, exposes stack metadata, and strips cache points only when needed",async()=>{const sent:any[]=[];await run(cfg,async c=>{sent.push(c.input);return reply},async base=>{const body={model:"auto",messages:[{role:"user",content:"implement it"},{cachePoint:{type:"default"}}]};const out=await post(base,"/v1/chat/completions",body);assert.equal(out.r.status,200);assert.equal(sent[0].modelId,"w");assert.doesNotMatch(JSON.stringify(sent[0]),/cachePoint/);const models=await(await fetch(base+"/v1/models")).json();const auto=models.data.find((m:any)=>m.id==="auto");assert.equal(auto.bedrouter.vendor,"openai");assert.deepEqual(auto.bedrouter.serves,["execute"]);assert.equal(auto.bedrouter.capabilities.maxOutput,64000)})});

test("a capability ValidationException re-picks inside the same request and records the contradiction",async()=>{const ids:string[]=[];await run(cfg,async c=>{ids.push(c.input.modelId);if(ids.length===1)throw Object.assign(new Error("tool use is not supported"),{name:"ValidationException",$metadata:{httpStatusCode:400}});return reply},async base=>{const out=await post(base,"/v1/chat/completions",{model:"auto",messages:[{role:"user",content:"implement it"}]});assert.equal(out.r.status,200);assert.deepEqual(ids,["w","d"]);const log=JSON.parse(fs.readFileSync(process.env.BEDROUTER_LOG!,"utf8").trim().split("\n").at(-1)!);assert.equal(log.vendor,"anthropic");assert.ok(log.skipped.some((x:string)=>x.includes("validation-contradiction")))})});
