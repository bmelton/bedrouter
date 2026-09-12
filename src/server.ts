import "./env.js"; // must run before anything reads process.env
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { estimateCost, loadConfig, modelTable, resolveModel, type Config, type Rung, type Usage } from "./config.js";
import { ClientError, converseEventToOpenai, converseToOpenai, newStreamState, openaiToConverse, toError } from "./translate.js";
import { Router, ToolJsonCheck, type Class, type Decision } from "./router.js";
import { describe, preflight } from "./preflight.js";
import { classifyWithModel } from "./classifier.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const VERSION: string = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; } })();
export const region = process.env.AWS_REGION ?? "us-east-1";
const LOG_PATH = process.env.BEDROUTER_LOG ?? "./bedrouter.log.jsonl";
// Debug mode: a human-readable line on stdout when a request arrives, when it is routed, and when it finishes.
export const DEBUG = /^(1|true|yes|on)$/i.test(process.env.BEDROUTER_DEBUG ?? "") || process.argv.includes("--debug");
const debug = (line: string) => { if (DEBUG) console.log(line); };
const hhmmss = () => new Date().toISOString().slice(11, 19);
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number | null | undefined) => (n == null ? "-" : `$${n.toFixed(n < 0.01 ? 5 : 4)}`);

// Decision-log line. Existing fields never change; the routing fields were appended by the router milestone.
export type LogEntry = {
  ts: string;
  endpoint: string;
  clientModel: string | null;
  bedrockId: string | null;
  family: string | null;
  stream: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  requestedCostUsd: number | null; // what the same usage would have cost on the model the client asked for
  stopReason: string | null;
  error: string | null;
  class: Class | null;
  classReason: string | null;
  conversationKey: string | null;
  requestedModel: string | null;
  routedModel: string | null;
  sticky: boolean;
  escalated: boolean;
  escalationReason: string | null;
  classifierNote: string | null; // the classifier model's one-line reason, or its error; null when it did not run
  classifierMs: number | null;
  classifierCostUsd: number | null;
};

/** Running totals per conversation, served on GET /v1/conversations/:key for UI integrations (pi-bedrouter's footer). */
export type ConversationStats = { key: string; requests: number; costUsd: number; requestedCostUsd: number; classifierCostUsd: number; inputTokens: number; outputTokens: number; escalations: number; class: Class | null; routedModel: string | null; requestedModel: string | null; lastTs: string };
// Per-request routing state shared between the handler and the finally block.
type RouteCtx = { decision?: Decision; requested?: Rung; tools: ToolJsonCheck };

function appendLog(entry: LogEntry) {
  // sync on purpose: one small line per request, and the line must survive a process exit right after the response
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch (err) { console.error("bedrouter: log write failed:", (err as Error).message); }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const anthropicErrorType = (status: number) =>
  ({ 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error", 529: "overloaded_error" } as Record<number, string>)[status] ?? "api_error";

function errorStatus(err: Json): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ClientError) return 400;
  return err?.$metadata?.httpStatusCode ?? 502;
}

function errorBody(err: Json, shape: "anthropic" | "openai") {
  const status = errorStatus(err);
  const message = `${err?.name && !(err instanceof HttpError) && !(err instanceof ClientError) ? err.name + ": " : ""}${err?.message ?? String(err)}`;
  return shape === "anthropic"
    ? { type: "error", error: { type: anthropicErrorType(status), message } }
    : { error: { message, type: anthropicErrorType(status), code: err?.name ?? null } };
}

function readJson(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new HttpError(400, "request body is not valid JSON")); }
    });
  });
}

/** The routing decision, echoed as response headers so clients (Pi's after_provider_response) can show it live. */
function decisionHeaders(log: LogEntry): Record<string, string> {
  const h: Record<string, string> = {};
  if (log.routedModel) h["x-bedrouter-model"] = log.routedModel;
  if (log.requestedModel) h["x-bedrouter-requested"] = log.requestedModel;
  if (log.bedrockId) h["x-bedrouter-bedrock-id"] = log.bedrockId;
  if (log.class) h["x-bedrouter-class"] = log.class;
  if (log.classReason) h["x-bedrouter-reason"] = log.classReason;
  if (log.conversationKey) h["x-bedrouter-conversation"] = log.conversationKey;
  if (log.classifierNote != null) h["x-bedrouter-classifier"] = log.classifierNote.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  return h;
}

function sendJson(res: http.ServerResponse, status: number, body: Json) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startSse(res: http.ServerResponse, extra: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...extra });
  res.flushHeaders();
}

function checkAuth(req: http.IncomingMessage) {
  const want = process.env.BEDROUTER_API_KEY;
  if (!want) return;
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const got = req.headers["x-api-key"] ?? bearer;
  if (got !== want) throw new HttpError(401, "invalid api key");
}

export function createServer(cfg: Config = loadConfig(), client: Pick<BedrockRuntimeClient, "send"> = new BedrockRuntimeClient({ region })): http.Server {
  const table = modelTable(cfg);
  const router = new Router(cfg);
  const conversations = new Map<string, ConversationStats>();
  const MAX_CONV_STATS = 2000;
  const tally = (log: LogEntry) => {
    if (!log.conversationKey) return;
    let c = conversations.get(log.conversationKey);
    if (!c) { c = { key: log.conversationKey, requests: 0, costUsd: 0, requestedCostUsd: 0, classifierCostUsd: 0, inputTokens: 0, outputTokens: 0, escalations: 0, class: null, routedModel: null, requestedModel: null, lastTs: log.ts }; }
    c.requests++; c.costUsd += log.costUsd ?? 0; c.requestedCostUsd += log.requestedCostUsd ?? log.costUsd ?? 0; c.classifierCostUsd += log.classifierCostUsd ?? 0;
    c.inputTokens += log.inputTokens ?? 0; c.outputTokens += log.outputTokens ?? 0; c.escalations += log.escalated ? 1 : 0;
    c.class = log.class; c.routedModel = log.routedModel; c.requestedModel = log.requestedModel; c.lastTs = log.ts;
    conversations.delete(log.conversationKey); conversations.set(log.conversationKey, c);
    if (conversations.size > MAX_CONV_STATS) conversations.delete(conversations.keys().next().value!);
  };
  const classifierRung = router.rc.classifier.enabled ? table.get(router.rc.classifier.model!) : undefined;
  if (router.rc.classifier.enabled && !classifierRung) throw new Error(`routing.classifier.model "${router.rc.classifier.model}" is not a known model`);
  const aliases = () => [...table.keys()];

  const resolve = (name: unknown): Rung => {
    const rung = resolveModel(table, name);
    if (!rung) throw new HttpError(404, `unknown model "${name}". Valid models: ${aliases().join(", ")}`);
    return rung;
  };

  /** Resolve the client's model, let the rules pick the rung within that family, and consult the classifier model when they were undecided. */
  const route = async (req: http.IncomingMessage, body: Json, log: LogEntry, rt: RouteCtx): Promise<Rung> => {
    const requested = resolve(body.model);
    const header = req.headers["x-bedrouter-class"];
    if (header !== undefined && !/^(trivial|execute|explore|off)$/.test(String(header))) throw new HttpError(400, `x-bedrouter-class must be trivial, execute, explore or off`);
    rt.requested = requested;
    let d = (rt.decision = router.route(body, requested, header as string | undefined));
    if (d.undecided && classifierRung) {
      const v = await classifyWithModel(client, classifierRung, body, router.rc.classifier);
      log.classifierNote = v.note;
      log.classifierMs = v.ms;
      log.classifierCostUsd = v.costUsd;
      if (v.class) d = rt.decision = router.reclassify(d, requested, v.class, `classifier:${v.class}`);
      // on error/unparseable the rules' decision stands; the note in the log says why
    }
    Object.assign(log, {
      clientModel: body.model, bedrockId: d.rung.bedrockId, family: d.rung.family, stream: !!body.stream,
      class: d.class, classReason: d.classReason, conversationKey: d.conversationKey, requestedModel: requested.alias, routedModel: d.rung.alias, sticky: d.sticky,
    });
    if (DEBUG) {
      const via = d.class ? `[${d.class} · ${d.classReason}]` : `[${d.classReason}]`;
      const note = log.classifierNote != null ? `  classifier: "${log.classifierNote}" ${log.classifierMs} ms ${usd(log.classifierCostUsd)}` : "";
      const arrow = d.rung.alias === requested.alias ? "=" : "≠";
      debug(`  routed  ${requested.alias}${requested.auto ? " (auto)" : ""} ${arrow}> ${d.rung.alias}  ${via}${d.escalationReason ? `  escalation:${d.escalationReason}` : ""}  conv=${d.conversationKey ?? "-"}${note}`);
      debug(`          ${d.rung.bedrockId}`);
    }
    return d.rung;
  };

  // --- POST /v1/messages: Anthropic Messages shape, native passthrough via InvokeModel -------------
  async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, body: Json, log: LogEntry, ac: AbortController, rt: RouteCtx) {
    const rung = await route(req, body, log, rt);
    if (rung.family !== "anthropic") {
      // ponytail: Anthropic-shape -> non-Anthropic model needs an Anthropic->Converse translator; add one when a
      // Claude Code user actually wants gpt-oss. Until then this is a clear 400, never a silent re-route.
      throw new HttpError(400, `model "${body.model}" is in the ${rung.family} family; only /v1/chat/completions can reach it`);
    }
    const { model: _m, stream, ...payload } = body;
    payload.anthropic_version ??= "bedrock-2023-05-31";
    const betas = String(req.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (betas.length) payload.anthropic_beta = [...new Set([...(payload.anthropic_beta ?? []), ...betas])];
    const cmd = { modelId: rung.bedrockId, contentType: "application/json", accept: "application/json", body: JSON.stringify(payload) };
    const usage: Usage = { input: 0, output: 0 };
    const takeUsage = (u: Json) => {
      if (!u) return;
      if (u.input_tokens != null) usage.input = u.input_tokens;
      if (u.output_tokens != null) usage.output = u.output_tokens;
      if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
    };

    if (!stream) {
      const out = await client.send(new InvokeModelCommand(cmd), { abortSignal: ac.signal });
      const msg = JSON.parse(Buffer.from(out.body).toString("utf8"));
      takeUsage(msg.usage);
      log.stopReason = msg.stop_reason ?? null;
      finishUsage(log, rung, usage, rt);
      for (const [k, v] of Object.entries(decisionHeaders(log))) res.setHeader(k, v);
      return sendJson(res, 200, msg);
    }

    const out = await client.send(new InvokeModelWithResponseStreamCommand(cmd), { abortSignal: ac.signal });
    startSse(res, decisionHeaders(log));
    for await (const ev of out.body ?? []) {
      if (!ev.chunk?.bytes) {
        const err = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.validationException ?? ev.throttlingException ?? ev.modelTimeoutException ?? ev.serviceUnavailableException;
        if (err) throw toError(err);
        continue;
      }
      const event = JSON.parse(Buffer.from(ev.chunk.bytes).toString("utf8"));
      delete event["amazon-bedrock-invocationMetrics"];
      if (event.type === "message_start") takeUsage(event.message?.usage);
      if (event.type === "message_delta") { takeUsage(event.usage); log.stopReason = event.delta?.stop_reason ?? log.stopReason; }
      if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") rt.tools.add(event.index, event.delta.partial_json ?? "");
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    finishUsage(log, rung, usage, rt);
    res.end();
  }

  // --- POST /v1/chat/completions: OpenAI shape, translated to Converse (any family) -----------------
  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, body: Json, log: LogEntry, ac: AbortController, rt: RouteCtx) {
    const rung = await route(req, body, log, rt);
    const input = openaiToConverse(body, rung.bedrockId);
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const usageOf = (u: Json): Usage => ({ input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens, cacheWrite: u?.cacheWriteInputTokens });

    if (!body.stream) {
      const out = await client.send(new ConverseCommand(input), { abortSignal: ac.signal });
      log.stopReason = out.stopReason ?? null;
      finishUsage(log, rung, usageOf(out.usage), rt);
      for (const [k, v] of Object.entries(decisionHeaders(log))) res.setHeader(k, v);
      return sendJson(res, 200, converseToOpenai(out, body.model, id));
    }

    const out = await client.send(new ConverseStreamCommand(input), { abortSignal: ac.signal });
    startSse(res, decisionHeaders(log));
    const st = newStreamState(body.model, id);
    for await (const ev of out.stream ?? []) {
      if (ev.contentBlockDelta?.delta?.toolUse) rt.tools.add(ev.contentBlockDelta.contentBlockIndex ?? 0, ev.contentBlockDelta.delta.toolUse.input ?? "");
      for (const chunk of converseEventToOpenai(st, ev)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    log.stopReason = st.stopReason ?? null;
    finishUsage(log, rung, usageOf(st.usage), rt);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  function finishUsage(log: LogEntry, rung: Rung, u: Usage, rt: RouteCtx) {
    log.inputTokens = u.input;
    log.outputTokens = u.output;
    log.cacheReadTokens = u.cacheRead ?? null;
    log.cacheWriteTokens = u.cacheWrite ?? null;
    log.costUsd = estimateCost(rung, u);
    // Counterfactual: same tokens priced at the requested rung. Output length would differ on another model, so this is
    // an estimate of what routing saved (or spent), not an invoice; the report sums it.
    log.requestedCostUsd = rt.requested ? estimateCost(rt.requested, u) : null;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const shape = url.pathname === "/v1/messages" ? "anthropic" : "openai";
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, region, pid: process.pid, version: VERSION, routing: router.rc.enabled, classifier: router.rc.classifier.enabled ? router.rc.classifier.model : null, uptimeS: Math.round(process.uptime()) });
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = [...table.entries()].map(([id, r]) => ({ id, object: "model", created: 0, owned_by: r.family, bedrock_id: r.bedrockId,
        bedrouter: { family: r.family, rung: r.alias, auto: !!r.auto, inputPerM: r.inputPerM, outputPerM: r.outputPerM } }));
      return sendJson(res, 200, { object: "list", data });
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/conversations/")) {
      const c = conversations.get(url.pathname.slice("/v1/conversations/".length));
      return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: { message: "unknown conversation" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/conversations") return sendJson(res, 200, { data: [...conversations.values()].slice(-50).reverse() });
    const handler = req.method === "POST" ? { "/v1/messages": handleMessages, "/v1/chat/completions": handleChat }[url.pathname] : undefined;
    if (!handler) return sendJson(res, 404, errorBody(new HttpError(404, `no route for ${req.method} ${url.pathname}`), shape));

    const started = Date.now();
    const log: LogEntry = {
      ts: new Date().toISOString(), endpoint: url.pathname, clientModel: null, bedrockId: null, family: null, stream: false,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, latencyMs: 0, costUsd: null, requestedCostUsd: null, stopReason: null, error: null,
      class: null, classReason: null, conversationKey: null, requestedModel: null, routedModel: null, sticky: false, escalated: false, escalationReason: null,
      classifierNote: null, classifierMs: null, classifierCostUsd: null,
    };
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const rt: RouteCtx = { tools: new ToolJsonCheck() };
    let failed: Json = null;
    try {
      checkAuth(req);
      const body = await readJson(req);
      if (DEBUG) {
        const msgs = Array.isArray(body.messages) ? body.messages.length : 0;
        const tools = Array.isArray(body.tools) ? body.tools.length : 0;
        debug(`\n→ ${hhmmss()} ${url.pathname}  model=${body.model}  ${msgs} msg${msgs === 1 ? "" : "s"}  ${tools} tool${tools === 1 ? "" : "s"}  ~${kTok(Math.ceil(JSON.stringify(body).length / 4))} tok${body.stream ? "  stream" : ""}${req.headers["x-bedrouter-class"] ? `  x-bedrouter-class=${req.headers["x-bedrouter-class"]}` : ""}`);
      }
      await handler(req, res, body, log, ac, rt);
    } catch (err: Json) {
      failed = err;
      log.error = err?.message ?? String(err);
      if (ac.signal.aborted && !res.writableEnded) { res.destroy(); }
      else if (res.headersSent) {
        // mid-stream failure: surface it in-band and close
        res.write(shape === "anthropic" ? `event: error\ndata: ${JSON.stringify(errorBody(err, shape))}\n\n` : `data: ${JSON.stringify(errorBody(err, shape))}\n\n`);
        res.end();
      } else {
        sendJson(res, errorStatus(err), errorBody(err, shape));
      }
    } finally {
      log.latencyMs = Date.now() - started;
      if (rt.decision) {
        const d = rt.decision;
        const obs = router.observe(d, { stopReason: log.stopReason, outputTokens: log.outputTokens, errorStatus: failed ? errorStatus(failed) : null, aborted: ac.signal.aborted, malformedToolJson: rt.tools.malformed() });
        log.escalated = d.escalated || obs.escalated;
        log.escalationReason = [d.escalationReason, obs.reason].filter(Boolean).join("+") || null;
      }
      appendLog(log);
      tally(log);
      if (DEBUG) {
        if (log.error) debug(`  ✗ ${log.latencyMs} ms  ${log.error}${log.escalationReason ? `  → escalation:${log.escalationReason}${log.escalated ? " (moved up)" : " (at ceiling)"}` : ""}`);
        else debug(`  ← ${log.stopReason ?? "?"}  in ${kTok(log.inputTokens ?? 0)}${log.cacheReadTokens ? ` (+${kTok(log.cacheReadTokens)} cached)` : ""}  out ${kTok(log.outputTokens ?? 0)}  ${log.latencyMs} ms  ${usd(log.costUsd)}${log.requestedCostUsd != null && log.requestedCostUsd !== log.costUsd ? ` (asked-for model: ${usd(log.requestedCostUsd)})` : ""}${log.escalationReason ? `  → escalation:${log.escalationReason}${log.escalated ? " (next request moves up)" : " (already at ceiling)"}` : ""}`);
      }
    }
  });
}
