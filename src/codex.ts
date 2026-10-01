// OpenAI chat-completions shape <-> OpenAI Responses shape, plus the Codex transport.
//
// Every claim encoded here was verified against the live endpoint on 2026-09-16; see the "Spike results" section of
// TODO/LOCAL-CODEX.md. Three of them shape this file:
//   - `stream: false` is refused, so the transport always streams and a non-streaming request is assembled from it.
//   - `max_output_tokens` is refused, so a client's cap is dropped rather than clamped.
//   - the allocation is reported on every response, so a rung stands down before exhaustion rather than after a 429.
//
// The translation half is pure and unit tested. The transport half is plain `fetch`, so the single-runtime-dep rule holds.
import fs from "node:fs";
import os from "node:os";
import { finishReason, toError } from "./translate.js";
import type { Rung, Usage } from "./config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// ponytail: one provider speaks this transport, so its endpoint is a constant with an environment override for
// tests. Move it onto the rung when a second provider needs a different one.
const CODEX_ENDPOINT = process.env.BEDROUTER_CODEX_ENDPOINT ?? "https://chatgpt.com/backend-api/codex/responses";
const CLIENT_VERSION = "0.154.0";

// --- credentials ------------------------------------------------------------------------------------------------

export type Auth = { kind: "aws-default-chain" } | { kind: "oauth-file"; path?: string };
export type CodexCredential = { token: string; accountId: string; expiresAt: number };

const claims = (jwt: string): Json => { try { return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; } };

/**
 * Read the credential the `codex` CLI already maintains. bedrouter never mints, refreshes or stores a token of its
 * own, and implements no login flow: when the file is missing or its token has expired, the caller is told to run
 * `codex login`, exactly as preflight.ts reports an expired SSO session.
 *
 * ponytail: re-reading the file is the whole refresh strategy. The access token lasts 240 hours and the Codex CLI
 * rewrites the file when it refreshes, so bedrouter picks the new one up for free. Implement the OAuth refresh only
 * if a machine turns out to run bedrouter without ever running codex.
 */
export function readCodexCredential(file = "~/.codex/auth.json"): CodexCredential | { error: string } {
  const path = file.replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(path)) return { error: `no Codex credential at ${file}. Run \`codex login\`.` };
  let auth: Json;
  try { auth = JSON.parse(fs.readFileSync(path, "utf8")); }
  catch (err) { return { error: `${file} is not readable JSON: ${(err as Error).message}` }; }
  const token = auth?.tokens?.access_token;
  if (!token) return { error: `${file} has no tokens.access_token. Run \`codex login\`.` };
  const exp = Number(claims(token).exp ?? 0) * 1000;
  if (exp && exp < Date.now()) return { error: `the Codex token in ${file} expired on ${new Date(exp).toISOString()}. Run \`codex login\`.` };
  return { token, accountId: auth?.tokens?.account_id ?? "", expiresAt: exp };
}

// --- request translation ----------------------------------------------------------------------------------------

const textOf = (content: Json): string =>
  content == null ? "" : typeof content === "string" ? content
    : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("") : "";

/**
 * Chat-completions request -> Responses request. Only fields the endpoint was observed to accept are sent: it
 * answers 400 for an unknown parameter, so passing a sampling knob through on a guess would fail the whole request.
 */
export function openaiToResponses(body: Json, modelId: string): Json {
  const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
  const instructions: string[] = [];
  const input: Json[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") { const t = textOf(m.content); if (t) instructions.push(t); continue; }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const c of m.tool_calls ?? []) {
        input.push({ type: "function_call", name: c.function?.name, arguments: c.function?.arguments ?? "{}", call_id: c.id });
      }
      continue;
    }
    // user, and anything else a client invents, is a user turn
    const parts: Json[] = [];
    const content = m.content;
    if (typeof content === "string" || content == null) { if (textOf(content)) parts.push({ type: "input_text", text: textOf(content) }); }
    else for (const p of content) {
      if (p?.type === "text" && p.text) parts.push({ type: "input_text", text: p.text });
      else if (p?.type === "image_url" && p.image_url?.url) parts.push({ type: "input_image", image_url: p.image_url.url });
    }
    if (parts.length) input.push({ type: "message", role: "user", content: parts });
  }

  const out: Json = { model: modelId, input, stream: true, store: false };
  if (instructions.length) out.instructions = instructions.join("\n");
  const tools = (body.tools ?? []).filter((t: Json) => t?.type === "function" && t.function?.name)
    .map((t: Json) => ({ type: "function", name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } }));
  if (tools.length) {
    out.tools = tools;
    if (body.tool_choice) out.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice
      : body.tool_choice?.function?.name ? { type: "function", name: body.tool_choice.function.name } : "auto";
    if (body.parallel_tool_calls != null) out.parallel_tool_calls = !!body.parallel_tool_calls;
  }
  // max_tokens / max_completion_tokens are deliberately absent: the endpoint answers 400 for max_output_tokens, so
  // the client's ceiling cannot be expressed here at all. server.ts records the drop as a degradation.
  return out;
}

// --- response translation ---------------------------------------------------------------------------------------

export type ResponsesState = {
  id: string; model: string; created: number;
  toolIndex: Map<string, number>; // Responses item id -> openai tool_calls index
  sawTool: boolean;
  stopReason?: string;
  usage?: Usage;
};

export const newResponsesState = (model: string, id: string): ResponsesState =>
  ({ id, model, created: Math.floor(Date.now() / 1000), toolIndex: new Map(), sawTool: false });

const usageToOpenai = (u?: Usage) => ({ prompt_tokens: u?.input ?? 0, completion_tokens: u?.output ?? 0, total_tokens: (u?.input ?? 0) + (u?.output ?? 0) });

/** Responses usage -> the shape estimateCost and the log already speak. */
export function responsesUsage(u: Json): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u?.input_tokens_details?.cache_write_tokens ?? 0,
  };
}

/** Translate one Responses SSE event into zero or more chat.completion.chunk objects. Mirrors converseEventToOpenai. */
export function responsesEventToOpenai(st: ResponsesState, ev: Json): Json[] {
  const chunk = (delta: Json, finish: string | null = null, extra: Json = {}) => ({
    id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  });

  switch (ev?.type) {
    case "response.created":
      return [chunk({ role: "assistant", content: "" })];

    case "response.output_item.added": {
      if (ev.item?.type !== "function_call") return [];
      const index = st.toolIndex.size;
      st.toolIndex.set(ev.item.id, index);
      st.sawTool = true;
      return [chunk({ tool_calls: [{ index, id: ev.item.call_id ?? ev.item.id, type: "function", function: { name: ev.item.name, arguments: "" } }] })];
    }

    case "response.function_call_arguments.delta": {
      const index = st.toolIndex.get(ev.item_id) ?? 0;
      return [chunk({ tool_calls: [{ index, function: { arguments: ev.delta ?? "" } }] })];
    }

    case "response.output_text.delta":
      return ev.delta ? [chunk({ content: ev.delta })] : [];

    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      return ev.delta ? [chunk({ reasoning_content: ev.delta })] : [];

    case "response.completed":
    case "response.incomplete": {
      st.usage = responsesUsage(ev.response?.usage);
      // The endpoint reports no Converse-style stop reason, so it is derived: a turn that emitted a tool call ended
      // to call it, and a truncated turn says so in incomplete_details.
      const truncated = ev.response?.incomplete_details?.reason === "max_output_tokens";
      st.stopReason = truncated ? "max_tokens" : st.sawTool ? "tool_use" : "end_turn";
      return [
        chunk({}, finishReason(st.stopReason)),
        { id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model, choices: [], usage: usageToOpenai(st.usage) },
      ];
    }

    case "response.failed":
      throw toError(ev.response?.error ?? { message: "the Codex response failed" });
    case "error":
      throw toError(ev.error ?? ev);

    default:
      return [];
  }
}

/** Fold chunks back into one chat.completion, for a client that did not ask for a stream. */
export function collectChunks(chunks: Json[], st: ResponsesState): Json {
  let content = "", reasoning = "";
  const tools: Json[] = [];
  let finish: string | null = null;
  for (const c of chunks) {
    const choice = c.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const t of d.tool_calls ?? []) {
      const at = (tools[t.index] ??= { id: t.id, type: "function", function: { name: "", arguments: "" } });
      if (t.id) at.id = t.id;
      if (t.function?.name) at.function.name = t.function.name;
      if (t.function?.arguments) at.function.arguments += t.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const message: Json = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.length) message.tool_calls = tools.filter(Boolean);
  return {
    id: st.id, object: "chat.completion", created: st.created, model: st.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usageToOpenai(st.usage),
  };
}

// --- quota ------------------------------------------------------------------------------------------------------

export type Quota = { usedPercent: number; resetAfterS: number; window: "primary" | "secondary"; plan: string };

/**
 * The allocation state carried on every response. Reading it lets a rung be stood down before it is exhausted, so a
 * user never eats the failed request a 429 would otherwise cause. The worst window wins.
 */
export function quotaFrom(headers: { get(name: string): string | null }): Quota | null {
  const num = (n: string) => { const v = headers.get(n); return v == null || v === "" ? null : Number(v); };
  const plan = headers.get("x-codex-plan-type") ?? "";
  const windows = (["primary", "secondary"] as const)
    .map((w) => ({ window: w, usedPercent: num(`x-codex-${w}-used-percent`), resetAfterS: num(`x-codex-${w}-reset-after-seconds`) ?? 0 }))
    .filter((x): x is Quota & { usedPercent: number } => x.usedPercent != null && Number.isFinite(x.usedPercent))
    .map((x) => ({ ...x, plan }));
  if (!windows.length) return null;
  return windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

// --- errors -----------------------------------------------------------------------------------------------------

export type CodexFault = { kind: "rung-fatal" | "quota" | "capability"; message: string; untilMs: number };

/**
 * The endpoint speaks two error shapes: `{"detail": "..."}` for a parameter or model problem, and
 * `{"error": {message, code}}` for authentication. Both are mapped onto the three verdicts the router already acts on.
 */
export function classifyCodexError(status: number, body: string, headers?: { get(name: string): string | null }): CodexFault {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.detail ?? parsed?.error?.message ?? detail;
  } catch { /* the body is not JSON; the raw prefix is the best available message */ }

  if (status === 401 || status === 403) {
    // The credential is dead, not the account's entitlement. A refreshed token makes the rung usable again, so this
    // is not permanent: a short stand-down lets `codex login` take effect without a bedrouter restart.
    return { kind: "rung-fatal", message: detail, untilMs: Date.now() + 5 * 60_000 };
  }
  if (status === 429) {
    const retryAfter = Number(headers?.get("retry-after") ?? 0);
    const quota = headers ? quotaFrom(headers) : null;
    const seconds = retryAfter || quota?.resetAfterS || 300;
    return { kind: "quota", message: detail, untilMs: Date.now() + seconds * 1000 };
  }
  // 400 for an unsupported model id is a fact about this account, not about the request.
  if (status === 400 && /model is not supported|not supported when using Codex/i.test(detail)) {
    return { kind: "rung-fatal", message: detail, untilMs: Infinity };
  }
  return { kind: "capability", message: detail, untilMs: 0 };
}

export class CodexError extends Error {
  constructor(public fault: CodexFault, public status: number) { super(`Codex ${status}: ${fault.message}`); this.name = "CodexError"; }
}

// --- transport --------------------------------------------------------------------------------------------------

export type CodexTurn = { events: AsyncGenerator<Json>; quota: Quota | null };

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try { yield JSON.parse(raw); } catch { /* a keep-alive or a partial frame */ }
      }
    }
  }
}

/** One turn against the Codex endpoint. Always streams, because the endpoint refuses anything else. */
export async function sendCodex(rung: Rung, body: Json, signal?: AbortSignal, credentialFile?: string): Promise<CodexTurn> {
  const cred = readCodexCredential(credentialFile ?? (rung.auth?.kind === "oauth-file" ? rung.auth.path : undefined) ?? "~/.codex/auth.json");
  if ("error" in cred) throw new CodexError({ kind: "rung-fatal", message: cred.error, untilMs: Date.now() + 5 * 60_000 }, 401);

  const res = await fetch(CODEX_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${cred.token}`,
      ...(cred.accountId ? { "chatgpt-account-id": cred.accountId } : {}),
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: "codex_cli_rs",
      version: CLIENT_VERSION,
      "openai-beta": "responses=experimental",
    },
    body: JSON.stringify(openaiToResponses(body, rung.modelId)),
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "";
    throw new CodexError(classifyCodexError(res.status, text, res.headers), res.status);
  }
  return { events: parseSse(res.body), quota: quotaFrom(res.headers) };
}
