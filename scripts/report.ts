// Savings report over the decision log: what routing cost versus what the same usage would have cost on the model each
// client asked for. Usage: npm run report [-- --log path] [--json] [--since 2026-09-14T00:00:00Z]
import "../src/env.js";
import fs from "node:fs";

type Line = { ts: string; classifierCostUsd?: number | null; classifierMs?: number | null; class: string | null; classReason: string | null; requestedModel: string | null; routedModel: string | null; costUsd: number | null; requestedCostUsd: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; latencyMs: number; error: string | null; escalated: boolean; escalationReason: string | null; conversationKey: string | null; endpoint: string };

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const logPath = opt("log") ?? process.env.BEDROUTER_LOG ?? "./bedrouter.log.jsonl";
const since = opt("since") ? Date.parse(opt("since")!) : 0;
const asJson = args.includes("--json");

if (!fs.existsSync(logPath)) { console.error(`no log at ${logPath}`); process.exit(1); }
const lines: Line[] = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l: Line) => Date.parse(l.ts) >= since);
const priced = lines.filter((l) => l.costUsd != null);

type Agg = { requests: number; costUsd: number; requestedCostUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; escalations: number; latencyMs: number };
const agg = (): Agg => ({ requests: 0, costUsd: 0, requestedCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, escalations: 0, latencyMs: 0 });
const add = (a: Agg, l: Line) => {
  a.requests++; a.costUsd += l.costUsd ?? 0; a.requestedCostUsd += l.requestedCostUsd ?? l.costUsd ?? 0;
  a.inputTokens += l.inputTokens ?? 0; a.outputTokens += l.outputTokens ?? 0; a.cacheReadTokens += l.cacheReadTokens ?? 0;
  a.escalations += l.escalated ? 1 : 0; a.latencyMs += l.latencyMs;
};
const group = (key: (l: Line) => string) => { const m = new Map<string, Agg>(); for (const l of priced) { const k = key(l); if (!m.has(k)) m.set(k, agg()); add(m.get(k)!, l); } return m; };

const total = agg(); priced.forEach((l) => add(total, l));
const byClass = group((l) => l.class ?? "(unrouted)");
const byRoute = group((l) => `${l.requestedModel ?? "?"} -> ${l.routedModel ?? "?"}`);
const byReason = group((l) => l.classReason ?? "(none)");
const escalations = new Map<string, number>();
for (const l of lines) if (l.escalationReason) escalations.set(l.escalationReason, (escalations.get(l.escalationReason) ?? 0) + 1);
const errors = lines.filter((l) => l.error).length;
const conversations = new Set(lines.map((l) => l.conversationKey).filter(Boolean)).size;
const classifierCalls = lines.filter((l) => l.classifierMs != null);
const classifierUsd = classifierCalls.reduce((a, l) => a + (l.classifierCostUsd ?? 0), 0);
const classifierMs = classifierCalls.reduce((a, l) => a + (l.classifierMs ?? 0), 0);
const saved = total.requestedCostUsd - total.costUsd - classifierUsd;
const pct = total.requestedCostUsd > 0 ? (saved / total.requestedCostUsd) * 100 : 0;

if (asJson) {
  const obj = (m: Map<string, Agg>) => Object.fromEntries(m);
  console.log(JSON.stringify({ log: logPath, requests: lines.length, priced: priced.length, errors, conversations, total, classifier: { calls: classifierCalls.length, costUsd: classifierUsd, avgMs: classifierCalls.length ? classifierMs / classifierCalls.length : 0 }, savedUsd: saved, savedPct: pct, byClass: obj(byClass), byRoute: obj(byRoute), byReason: obj(byReason), escalations: Object.fromEntries(escalations) }, null, 2));
  process.exit(0);
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number, w = 8) => String(n).padStart(w);
const table = (title: string, m: Map<string, Agg>) => {
  console.log(`\n${title}`);
  console.log(`  ${pad("", 30)} ${"reqs".padStart(6)} ${"in tok".padStart(9)} ${"out tok".padStart(8)} ${"cost".padStart(10)} ${"if requested".padStart(13)} ${"saved".padStart(10)} ${"esc".padStart(4)}`);
  for (const [k, a] of [...m.entries()].sort((x, y) => y[1].costUsd - x[1].costUsd))
    console.log(`  ${pad(k, 30)} ${num(a.requests, 6)} ${num(a.inputTokens, 9)} ${num(a.outputTokens, 8)} ${usd(a.costUsd).padStart(10)} ${usd(a.requestedCostUsd).padStart(13)} ${usd(a.requestedCostUsd - a.costUsd).padStart(10)} ${num(a.escalations, 4)}`);
};

console.log(`bedrouter report  ${logPath}${since ? `  since ${new Date(since).toISOString()}` : ""}`);
console.log(`  requests ${lines.length} (${priced.length} reached a model, ${errors} errors), conversations ${conversations}`);
console.log(`  tokens   in ${total.inputTokens}  out ${total.outputTokens}  cache-read ${total.cacheReadTokens}`);
console.log(`  cost     ${usd(total.costUsd)} actual vs ${usd(total.requestedCostUsd)} if every request had run on the model the client asked for`);
if (classifierCalls.length) console.log(`  classifier ${classifierCalls.length} calls, ${usd(classifierUsd)}, avg ${Math.round(classifierMs / classifierCalls.length)} ms (counted against savings)`);
console.log(`  saved    ${usd(saved)} (${pct.toFixed(1)}%)${saved < 0 ? "  <- routing spent more than requested (escalations / explore upgrades)" : ""}`);
table("By class", byClass);
table("By route (requested -> routed)", byRoute);
table("By deciding signal", byReason);
if (escalations.size) { console.log("\nEscalation triggers"); for (const [k, n] of escalations) console.log(`  ${pad(k, 30)} ${num(n, 6)}`); }
