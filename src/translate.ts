// OpenAI chat-completions shape <-> Bedrock Converse shape. Pure functions, no I/O.
import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamOutput,
  Message,
  SystemContentBlock,
  ToolConfiguration,
  TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const IMAGE_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);

function contentParts(content: Json): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const out: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) out.push({ text: part.text });
    } else if (part.type === "image_url") {
      const m = /^data:image\/(\w+);base64,(.+)$/s.exec(part.image_url?.url ?? "");
      if (!m) throw new ClientError("only data: URL images are supported (Bedrock cannot fetch URLs)");
      const format = m[1] === "jpg" ? "jpeg" : m[1];
      if (!IMAGE_FORMATS.has(format)) throw new ClientError(`unsupported image format ${m[1]}`);
      out.push({ image: { format: format as "png", source: { bytes: Buffer.from(m[2], "base64") } } });
    } else {
      throw new ClientError(`unsupported content part type "${part.type}"`);
    }
  }
  return out;
}

function toolResultText(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("");
  return JSON.stringify(content);
}

export class ClientError extends Error {}

/** SDK event-stream exception members are typed as Errors but deserialise as plain objects in some paths. */
export const toError = (e: Json): Error => (e instanceof Error ? e : Object.assign(new Error(e?.message ?? String(e)), e));

export function openaiToConverse(body: Json, modelId: string): ConverseCommandInput {
  const system: SystemContentBlock[] = [];
  const messages: Message[] = [];
  const push = (role: "user" | "assistant", content: ContentBlock[]) => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    // Converse requires strictly alternating roles; merge consecutive same-role turns
    // (this is also how several tool results land in one user turn).
    if (last?.role === role) last.content!.push(...content);
    else messages.push({ role, content });
  };

  for (const m of body.messages ?? []) {
    switch (m.role) {
      case "system":
      case "developer": {
        const text = typeof m.content === "string" ? m.content : contentParts(m.content).map((p) => p.text ?? "").join("");
        if (text) system.push({ text });
        break;
      }
      case "user":
        push("user", contentParts(m.content));
        break;
      case "assistant": {
        const blocks = contentParts(m.content);
        for (const tc of m.tool_calls ?? []) {
          let input: Json = {};
          try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = { _raw: tc.function.arguments }; }
          blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function?.name, input } });
        }
        push("assistant", blocks);
        break;
      }
      case "tool":
        push("user", [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: toolResultText(m.content) }] } }]);
        break;
      default:
        throw new ClientError(`unsupported message role "${m.role}"`);
    }
  }

  const input: ConverseCommandInput = { modelId, messages };
  if (system.length) input.system = system;

  const inf: NonNullable<ConverseCommandInput["inferenceConfig"]> = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) inf.maxTokens = maxTokens;
  if (body.temperature != null) inf.temperature = body.temperature;
  if (body.top_p != null) inf.topP = body.top_p;
  if (body.stop != null) inf.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(inf).length) input.inferenceConfig = inf;

  const tools = (body.tools ?? []).filter((t: Json) => t.type === "function");
  if (tools.length && body.tool_choice !== "none") {
    const toolConfig: ToolConfiguration = {
      tools: tools.map((t: Json) => ({
        toolSpec: { name: t.function.name, description: t.function.description, inputSchema: { json: t.function.parameters ?? { type: "object", properties: {} } } },
      })),
    };
    const tc = body.tool_choice;
    if (tc === "required") toolConfig.toolChoice = { any: {} };
    else if (tc?.type === "function") toolConfig.toolChoice = { tool: { name: tc.function.name } };
    input.toolConfig = toolConfig;
  }
  return input;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  content_filtered: "content_filter",
  guardrail_intervened: "content_filter",
};

export const finishReason = (stop?: string) => (stop ? FINISH[stop] ?? stop : null);

export function usageToOpenai(u?: TokenUsage) {
  const prompt = u?.inputTokens ?? 0;
  const completion = u?.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function converseToOpenai(out: ConverseCommandOutput, model: string, id: string) {
  const blocks = out.output?.message?.content ?? [];
  const text = blocks.map((b) => b.text ?? "").join("");
  const reasoning = blocks.map((b) => b.reasoningContent?.reasoningText?.text ?? "").join("");
  const tool_calls = blocks
    .filter((b) => b.toolUse)
    .map((b) => ({ id: b.toolUse!.toolUseId, type: "function", function: { name: b.toolUse!.name, arguments: JSON.stringify(b.toolUse!.input ?? {}) } }));
  const message: Json = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tool_calls.length) message.tool_calls = tool_calls;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(out.stopReason) }],
    usage: usageToOpenai(out.usage),
  };
}

export type StreamState = {
  id: string;
  model: string;
  created: number;
  toolIndex: Map<number, number>; // converse contentBlockIndex -> openai tool_calls index
  stopReason?: string;
  usage?: TokenUsage;
};

export const newStreamState = (model: string, id: string): StreamState => ({
  id, model, created: Math.floor(Date.now() / 1000), toolIndex: new Map(),
});

/** Translate one ConverseStream event into zero or more chat.completion.chunk objects. Throws on stream exceptions. */
export function converseEventToOpenai(st: StreamState, ev: ConverseStreamOutput): Json[] {
  const chunk = (delta: Json, finish: string | null = null, extra: Json = {}) => ({
    id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  });

  if (ev.messageStart) return [chunk({ role: "assistant", content: "" })];
  if (ev.contentBlockStart) {
    const tu = ev.contentBlockStart.start?.toolUse;
    if (!tu) return [];
    const index = st.toolIndex.size;
    st.toolIndex.set(ev.contentBlockStart.contentBlockIndex!, index);
    return [chunk({ tool_calls: [{ index, id: tu.toolUseId, type: "function", function: { name: tu.name, arguments: "" } }] })];
  }
  if (ev.contentBlockDelta) {
    const d = ev.contentBlockDelta.delta;
    if (d?.text) return [chunk({ content: d.text })];
    if (d?.toolUse) {
      const index = st.toolIndex.get(ev.contentBlockDelta.contentBlockIndex!) ?? 0;
      return [chunk({ tool_calls: [{ index, function: { arguments: d.toolUse.input ?? "" } }] })];
    }
    if (d?.reasoningContent?.text) return [chunk({ reasoning_content: d.reasoningContent.text })];
    return [];
  }
  if (ev.messageStop) {
    st.stopReason = ev.messageStop.stopReason;
    return [chunk({}, finishReason(st.stopReason))];
  }
  if (ev.metadata) {
    st.usage = ev.metadata.usage;
    return [{ id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model, choices: [], usage: usageToOpenai(st.usage) }];
  }
  if (ev.contentBlockStop) return [];
  // remaining union members are exceptions
  const err = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.validationException ?? ev.throttlingException ?? ev.serviceUnavailableException;
  if (err) throw toError(err);
  return [];
}
