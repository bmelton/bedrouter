import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, baselineRung, renderHtml, type LogLine } from "../src/dashboard.js";
import type { Rung } from "../src/config.js";

const cap = { transport: "bedrock-runtime" as const, api: "converse" as const, toolUse: true, streaming: true, imageInput: false, structuredOutputs: true, promptCaching: false, contextWindow: 1000, maxOutput: 100 };
const rung = (alias: string, inputPerM: number, serves: Rung["serves"], enabled = true): Rung =>
  ({ alias, vendor: "v", serves, enabled, modelId: alias, inputPerM, outputPerM: inputPerM * 4, capabilities: cap });
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
  // A pinned rung may be disabled. Prices survive the entitlement probe even when the rung does not, and pricing a
  // counterfactual routes nowhere. Refusing it would break the pin on exactly the accounts whose baseline was drifting.
  assert.equal(baselineRung(ranked, "off").alias, "off");
  // Zero-priced is a different matter: a subscription rung would report every window as 0% saved forever.
  assert.throws(() => baselineRung([...ranked, rung("free", 0, ["explore"])], "free"), /priced at zero/);
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

test("the comparison panel prices the window against named models, not rungs", () => {
  // 7 priced lines of 1M input each (the upgrade line included), so a $3/M model would have cost $21.
  const comparisons = [
    { name: "Dear Model", inputPerM: 3, outputPerM: 12 },
    { name: "Cheap Model", inputPerM: 0.01, outputPerM: 0.04 },
    // Subscription-billed: no per-token price, so it must not appear as "the router cost you everything".
    { name: "Flat Fee", inputPerM: 0, outputPerM: 0 },
  ];
  const v = aggregate(lines, { baseline, ranks, comparisons });

  assert.deepEqual(v.comparisons.map((c) => c.name), ["Dear Model", "Cheap Model"], "zero-priced dropped, dearest first");

  const dear = v.comparisons[0];
  const priced = lines.filter((l) => l.costUsd != null).length;
  assert.equal(round(dear.wouldCostUsd), round(priced * 1_000_000 * 3 / 1_000_000));
  // Savings net off the classifier, exactly as the headline tile does.
  assert.equal(round(dear.savedUsd), round(dear.wouldCostUsd - v.totals.costUsd - v.totals.classifierUsd));
  assert.ok(dear.savedUsd > 0 && dear.savedPct > 0);

  // Routing to something dearer than the comparison must read as a loss, never as a silent zero.
  assert.ok(v.comparisons[1].savedUsd < 0, "a cheaper model than the router shows negative savings");

  // A named model need not be a rung, and an unconfigured list leaves the panel off entirely.
  assert.equal(aggregate(lines, { baseline, ranks }).comparisons.length, 0);

  const html = renderHtml(v, { generatedAt: "t" });
  assert.ok(html.includes("Dear Model") && html.includes("If every request had gone to one model"));
  assert.ok(!html.includes("Flat Fee"), "a zero-priced model is absent from the page, not shown as 100% saved");
});

test("each table panel opens in a native dialog, in a saved snapshot as well as a live page", () => {
  const v = aggregate(lines, { baseline, ranks, comparisons: [{ name: "Dear Model", inputPerM: 3, outputPerM: 12 }] });
  for (const live of [true, false]) {
    const html = renderHtml(v, { generatedAt: "t", live });
    assert.ok(html.includes("<dialog id=\"m\""), "the dialog element is present");
    // A snapshot on disk must expand too: an affordance that does nothing offline is worse than none.
    assert.ok(html.includes("showModal()"), `modal script present when live=${live}`);
    assert.equal(html.includes("location.reload"), live, "the refresh script stays live-only");
    // Every table panel is expandable, and each carries the title the modal header reads.
    const panels = [...html.matchAll(/class="panel x"[^>]*data-title="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(panels, ["What the router did", "Where the money went", "If every request had gone to one model"]);
    // The chart panels are not expandable: an SVG already scales to its column and does not pinch.
    assert.ok(/class="panel"><h2>Spend by/.test(html), "chart panels stay plain");
    assert.ok(!/(src|href)="http/.test(html), "the modal must not make the page fetch anything");
  }
});
