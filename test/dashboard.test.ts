import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, baselineRung, renderHtml, type LogLine } from "../src/dashboard.js";
import type { Rung } from "../src/config.js";

const cap = { transport: "bedrock-runtime" as const, api: "converse" as const, toolUse: true, streaming: true, imageInput: false, structuredOutputs: true, promptCaching: false, contextWindow: 1000, maxOutput: 100 };
const rung = (alias: string, inputPerM: number, serves: Rung["serves"], enabled = true): Rung =>
  ({ alias, vendor: "v", serves, enabled, bedrockId: alias, inputPerM, outputPerM: inputPerM * 4, capabilities: cap });
// Cheapest first, as Router.ranked would order it.
const ranked = [rung("cheap", 0.1, ["trivial", "execute"]), rung("mid", 1, ["execute", "explore"]), rung("big", 10, ["explore"]), rung("off", 99, ["explore"], false)];
const ranks = Object.fromEntries(ranked.map((r, i) => [r.alias, i]));
const baseline = baselineRung(ranked);

// One million input tokens on `big` costs $10, on `mid` $1, on `cheap` $0.10. Output is four times input.
const line = (o: Partial<LogLine> & { ts: string }): LogLine => ({
  requestedModel: "mid", routedModel: "cheap", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: 0.1, requestedCostUsd: 1, classReason: "default", conversationKey: "c1", error: null, escalated: false, escalationReason: null,
  classifierMs: null, classifierCostUsd: null, ...o,
});

const lines: LogLine[] = [
  line({ ts: "2026-09-14T01:00:00Z" }),
  line({ ts: "2026-09-14T02:00:00Z", classReason: "keyword:explore" }),
  line({ ts: "2026-09-15T01:00:00Z", classifierMs: 300, classifierCostUsd: 0.002 }),
  line({ ts: "2026-09-15T02:00:00Z", routedModel: "mid", costUsd: 1, requestedModel: "mid" }),
  // An upgrade: asked for the cheap rung, served by the dear one. Costs more than the baseline, so savings go negative.
  line({ ts: "2026-09-15T03:00:00Z", requestedModel: "cheap", routedModel: "big", costUsd: 10, requestedCostUsd: 0.1, classReason: "upgrade:keyword:explore" }),
  line({ ts: "2026-09-16T01:00:00Z", escalated: true, escalationReason: "retry" }),
  line({ ts: "2026-09-16T02:00:00Z", escalated: true, escalationReason: "retry" }),
  line({ ts: "2026-09-16T03:00:00Z", escalationReason: "max_tokens" }),
  // Never reached a model: counted in requests and errors, never priced.
  line({ ts: "2026-09-16T04:00:00Z", costUsd: null, requestedCostUsd: null, routedModel: null, error: "ValidationException" }),
  line({ ts: "2026-09-16T05:00:00Z", sessionKey: "s-other" }),
];

test("baseline defaults to the dearest enabled rung that serves explore", () => {
  assert.equal(baseline.alias, "big");
  assert.equal(baselineRung(ranked, "mid").alias, "mid");
  assert.throws(() => baselineRung(ranked, "nope"), /not a rung in the stack/);
  assert.throws(() => baselineRung(ranked, "off"), /disabled rung/);
});

test("totals price the same tokens twice and subtract the classifier from savings", () => {
  const v = aggregate(lines, { baseline, ranks });
  assert.equal(v.totals.requests, 10);
  assert.equal(v.totals.priced, 9);
  assert.equal(v.totals.errors, 1);
  // Eight lines on one million input tokens, one on `mid` and one on `big`: 7 * 0.1 + 1 + 10.
  assert.equal(round(v.totals.costUsd), 11.7);
  // Every priced line re-priced on `big` at $10 per million input.
  assert.equal(round(v.totals.baselineUsd), 90);
  assert.equal(round(v.totals.savedUsd), round(90 - 11.7 - 0.002));
  assert.equal(round(v.totals.savedPct), round((90 - 11.7 - 0.002) / 90 * 100));
  assert.equal(v.totals.classifierCalls, 1);
  // The asked-for baseline is the weak one here: it is already a cheap rung for most of these lines.
  assert.equal(round(v.totals.savedVsRequestedUsd), round(8.1 - 11.7 - 0.002));
  assert.equal(v.totals.escalations, 3);
  assert.equal(v.totals.topEscalation, "retry");
  // Seven mid->cheap lines are cheaper; the cheap->big line is an upgrade; the mid->mid line is neither.
  assert.deepEqual([v.totals.cheaperRequests, v.totals.comparableRequests], [7, 9]);
  // A request for `auto` names no rung, so it can be neither cheaper nor dearer and never reaches the denominator.
  const withAuto = aggregate([...lines, line({ ts: "2026-09-17T01:00:00Z", requestedModel: "auto" })], { baseline, ranks });
  assert.deepEqual([withAuto.totals.cheaperRequests, withAuto.totals.comparableRequests], [7, 9]);
});

test("day buckets split spend by routed rung and keep chronological order", () => {
  const v = aggregate(lines, { baseline, ranks });
  assert.deepEqual(v.buckets.map((b) => b.key), ["2026-09-14", "2026-09-15", "2026-09-16"]);
  assert.deepEqual(v.buckets[0].byRung, { cheap: round(0.2) });
  assert.deepEqual(Object.keys(v.buckets[1].byRung).sort(), ["big", "cheap", "mid"]);
  assert.equal(round(v.buckets[1].costUsd), 11.1);
  assert.equal(round(v.buckets[1].baselineUsd), 30);
  // Rungs are listed cheapest-first by rank, which is the stack order the legend and the chart share.
  assert.deepEqual(v.rungs, ["cheap", "mid", "big"]);
  const hours = aggregate(lines, { baseline, ranks, bucket: "hour" }).buckets;
  assert.equal(hours.length, 10);
  // A request that never reached a model still opens its bucket, so a day of nothing but errors keeps its place on the axis.
  const allErrors = hours.find((b) => b.key === "2026-09-16T04")!;
  assert.deepEqual([allErrors.requests, allErrors.costUsd, Object.keys(allErrors.byRung).length], [1, 0, 0]);
});

test("an upgrade shows as a negative saving, never as a zero", () => {
  const v = aggregate(lines, { baseline, ranks });
  const up = v.byRoute.find((r) => r.requested === "cheap" && r.routed === "big")!;
  assert.equal(round(up.savedUsd), 0);
  assert.equal(up.upgrade, false); // same rung as the baseline, so it is exactly break-even
  const cheaperBaseline = aggregate(lines, { baseline: ranked[1], ranks });
  const up2 = cheaperBaseline.byRoute.find((r) => r.routed === "big")!;
  assert.ok(up2.savedUsd < 0, "routing above the baseline must report a negative saving");
  assert.equal(up2.upgrade, true);
  assert.ok(renderHtml(cheaperBaseline, { generatedAt: "t" }).includes(`class="n bad">-$`), "a negative saving renders in the warning colour");
});

test("since and session narrow the window", () => {
  const v = aggregate(lines, { baseline, ranks, since: Date.parse("2026-09-16T00:00:00Z") });
  assert.equal(v.totals.requests, 5);
  assert.equal(v.window.fromIso, "2026-09-16T01:00:00Z");
  assert.equal(aggregate(lines, { baseline, ranks, session: "s-other" }).totals.requests, 1);
  assert.equal(aggregate([], { baseline, ranks }).totals.savedPct, 0);
});

test("the view model carries no free text a model wrote about a prompt", () => {
  const withNotes = lines.map((l) => ({ ...l, classifierNote: "the user asked about the auth token in src/secret.ts", sessionKey: "branch/HAB-1-fix" }));
  const v = aggregate(withNotes, { baseline, ranks });
  const serialized = JSON.stringify(v);
  for (const forbidden of ["classifierNote", "auth token", "src/secret.ts", "conversationKey", "c1"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach the view model`);
  }
  assert.ok(!renderHtml(v, { generatedAt: "t" }).includes("auth token"));
});

test("the page is self-contained and escapes what it prints", () => {
  const v = aggregate([line({ ts: "2026-09-16T01:00:00Z", classReason: `<script>alert("x")</script>` })], { baseline, ranks });
  const html = renderHtml(v, { generatedAt: "t", live: true });
  assert.ok(!/<script>alert/.test(html), "a log field must never become markup");
  assert.ok(!/(src|href)="http/.test(html), "the page must fetch nothing");
  assert.ok(html.includes("<svg"), "the charts are inline");
  assert.ok(html.includes("auto every 5s"));
  assert.ok(!renderHtml(v, { generatedAt: "t" }).includes("auto every 5s"), "a snapshot has no refresh control");
});

const round = (n: number) => Math.round(n * 1e6) / 1e6;
