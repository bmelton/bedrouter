// Model classifier: asks a small model which class a request belongs to. Used only when the rules were undecided (or
// always, by config), and only on the request that classifies a conversation, so the overhead is one short call per
// conversation rather than per request. Pure prompt/parse helpers plus one Converse call.
import { ConverseCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { estimateCost, type Rung, type Usage } from "./config.js";
import { promptShape, type Class } from "./router.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const CLASSIFIER_SYSTEM = `You route requests from AI coding assistants to models of different cost. Read the request and answer with exactly one line:
CLASS: short reason

CLASS is one of:
trivial - a quick factual question, a title, a rename, a one-line answer; no code reasoning needed
execute - a well-specified implementation, edit, test or fix against a known spec; ordinary coding work
explore - architecture, design, debugging an unknown cause, comparing approaches, planning, research, anything open-ended or high-stakes

Prefer the cheapest class that would still produce a reliable answer. Do not explain beyond the one line.`;

export function classifierPrompt(body: Json, maxChars: number): string {
  const s = promptShape(body);
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + " …[truncated]" : t);
  const lines = [
    `Conversation turns so far: ${s.dialogTurns}. Tools available to the assistant: ${s.tools}. Estimated context: ${s.inputTokens} tokens.`,
  ];
  if (s.system) lines.push(`System prompt (excerpt):\n${clip(s.system.replace(/\s+/g, " ").trim(), Math.min(600, maxChars / 4))}`);
  lines.push(`Latest user request:\n${clip(s.lastUser, maxChars)}`);
  return lines.join("\n\n");
}

export function parseVerdict(text: string): { class: Class; note: string } | null {
  const m = /\b(trivial|execute|explore)\b\s*[:\-–]?\s*(.*)/i.exec(text.trim());
  if (!m) return null;
  return { class: m[1].toLowerCase() as Class, note: m[2].trim().split("\n")[0].slice(0, 200) };
}

export type ClassifierResult = { class: Class; note: string; ms: number; costUsd: number } | { class: null; note: string; ms: number; costUsd: number };

export async function classifyWithModel(client: Pick<BedrockRuntimeClient, "send">, rung: Rung, body: Json, opts: { maxChars: number; timeoutMs: number }): Promise<ClassifierResult> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const out = await client.send(new ConverseCommand({
      modelId: rung.bedrockId,
      system: [{ text: CLASSIFIER_SYSTEM }],
      messages: [{ role: "user", content: [{ text: classifierPrompt(body, opts.maxChars) }] }],
      inferenceConfig: { maxTokens: 60, temperature: 0 },
    }), { abortSignal: ac.signal });
    const text = (out.output?.message?.content ?? []).map((b: Json) => b.text ?? "").join("");
    const usage: Usage = { input: out.usage?.inputTokens ?? 0, output: out.usage?.outputTokens ?? 0 };
    const v = parseVerdict(text);
    const costUsd = estimateCost(rung, usage);
    return v ? { ...v, ms: Date.now() - started, costUsd } : { class: null, note: `unparseable: ${text.slice(0, 80)}`, ms: Date.now() - started, costUsd };
  } catch (err) {
    return { class: null, note: `error: ${(err as Error).name ?? ""} ${(err as Error).message ?? String(err)}`.slice(0, 200), ms: Date.now() - started, costUsd: 0 };
  } finally {
    clearTimeout(timer);
  }
}
