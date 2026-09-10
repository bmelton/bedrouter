// Server-level routing tests against a fake Bedrock client. No live calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.js";

process.env.BEDROUTER_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bedrouter-")), "log.jsonl");
const { createServer } = await import("../src/server.js");

const cfg: Config = {
  families: {
    anthropic: [
      { alias: "haiku", bedrockId: "h", inputPerM: 1, outputPerM: 5 },
      { alias: "sonnet", bedrockId: "s", inputPerM: 2, outputPerM: 10 },
      { alias: "opus", bedrockId: "o", inputPerM: 5, outputPerM: 25 },
    ],
    openai: [{ alias: "gpt-oss-20b", bedrockId: "g20", inputPerM: 0.07, outputPerM: 0.2 }, { alias: "gpt-oss-120b", bedrockId: "g120", inputPerM: 0.15, outputPerM: 0.6 }],
  },
  aliases: { "claude-sonnet-5": "sonnet" },
  routing: { enabled: true, classes: { anthropic: { execute: "sonnet", explore: "opus" }, openai: { execute: "gpt-oss-20b", explore: "gpt-oss-120b" } }, keywords: { explore: ["design"], execute: ["implement"] } },
};

type Sent = { name: string; input: any };
function fakeClient(reply: (cmd: Sent) => any) {
  const sent: Sent[] = [];
  return { sent, send: async (cmd: any) => { const s = { name: cmd.constructor.name, input: cmd.input }; sent.push(s); return reply(s); } };
}
const anthropicReply = (stop = "end_turn", out = 5) => ({ body: Buffer.from(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: out } })) });
const converseReply = { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };

async function withServer(cfg: Config, client: any, fn: (post: (p: string, body: any, headers?: Record<string, string>) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const server = createServer(cfg, client);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(async (p, body, headers = {}) => {
      const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    });
  } finally { server.close(); }
}
async function lastLog(n = 1) {
  await new Promise((r) => setTimeout(r, 20)); // appendFile is async
  const lines = fs.readFileSync(process.env.BEDROUTER_LOG!, "utf8").trim().split("\n");
  return lines.slice(-n).map((l) => JSON.parse(l));
}
const req = (text: string) => ({ model: "claude-sonnet-5", max_tokens: 100, system: "S", messages: [{ role: "user", content: text }] });

test("router disabled: forwarded body and response are byte-identical to the requested model, log gains null routing fields", async () => {
  const client = fakeClient(() => anthropicReply());
  await withServer({ ...cfg, routing: { ...cfg.routing, enabled: false } }, client, async (post) => {
    const r = await post("/v1/messages", req("design the schema"));
    assert.equal(r.status, 200);
    assert.equal(r.json.content[0].text, "hi");
    assert.equal(client.sent[0].input.modelId, "s");
    assert.equal(client.sent[0].input.body, JSON.stringify({ max_tokens: 100, system: "S", messages: [{ role: "user", content: "design the schema" }], anthropic_version: "bedrock-2023-05-31" }));
    const [log] = await lastLog();
    assert.equal(log.bedrockId, "s");
    assert.deepEqual([log.class, log.classReason, log.conversationKey, log.requestedModel, log.routedModel, log.sticky, log.escalated, log.escalationReason], [null, "disabled", null, "sonnet", "sonnet", false, false, null]);
    assert.ok("clientModel" in log && "costUsd" in log && "stopReason" in log);
  });
});

test("router enabled: explore goes up a rung, header bypass, sticky, escalation on max_tokens logged and applied", async () => {
  let stop = "end_turn";
  const client = fakeClient(() => anthropicReply(stop));
  await withServer(cfg, client, async (post) => {
    await post("/v1/messages", req("design the schema"));
    assert.equal(client.sent[0].input.modelId, "o");
    let [log] = await lastLog();
    assert.deepEqual([log.class, log.classReason, log.requestedModel, log.routedModel, log.sticky, log.bedrockId], ["explore", "keyword:explore", "sonnet", "opus", false, "o"]);
    assert.equal(log.conversationKey.length, 16);

    await post("/v1/messages", req("design the schema"), { "x-bedrouter-class": "off" });
    assert.equal(client.sent[1].input.modelId, "s");
    [log] = await lastLog();
    assert.deepEqual([log.class, log.classReason, log.routedModel], [null, "header:off", "sonnet"]);

    await post("/v1/messages", req("implement the widget"), { "x-bedrouter-class": "explore" });
    assert.equal(client.sent[2].input.modelId, "o");
    assert.equal((await post("/v1/messages", req("x"), { "x-bedrouter-class": "nope" })).status, 400);

    // new conversation classified execute, then max_tokens escalates the next turn
    stop = "max_tokens";
    await post("/v1/messages", req("implement it"));
    assert.equal(client.sent[3].input.modelId, "s");
    [log] = await lastLog();
    assert.deepEqual([log.stopReason, log.escalated, log.escalationReason, log.sticky], ["max_tokens", true, "max_tokens", false]);
    stop = "end_turn";
    await post("/v1/messages", { ...req("implement it"), messages: [...req("implement it").messages, { role: "assistant", content: "..." }, { role: "user", content: "continue" }] });
    assert.equal(client.sent[4].input.modelId, "o");
    [log] = await lastLog();
    assert.deepEqual([log.routedModel, log.sticky, log.escalated, log.escalationReason], ["opus", true, false, null]);
  });
});

test("router on OpenAI shape: stays in the openai family, throttling escalates", async () => {
  let fail = false;
  const client = fakeClient(() => { if (fail) throw Object.assign(new Error("slow down"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }); return converseReply; });
  await withServer(cfg, client, async (post) => {
    const body = { model: "gpt-oss-20b", messages: [{ role: "system", content: "S" }, { role: "user", content: "implement the thing" }] };
    assert.equal((await post("/v1/chat/completions", body)).status, 200);
    assert.equal(client.sent[0].input.modelId, "g20");
    fail = true;
    assert.equal((await post("/v1/chat/completions", { ...body, messages: [...body.messages, { role: "assistant", content: "ok" }, { role: "user", content: "more" }] })).status, 429);
    let [log] = await lastLog();
    assert.deepEqual([log.escalated, log.escalationReason, log.error], [true, "bedrock:429", "slow down"]);
    fail = false;
    await post("/v1/chat/completions", { ...body, messages: [...body.messages, { role: "assistant", content: "ok" }, { role: "user", content: "even more" }] });
    assert.equal(client.sent[2].input.modelId, "g120");
    [log] = await lastLog();
    assert.deepEqual([log.family, log.routedModel, log.sticky], ["openai", "gpt-oss-120b", true]);
  });
});
