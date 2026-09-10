import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const region = process.env.AWS_REGION ?? "us-east-1";
const LOG_PATH = process.env.BEDROUTER_LOG ?? "./bedrouter.log.jsonl";

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
};

// Per-request routing state shared between the handler and the finally block.
type RouteCtx = { decision?: Decision; tools: ToolJsonCheck };

function appendLog(entry: LogEntry) {
  fs.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", (err) => err && console.error("bedrouter: log write failed:", err.message));
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

function sendJson(res: http.ServerResponse, status: number, body: Json) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startSse(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
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
  const aliases = () => [...table.keys()];

  const resolve = (name: unknown): Rung => {
    const rung = resolveModel(table, name);
    if (!rung) throw new HttpError(404, `unknown model "${name}". Valid models: ${aliases().join(", ")}`);
    return rung;
  };

  /** Resolve the client's model, then let the router pick the rung within that family. */
  const route = (req: http.IncomingMessage, body: Json, log: LogEntry, rt: RouteCtx): Rung => {
    const requested = resolve(body.model);
    const header = req.headers["x-bedrouter-class"];
    if (header !== undefined && !/^(execute|explore|off)$/.test(String(header))) throw new HttpError(400, `x-bedrouter-class must be execute, explore or off`);
    const d = (rt.decision = router.route(body, requested, header as string | undefined));
    Object.assign(log, {
      clientModel: body.model, bedrockId: d.rung.bedrockId, family: d.rung.family, stream: !!body.stream,
      class: d.class, classReason: d.classReason, conversationKey: d.conversationKey, requestedModel: requested.alias, routedModel: d.rung.alias, sticky: d.sticky,
    });
    return d.rung;
  };

  // --- POST /v1/messages: Anthropic Messages shape, native passthrough via InvokeModel -------------
  async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, body: Json, log: LogEntry, ac: AbortController, rt: RouteCtx) {
    const rung = route(req, body, log, rt);
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
      finishUsage(log, rung, usage);
      return sendJson(res, 200, msg);
    }

    const out = await client.send(new InvokeModelWithResponseStreamCommand(cmd), { abortSignal: ac.signal });
    startSse(res);
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
    finishUsage(log, rung, usage);
    res.end();
  }

  // --- POST /v1/chat/completions: OpenAI shape, translated to Converse (any family) -----------------
  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, body: Json, log: LogEntry, ac: AbortController, rt: RouteCtx) {
    const rung = route(req, body, log, rt);
    const input = openaiToConverse(body, rung.bedrockId);
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const usageOf = (u: Json): Usage => ({ input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens, cacheWrite: u?.cacheWriteInputTokens });

    if (!body.stream) {
      const out = await client.send(new ConverseCommand(input), { abortSignal: ac.signal });
      log.stopReason = out.stopReason ?? null;
      finishUsage(log, rung, usageOf(out.usage));
      return sendJson(res, 200, converseToOpenai(out, body.model, id));
    }

    const out = await client.send(new ConverseStreamCommand(input), { abortSignal: ac.signal });
    startSse(res);
    const st = newStreamState(body.model, id);
    for await (const ev of out.stream ?? []) {
      if (ev.contentBlockDelta?.delta?.toolUse) rt.tools.add(ev.contentBlockDelta.contentBlockIndex ?? 0, ev.contentBlockDelta.delta.toolUse.input ?? "");
      for (const chunk of converseEventToOpenai(st, ev)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    log.stopReason = st.stopReason ?? null;
    finishUsage(log, rung, usageOf(st.usage));
    res.write("data: [DONE]\n\n");
    res.end();
  }

  function finishUsage(log: LogEntry, rung: Rung, u: Usage) {
    log.inputTokens = u.input;
    log.outputTokens = u.output;
    log.cacheReadTokens = u.cacheRead ?? null;
    log.cacheWriteTokens = u.cacheWrite ?? null;
    log.costUsd = estimateCost(rung, u);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const shape = url.pathname === "/v1/messages" ? "anthropic" : "openai";
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, region });
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = [...table.entries()].map(([id, r]) => ({ id, object: "model", created: 0, owned_by: r.family, bedrock_id: r.bedrockId }));
      return sendJson(res, 200, { object: "list", data });
    }
    const handler = req.method === "POST" ? { "/v1/messages": handleMessages, "/v1/chat/completions": handleChat }[url.pathname] : undefined;
    if (!handler) return sendJson(res, 404, errorBody(new HttpError(404, `no route for ${req.method} ${url.pathname}`), shape));

    const started = Date.now();
    const log: LogEntry = {
      ts: new Date().toISOString(), endpoint: url.pathname, clientModel: null, bedrockId: null, family: null, stream: false,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, latencyMs: 0, costUsd: null, stopReason: null, error: null,
      class: null, classReason: null, conversationKey: null, requestedModel: null, routedModel: null, sticky: false, escalated: false, escalationReason: null,
    };
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const rt: RouteCtx = { tools: new ToolJsonCheck() };
    let failed: Json = null;
    try {
      checkAuth(req);
      const body = await readJson(req);
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
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 20129);
  createServer().listen(port, "127.0.0.1", () => console.log(`bedrouter listening on http://127.0.0.1:${port} (region ${region})`));
}
