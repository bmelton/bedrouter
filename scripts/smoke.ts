// One small streaming request through each endpoint against real Bedrock. Skips (exit 0) when no AWS credentials.
import "../src/env.js";
import type { AddressInfo } from "node:net";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { describe, preflight } from "../src/preflight.js";

const region = process.env.AWS_REGION ?? "us-east-1";
console.log(`smoke: using region=${region}`);
const client = new BedrockRuntimeClient({ region });
const pf = await preflight(client);
console.log(describe(pf, region));
if (!pf.ok) { console.log("smoke: skipped (no usable credentials)"); process.exit(0); }

const cfg = loadConfig();
const anthropicModel = cfg.families.anthropic[0]?.alias;
const openaiModel = cfg.families.openai[0]?.alias;

async function sse(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (text.includes("Could not load credentials")) {
    console.log("smoke: skipped (no AWS credentials in the standard chain: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK, ...)");
    process.exit(0);
  }
  return { status: res.status, text, lines: text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)) };
}

// error object from a non-stream JSON error body or an in-band SSE error line
function errorIn(r: { status: number; text: string; lines: string[] }): { message?: string } | undefined {
  const cands = r.status === 200 ? r.lines : [r.text];
  for (const l of cands) { try { const e = JSON.parse(l); if (e.type === "error" || e.error) return e.error; } catch { /* not json */ } }
  return undefined;
}

const server = createServer(cfg, client);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let failed = false;
try {
  const m = await sse(`${base}/v1/messages`, { model: anthropicModel, max_tokens: 20, stream: true, messages: [{ role: "user", content: "Say hi in one word." }] });
  const mText = m.lines.map((l) => { try { const e = JSON.parse(l); return e.delta?.text ?? ""; } catch { return ""; } }).join("");
  const mErr = errorIn(m);
  console.log(`/v1/messages        [${anthropicModel}] status=${m.status} text=${JSON.stringify(mText)}${mErr ? " error=" + mErr.message : ""}`);
  failed ||= m.status !== 200 || !!mErr;

  // gpt-oss reasons before it answers and the reasoning counts against max_tokens, so give it room and show both parts.
  const c = await sse(`${base}/v1/chat/completions`, { model: openaiModel, max_tokens: 300, stream: true, messages: [{ role: "user", content: "Say hi in one word." }] });
  const deltas = c.lines.filter((l) => l !== "[DONE]").map((l) => { try { return JSON.parse(l).choices?.[0]?.delta ?? {}; } catch { return {}; } });
  const cText = deltas.map((d) => d.content ?? "").join("");
  const cReason = deltas.map((d) => d.reasoning_content ?? "").join("");
  const cErr = errorIn(c);
  console.log(`/v1/chat/completions [${openaiModel}] status=${c.status} text=${JSON.stringify(cText)} reasoning=${cReason.length} chars${cErr ? " error=" + cErr.message : ""}`);
  failed ||= c.status !== 200 || !!cErr;
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
