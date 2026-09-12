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

test("log carries the counterfactual cost at the requested model", async () => {
  const client = fakeClient(() => anthropicReply());
  const tcfg: Config = { ...cfg, routing: { ...cfg.routing!, classes: { ...cfg.routing!.classes, anthropic: { trivial: "haiku", execute: "sonnet", explore: "opus" } } } };
  await withServer(tcfg, client, async (post) => {
    const r = await post("/v1/messages", req("what is 2+2?"));
    assert.equal(r.status, 200);
    assert.equal(client.sent[0].input.modelId, "h");
    const [log] = await lastLog();
    // 10 in + 5 out: haiku 1/5 per M -> 0.000035; sonnet 2/10 per M -> 0.00007
    assert.deepEqual([log.class, log.requestedModel, log.routedModel], ["trivial", "sonnet", "haiku"]);
    assert.ok(Math.abs(log.costUsd - 0.000035) < 1e-9 && Math.abs(log.requestedCostUsd - 0.00007) < 1e-9);
  });
});

test("classifier model is consulted when the rules are undecided, its verdict routes the request, and its cost is logged", async () => {
  const client = fakeClient((c) => (c.name === "ConverseCommand" && c.input.system?.[0]?.text?.includes("route requests")
    ? { output: { message: { role: "assistant", content: [{ text: "explore: open-ended architecture question" }] } }, stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 8 } }
    : anthropicReply()));
  const ccfg: Config = { ...cfg, aliases: { auto: "auto:anthropic" }, routing: { ...cfg.routing!, classifier: { enabled: true, model: "haiku" } } };
  await withServer(ccfg, client, async (post) => {
    const r = await post("/v1/messages", { model: "auto", max_tokens: 100, system: "S", tools: [{ name: "t", input_schema: {} }], messages: [{ role: "user", content: "have a look at the thing" }] });
    assert.equal(r.status, 200);
    assert.deepEqual(client.sent.map((s) => s.name), ["ConverseCommand", "InvokeModelCommand"]);
    assert.equal(client.sent[1].input.modelId, "o");
    const [log] = await lastLog();
    assert.deepEqual([log.class, log.classReason, log.requestedModel, log.routedModel, log.classifierNote], ["explore", "classifier:explore", "sonnet", "opus", "open-ended architecture question"]);
    assert.ok(log.classifierMs >= 0 && log.classifierCostUsd > 0);
    // second turn in the same conversation: sticky, classifier not called again
    const r2 = await post("/v1/messages", { model: "auto", max_tokens: 100, system: "S", tools: [{ name: "t", input_schema: {} }], messages: [{ role: "user", content: "have a look at the thing" }, { role: "assistant", content: "hi" }, { role: "user", content: "and then?" }] });
    assert.equal(r2.status, 200);
    assert.equal(client.sent.length, 3);
    const [log2] = await lastLog();
    assert.deepEqual([log2.classReason, log2.routedModel, log2.classifierNote], ["sticky", "opus", null]);
  });
});

test("classifier failure leaves the rules' decision in place", async () => {
  const client = fakeClient((c) => { if (c.name === "ConverseCommand") throw Object.assign(new Error("boom"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }); return anthropicReply(); });
  const ccfg: Config = { ...cfg, aliases: { auto: "auto:anthropic" }, routing: { ...cfg.routing!, classifier: { enabled: true, model: "haiku" } } };
  await withServer(ccfg, client, async (post) => {
    const r = await post("/v1/messages", { model: "auto", max_tokens: 100, system: "S", tools: [{ name: "t", input_schema: {} }], messages: [{ role: "user", content: "have a look at the thing" }] });
    assert.equal(r.status, 200);
    const [log] = await lastLog();
    assert.deepEqual([log.classReason, log.routedModel], ["default", "sonnet"]);
    assert.match(log.classifierNote, /ThrottlingException/);
  });
});

test("decision headers on both paths, /health, /v1/models metadata and /v1/conversations tallies", async () => {
  const client = fakeClient((c) => (c.name === "ConverseCommand" ? converseReply : anthropicReply()));
  const tcfg: Config = { ...cfg, aliases: { ...cfg.aliases, "auto-oss": "auto:openai" } };
  await withServer(tcfg, client, async (post) => {
    const server = createServer(tcfg, client);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r1 = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req("design the schema")) });
      assert.equal(r1.headers.get("x-bedrouter-model"), "opus");
      assert.equal(r1.headers.get("x-bedrouter-requested"), "sonnet");
      assert.equal(r1.headers.get("x-bedrouter-class"), "explore");
      assert.equal(r1.headers.get("x-bedrouter-reason"), "keyword:explore");
      const key = r1.headers.get("x-bedrouter-conversation")!;
      assert.match(key, /^[0-9a-f]{16}$/);
      const r2 = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto-oss", stream: true, messages: [{ role: "user", content: "implement it" }] }) });
      await r2.text();
      assert.deepEqual([r2.headers.get("x-bedrouter-model"), r2.headers.get("x-bedrouter-class"), r2.headers.get("content-type")], ["gpt-oss-20b", "execute", "text/event-stream"]);
      const health = await (await fetch(base + "/health")).json();
      assert.ok(health.ok && health.pid === process.pid && typeof health.version === "string");
      const models = await (await fetch(base + "/v1/models")).json();
      const auto = models.data.find((m: any) => m.id === "auto-oss");
      assert.deepEqual(auto.bedrouter, { family: "openai", rung: "gpt-oss-20b", auto: true, inputPerM: 0.07, outputPerM: 0.2 });
      await new Promise((r) => setTimeout(r, 20));
      const conv = await (await fetch(base + `/v1/conversations/${key}`)).json();
      assert.deepEqual([conv.requests, conv.routedModel, conv.requestedModel, conv.class], [1, "opus", "sonnet", "explore"]);
      assert.ok(conv.costUsd > 0 && conv.requestedCostUsd > 0 && conv.requestedCostUsd < conv.costUsd);
      assert.equal((await fetch(base + "/v1/conversations/nope")).status, 404);
    } finally { server.close(); }
    void post;
  });
});
