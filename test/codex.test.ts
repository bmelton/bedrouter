import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexError, collectChunks, newResponsesState, openaiToResponses, quotaFrom, responsesEventToOpenai, responsesUsage,
} from "../src/codex.js";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

test("chat messages become a Responses input, with system text lifted into instructions", () => {
  const r = openaiToResponses({
    messages: [
      { role: "system", content: "You are terse." },
      { role: "developer", content: "Prefer tools." },
      { role: "user", content: "weather in Chattanooga?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Chattanooga"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"tempF":71}' },
    ],
    tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } }],
    tool_choice: "auto",
  }, "gpt-5.5");

  assert.equal(r.model, "gpt-5.5");
  assert.equal(r.instructions, "You are terse.\nPrefer tools.");
  assert.equal(r.stream, true, "the endpoint refuses stream:false, so the transport always streams");
  assert.deepEqual(r.input.map((i: { type: string }) => i.type), ["message", "function_call", "function_call_output"]);
  assert.deepEqual(r.input[0].content, [{ type: "input_text", text: "weather in Chattanooga?" }]);
  assert.deepEqual([r.input[1].name, r.input[1].call_id], ["get_weather", "call_1"]);
  assert.deepEqual([r.input[2].call_id, r.input[2].output], ["call_1", '{"tempF":71}']);
  // Responses flattens the tool definition: no nested `function` object, unlike chat completions.
  assert.deepEqual(r.tools, [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }]);
});

test("the output cap is never sent, because the endpoint answers 400 for it", () => {
  for (const body of [{ messages: [], max_tokens: 100 }, { messages: [], max_completion_tokens: 100 }]) {
    const r = openaiToResponses(body, "gpt-5.5");
    assert.equal(JSON.stringify(r).includes("max_tokens"), false);
    assert.equal(JSON.stringify(r).includes("max_output_tokens"), false);
  }
  // Nothing unverified is forwarded either: an unknown parameter fails the whole request.
  const r = openaiToResponses({ messages: [{ role: "user", content: "hi" }], temperature: 0.7, top_p: 0.4, seed: 1 }, "gpt-5.5");
  assert.deepEqual(Object.keys(r).sort(), ["input", "model", "store", "stream"]);
});

const stream = (events: unknown[]) => {
  const st = newResponsesState("auto", "chatcmpl-test");
  const chunks = events.flatMap((e) => responsesEventToOpenai(st, e));
  return { st, chunks };
};

test("a streamed tool call maps to OpenAI tool_calls deltas", () => {
  const { st, chunks } = stream([
    { type: "response.created" },
    { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "get_weather", call_id: "call_9" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Chattanooga"}' },
    { type: "response.output_item.done", item: {} },
    { type: "response.completed", response: { usage: { input_tokens: 156, output_tokens: 19 } } },
  ]);

  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, [{ index: 0, id: "call_9", type: "function", function: { name: "get_weather", arguments: "" } }]);
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.arguments, '{"city":');
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls", "a turn that called a tool ended in order to call it");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 156, completion_tokens: 19, total_tokens: 175 });
  assert.deepEqual(st.usage, { input: 156, output: 19, cacheRead: 0, cacheWrite: 0 });
});

test("two tool calls keep separate indices, and text maps to content", () => {
  const { chunks } = stream([
    { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", name: "one", call_id: "c1" } },
    { type: "response.output_item.added", item: { id: "fc_b", type: "function_call", name: "two", call_id: "c2" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_b", delta: "{}" },
    { type: "response.output_text.delta", delta: "hello" },
  ]);
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].index, 1);
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].index, 1, "an argument delta must land on its own call");
  assert.equal(chunks[3].choices[0].delta.content, "hello");
});

test("a truncated turn reports max_tokens, and a failure throws", () => {
  const { chunks } = stream([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: {} } }]);
  assert.equal(chunks[0].choices[0].finish_reason, "length");
  const st = newResponsesState("auto", "id");
  assert.throws(() => responsesEventToOpenai(st, { type: "response.failed", response: { error: { message: "upstream blew up" } } }), /upstream blew up/);
  assert.deepEqual(responsesEventToOpenai(st, { type: "response.output_item.added", item: { type: "reasoning" } }), [], "unknown items are ignored, not fatal");
});

test("chunks fold back into one completion for a client that did not ask for a stream", () => {
  const { st, chunks } = stream([
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "Hel" },
    { type: "response.output_text.delta", delta: "lo." },
    { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "get_weather", call_id: "call_9" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":"X"}' },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
  ]);
  const out = collectChunks(chunks, st);
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "Hello.");
  assert.deepEqual(out.choices[0].message.tool_calls, [{ id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"X"}' } }]);
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});

test("the allocation is read from the response, worst window first", () => {
  const q = quotaFrom(headers({
    "x-codex-plan-type": "plus",
    "x-codex-primary-used-percent": "0", "x-codex-primary-reset-after-seconds": "17944",
    "x-codex-secondary-used-percent": "15", "x-codex-secondary-reset-after-seconds": "350297",
  }));
  assert.deepEqual(q, { window: "secondary", usedPercent: 15, resetAfterS: 350297, plan: "plus" });
  assert.equal(quotaFrom(headers({})), null, "a provider that reports nothing must not look like a spent one");
  // 0% is a real reading and must not be mistaken for absent.
  assert.equal(quotaFrom(headers({ "x-codex-primary-used-percent": "0", "x-codex-primary-reset-after-seconds": "60" }))!.usedPercent, 0);
});

test("errors map onto the three verdicts the router already acts on", () => {
  const dead = classifyCodexError(401, JSON.stringify({ error: { message: "Could not parse your authentication token.", code: "unauthorized_unknown" } }));
  assert.equal(dead.kind, "rung-fatal");
  assert.ok(dead.untilMs > Date.now() && dead.untilMs < Date.now() + 10 * 60_000, "a dead token comes back after `codex login`, so the stand-down is short");

  const gone = classifyCodexError(400, JSON.stringify({ detail: "The 'x' model is not supported when using Codex with a ChatGPT account." }));
  assert.deepEqual([gone.kind, gone.untilMs], ["rung-fatal", Infinity], "an unusable model is a fact about the account, not a moment");

  const spent = classifyCodexError(429, "{}", headers({ "retry-after": "120" }));
  assert.equal(spent.kind, "quota");
  assert.ok(spent.untilMs > Date.now() + 110_000);
  // With no Retry-After, the allocation headers supply the reset time instead.
  assert.ok(classifyCodexError(429, "{}", headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "600" })).untilMs > Date.now() + 590_000);

  const param = classifyCodexError(400, JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }));
  assert.deepEqual([param.kind, param.message], ["capability", "Unsupported parameter: max_output_tokens"]);
  assert.equal(classifyCodexError(500, "not json at all").kind, "capability");
});

test("usage keeps the cache split the cost estimate expects", () => {
  assert.deepEqual(responsesUsage({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } }),
    { input: 100, output: 5, cacheRead: 40, cacheWrite: 10 });
  assert.deepEqual(responsesUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
