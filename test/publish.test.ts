import { test } from "node:test";
import assert from "node:assert/strict";
import { closedDays, dailyRollup, errorClass, mergeIndex, type DayFile, type Prices } from "../src/publish.js";
import type { LogLine } from "../src/dashboard.js";

const meta = { user: "bmelton", userId: 12345, version: "0.8.0", classifierRung: "nova-micro" };
const prices: Prices = {
  schema: 1, baselineAlias: "opus",
  rungs: { "gpt-oss-20b": { inputPerM: 0.07, outputPerM: 0.3 }, "gpt-oss-120b": { inputPerM: 0.15, outputPerM: 0.6 }, opus: { inputPerM: 5.5, outputPerM: 27.5 } },
};

const line = (o: Partial<LogLine> & { ts: string }): LogLine => ({
  requestedModel: "gpt-oss-20b", routedModel: "gpt-oss-120b", inputTokens: 1000, outputTokens: 100,
  cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.00021, requestedCostUsd: 0.0001,
  class: "execute", classReason: "default", error: null, escalated: false, escalationReason: null,
  classifierMs: null, classifierCostUsd: null, ...o,
});

const lines: LogLine[] = [
  line({ ts: "2026-09-14T01:00:00Z" }),
  line({ ts: "2026-09-14T02:00:00Z", class: "trivial", classifierMs: 300, classifierCostUsd: 0.0002 }),
  line({ ts: "2026-09-14T03:00:00Z", escalationReason: "retry", escalated: true }),
  line({ ts: "2026-09-14T04:00:00Z", costUsd: null, routedModel: null, error: "AccessDeniedException: not available for this account" }),
  line({ ts: "2026-09-14T05:00:00Z", costUsd: null, routedModel: null, error: "ValidationException: tool use is not supported" }),
  line({ ts: "2026-09-15T01:00:00Z", class: "explore" }),
];

test("a day file holds counts and sums, never anything per request", () => {
  const d = dailyRollup(lines, "2026-09-14", meta);
  assert.equal(d.schema, 1);
  assert.deepEqual([d.user, d.userId, d.date, d.bedrouter], ["bmelton", 12345, "2026-09-14", "0.8.0"]);
  assert.deepEqual(d.routed["gpt-oss-120b"], { requests: 3, inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(d.requested["gpt-oss-20b"].requests, 3);
  // A request that never reached a model still had a class, so the class counts cover more requests than `routed` does.
  assert.deepEqual(d.classes, { execute: 4, trivial: 1 });
  assert.deepEqual(d.classifier, { rung: "nova-micro", calls: 1 });
  assert.deepEqual(d.escalations, { retry: 1 });
  // An error class, never the message: AWS text names accounts, regions and entitlements.
  assert.deepEqual(d.errors, { "rung-fatal": 1, validation: 1 });
  // The file has no array in it. That is the property, not a detail of this fixture.
  for (const v of Object.values(d)) assert.ok(!Array.isArray(v));
  assert.equal(dailyRollup(lines, "2026-09-16", meta).routed["gpt-oss-120b"], undefined);
});

test("no forbidden field survives the allowlist", () => {
  const leaky = lines.map((l) => ({
    ...l,
    classifierNote: "the user asked about the API key in src/secret.ts",
    conversationKey: "9f2c1ab4deadbeef",
    sessionKey: "feature/HAB-42-billing",
    error: "AccessDeniedException: model arn:aws:bedrock:us-east-1:900123456789:foo is not available for this account",
    prompt: "please refactor the payments module",
  }));
  const serialized = JSON.stringify(dailyRollup(leaky, "2026-09-14", meta));
  for (const forbidden of ["classifierNote", "API key", "src/secret.ts", "conversationKey", "9f2c1ab4", "sessionKey", "HAB-42", "prompt", "refactor", "900123456789", "arn:aws"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach the day file`);
  }
  // A field added to the log later is excluded until somebody adds it to dailyRollup on purpose.
  assert.ok(!JSON.stringify(dailyRollup([{ ...line({ ts: "2026-09-14T01:00:00Z" }), somethingNew: "leak me" } as LogLine], "2026-09-14", meta)).includes("leak me"));
});

test("error messages map to classes without carrying their text", () => {
  assert.equal(errorClass("AccessDeniedException: no entitlement"), "rung-fatal");
  assert.equal(errorClass("ValidationException: unsupported"), "validation");
  assert.equal(errorClass("ThrottlingException: slow down"), "throttled");
  assert.equal(errorClass("socket hang up"), "aborted");
  assert.equal(errorClass("something else entirely"), "other");
});

test("only closed UTC days are offered, so a published day is complete when written", () => {
  assert.deepEqual(closedDays(lines, "2026-09-16"), ["2026-09-14", "2026-09-15"]);
  assert.deepEqual(closedDays(lines, "2026-09-15"), ["2026-09-14"]);
  assert.deepEqual(closedDays(lines, "2026-09-14"), []);
});

const dayFile = (user: string, date: string, over: Partial<DayFile> = {}): { path: string; body: DayFile } => ({
  path: `data/${user}/${date}.json`,
  body: { schema: 1, user, userId: 1, date, bedrouter: "0.8.0", routed: { "gpt-oss-120b": { requests: 10, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, requested: { "gpt-oss-20b": { requests: 10, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, classes: { execute: 10 }, classifier: { rung: "nova-micro", calls: 1 }, escalations: {}, errors: {}, ...over },
});

test("the merge prices every day from one table, so two people's numbers are comparable", () => {
  const { view, skipped } = mergeIndex([dayFile("bmelton", "2026-09-14"), dayFile("ada", "2026-09-14"), dayFile("bmelton", "2026-09-15")], prices);
  assert.deepEqual(skipped, []);
  assert.equal(view.totals.requests, 30);
  // Three files at one million input tokens on gpt-oss-120b: $0.15 each.
  assert.equal(round(view.totals.costUsd), 0.45);
  assert.equal(round(view.totals.baselineUsd), 16.5);
  assert.equal(round(view.totals.savedUsd), 16.05);
  assert.deepEqual(view.buckets.map((b) => b.key), ["2026-09-14", "2026-09-15"]);
  assert.deepEqual(view.byPerson!.map((p) => [p.login, p.days, p.requests]), [["bmelton", 2, 20], ["ada", 1, 10]]);
  // Merged day files pair no requested rung with a routed one, so the team page shows no route table at all.
  assert.deepEqual(view.byRoute, []);
  assert.deepEqual(view.byReason, [{ reason: "execute", requests: 30 }]);
  assert.deepEqual(view.reasonTitle, { panel: "Requests by class", column: "Class" });
});

test("a bad file is named and skipped; one person's mistake cannot take the page down", () => {
  const files = [
    dayFile("bmelton", "2026-09-14"),
    { path: "data/ada/2026-09-14.json", body: { ...dayFile("ada", "2026-09-14").body, schema: 2 } },
    // A public repo takes direct pushes, so a file claiming to be somebody else is worth one cheap check.
    { path: "data/mallory/2026-09-14.json", body: dayFile("ada", "2026-09-14").body },
    { path: "data/ada/2026-09-99.json", body: { ...dayFile("ada", "2026-09-14").body, date: "2026-09-99" } },
    { path: "data/ada/2026-09-13.json", body: null },
  ];
  const { view, skipped } = mergeIndex(files, prices);
  assert.equal(view.totals.requests, 10, "only the good file counts");
  assert.deepEqual(skipped.map((s) => s.file), ["data/ada/2026-09-14.json", "data/mallory/2026-09-14.json", "data/ada/2026-09-99.json", "data/ada/2026-09-13.json"]);
  assert.match(skipped[0].why, /unknown schema 2/);
  assert.match(skipped[1].why, /does not match its directory/);
});

test("an unpriced routed rung stops the build instead of silently dropping its spend", () => {
  const withNewRung = dayFile("bmelton", "2026-09-14", { routed: { "glm-5": { requests: 1, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
  assert.throws(() => mergeIndex([withNewRung], prices), /no price for rung "glm-5"/);
  assert.throws(() => mergeIndex([dayFile("bmelton", "2026-09-14")], { ...prices, baselineAlias: "ghost" }), /no price for rung "ghost"/);
});

test("an unpriced requested alias is reported, not fatal, because `auto` names no rung", () => {
  const asked = dayFile("bmelton", "2026-09-14", { requested: { auto: { requests: 10, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
  const { view, unpriced } = mergeIndex([asked], prices);
  assert.deepEqual(unpriced, ["auto"]);
  // The routed spend is unaffected: only the weaker asked-for baseline loses those requests.
  assert.equal(round(view.totals.costUsd), 0.15);
  assert.equal(view.totals.requestedUsd, 0);
});

const round = (n: number) => Math.round(n * 1e6) / 1e6;
