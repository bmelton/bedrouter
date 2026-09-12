import { test } from "node:test";
import assert from "node:assert/strict";
import { converseEventToOpenai, converseToOpenai, converseToolName, newStreamState, openaiToConverse, toolNameMap } from "../src/translate.js";

test("openaiToConverse: system, tools, tool calls and tool results", () => {
  const input = openaiToConverse(
    {
      model: "gpt-oss",
      max_tokens: 100,
      temperature: 0.2,
      stop: "END",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "weather in SF?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"SF"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        { role: "tool", tool_call_id: "call_1", content: "warm" },
        { role: "user", content: [{ type: "text", text: "thanks" }] },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      tool_choice: "required",
    },
    "openai.gpt-oss-120b-1:0",
  );
  assert.equal(input.modelId, "openai.gpt-oss-120b-1:0");
  assert.deepEqual(input.system, [{ text: "be terse" }]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 100, temperature: 0.2, stopSequences: ["END"] });
  assert.deepEqual(input.messages!.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(input.messages![1].content, [{ toolUse: { toolUseId: "call_1", name: "weather", input: { city: "SF" } } }]);
  // two tool results + following user text merge into one alternating user turn
  assert.deepEqual(input.messages![2].content, [
    { toolResult: { toolUseId: "call_1", content: [{ text: "sunny" }] } },
    { toolResult: { toolUseId: "call_1", content: [{ text: "warm" }] } },
    { text: "thanks" },
  ]);
  assert.equal(input.toolConfig!.tools![0].toolSpec!.name, "weather");
  assert.deepEqual(input.toolConfig!.toolChoice, { any: {} });
});

test("openaiToConverse: tool_choice none drops toolConfig, data-url image is decoded", () => {
  const png = Buffer.from("fakepng").toString("base64");
  const input = openaiToConverse(
    {
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }],
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      tool_choice: "none",
    },
    "m",
  );
  assert.equal(input.toolConfig, undefined);
  const img = input.messages![0].content![1].image!;
  assert.equal(img.format, "png");
  assert.equal(Buffer.from(img.source!.bytes as Uint8Array).toString(), "fakepng");
  assert.throws(() => openaiToConverse({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }, "m"), /data: URL/);
});

test("converseToOpenai: text + tool use -> tool_calls with JSON string arguments", () => {
  const out = converseToOpenai(
    {
      output: { message: { role: "assistant", content: [{ text: "checking" }, { toolUse: { toolUseId: "tu1", name: "weather", input: { city: "SF" } } }] } },
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metrics: { latencyMs: 1 },
      $metadata: {},
    },
    "gpt-oss",
    "chatcmpl-x",
  );
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(out.choices[0].message.content, "checking");
  assert.deepEqual(out.choices[0].message.tool_calls, [{ id: "tu1", type: "function", function: { name: "weather", arguments: '{"city":"SF"}' } }]);
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(out.model, "gpt-oss");
});

test("converseEventToOpenai: streaming assembly of text, tool call args, finish and usage", () => {
  const st = newStreamState("gpt-oss", "chatcmpl-s");
  const events = [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu1", name: "weather" } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"ci' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'ty":"SF"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tu2", name: "time" } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: "{}" } } } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, metrics: { latencyMs: 1 } } },
  ] as const;
  const chunks = events.flatMap((ev) => converseEventToOpenai(st, ev as never));

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  assert.equal(text, "Hello");

  const args: Record<number, string> = {};
  const names: Record<number, string> = {};
  for (const c of chunks) for (const tc of c.choices[0]?.delta?.tool_calls ?? []) {
    if (tc.function?.name) names[tc.index] = tc.function.name;
    args[tc.index] = (args[tc.index] ?? "") + (tc.function?.arguments ?? "");
  }
  assert.deepEqual(names, { 0: "weather", 1: "time" });
  assert.deepEqual(JSON.parse(args[0]), { city: "SF" });
  assert.deepEqual(JSON.parse(args[1]), {});

  const finish = chunks.find((c) => c.choices[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, "tool_calls");
  const last = chunks[chunks.length - 1];
  assert.deepEqual(last.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.deepEqual(last.choices, []);
  for (const c of chunks) { assert.equal(c.id, "chatcmpl-s"); assert.equal(c.object, "chat.completion.chunk"); }
  assert.equal(st.stopReason, "tool_use");
  assert.throws(() => converseEventToOpenai(st, { throttlingException: { name: "ThrottlingException", message: "slow down", $fault: "client", $metadata: {} } } as never), /slow down/);
});

test("tool names are made Converse-safe in history, definitions and tool_choice, and mapped back in responses", async () => {
  const body = {
    model: "gpt-oss-20b",
    tools: [{ type: "function", function: { name: "web.search", parameters: {} } }, { type: "function", function: { name: "read_file", parameters: {} } }],
    tool_choice: { type: "function", function: { name: "web.search" } },
    messages: [
      { role: "user", content: "hi" },
      // a hallucinated call that no tool defines: Converse would reject "web_search.json" forever after
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search.json", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Tool web_search.json not found" },
    ],
  };
  const input = openaiToConverse(body, "m");
  assert.deepEqual(input.toolConfig!.tools!.map((t: any) => t.toolSpec.name), ["web_search", "read_file"]);
  assert.deepEqual(input.toolConfig!.toolChoice, { tool: { name: "web_search" } });
  const assistant = input.messages!.find((m) => m.role === "assistant")!;
  assert.equal((assistant.content![0] as any).toolUse.name, "web_search_json");
  for (const name of ["web_search", "read_file", "web_search_json"]) assert.match(name, /^[a-zA-Z0-9_-]+$/);
  assert.equal(converseToolName("x".repeat(80)).length, 64);
  assert.equal(converseToolName(""), "tool");
  // responses carry the client's original name for defined tools
  const names = toolNameMap(body);
  assert.deepEqual([...names], [["web_search", "web.search"]]);
  const out: any = { output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "web_search", input: { q: 1 } } }] } }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
  assert.equal(converseToOpenai(out, "gpt-oss-20b", "id", names).choices[0].message.tool_calls[0].function.name, "web.search");
  const st = newStreamState("gpt-oss-20b", "id", names);
  const chunks = converseEventToOpenai(st, { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t1", name: "web_search" } } } } as any);
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "web.search");
});
