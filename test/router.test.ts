import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, ToolJsonCheck, promptShape } from "../src/router.js";
import { modelTable, resolveModel, type Config } from "../src/config.js";

const cfg: Config = {
  families: {
    anthropic: [
      { alias: "haiku", bedrockId: "h", inputPerM: 1, outputPerM: 5 },
      { alias: "sonnet", bedrockId: "s", inputPerM: 2, outputPerM: 10 },
      { alias: "opus", bedrockId: "o", inputPerM: 5, outputPerM: 25 },
    ],
    openai: [
      { alias: "gpt-oss-20b", bedrockId: "g20", inputPerM: 0.07, outputPerM: 0.2 },
      { alias: "gpt-oss-120b", bedrockId: "g120", inputPerM: 0.15, outputPerM: 0.6 },
    ],
  },
  aliases: { "claude-sonnet-5": "sonnet", "claude-haiku-4-5": "haiku" },
  routing: {
    enabled: true,
    classes: { anthropic: { execute: "sonnet", explore: "opus" }, openai: { execute: "gpt-oss-20b", explore: "gpt-oss-120b" } },
    shape: { exploreInputTokens: 2000, exploreTools: 5, executeTurns: 4, executeLastUserChars: 50 },
    keywords: { explore: ["design", "why", "refactor the whole"], execute: ["implement", "fix", "add test"] },
  },
};
const table = modelTable(cfg);
const rung = (name: string) => resolveModel(table, name)!;
const msg = (text: string, system = "sys") => ({ model: "claude-sonnet-5", system, messages: [{ role: "user", content: text }] });

test("classify: each signal in order, precedence, default", () => {
  const r = new Router(cfg);
  assert.deepEqual(r.classify({ ...msg("implement it"), thinking: { type: "enabled", budget_tokens: 1000 } }), { class: "explore", reason: "thinking" });
  assert.deepEqual(r.classify({ ...msg("implement it"), reasoning_effort: "high" }), { class: "explore", reason: "thinking" });
  assert.equal(r.classify({ ...msg("implement it"), reasoning_effort: "low" }).reason, "keyword:execute");
  assert.deepEqual(r.classify(msg("implement " + "x".repeat(9000))), { class: "explore", reason: "shape:long-context" });
  assert.deepEqual(r.classify({ ...msg("implement it"), tools: new Array(5).fill({ name: "t" }) }), { class: "explore", reason: "shape:many-tools" });
  const deep = { model: "claude-sonnet-5", messages: [
    { role: "user", content: "design a whole new thing please" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "big output" }] },
    { role: "assistant", content: "more" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "x".repeat(5000) }, { type: "text", text: "go on" }] },
  ] };
  assert.deepEqual(r.classify(deep), { class: "execute", reason: "shape:agentic-loop" });
  assert.deepEqual(r.classify(msg("Please DESIGN the cache layer")), { class: "explore", reason: "keyword:explore" });
  assert.deepEqual(r.classify(msg("refactor the whole module")), { class: "explore", reason: "keyword:explore" });
  assert.deepEqual(r.classify(msg("implement the design")), { class: "explore", reason: "keyword:explore" }); // explore wins a tie
  assert.deepEqual(r.classify(msg("add test for parser")), { class: "execute", reason: "keyword:execute" });
  assert.deepEqual(r.classify(msg("designer fixture")), { class: "execute", reason: "default" }); // word boundaries
  assert.deepEqual(r.classify(msg("hello")), { class: "execute", reason: "default" });
  // Claude Code's injected <system-reminder> blocks are not the user's ask
  assert.equal(r.classify(msg("hello <system-reminder>design why plan</system-reminder>")).reason, "default");
  // OpenAI shape: system/developer messages count as system, tool turns are not user turns
  const s = promptShape({ messages: [{ role: "system", content: "S" }, { role: "user", content: [{ type: "text", text: "u1" }] }, { role: "tool", content: "t" }] });
  assert.equal(s.system, "\nS");
  assert.equal(s.firstUser, "u1");
  assert.equal(s.turns, 3);
});

test("route: client model is a floor, strongest is honoured, cheap rung is pinned, families never cross", () => {
  const r = new Router(cfg);
  assert.equal(r.route(msg("implement it"), rung("claude-sonnet-5")).rung.alias, "sonnet");
  assert.equal(r.route(msg("design it"), rung("sonnet")).rung.alias, "opus");
  assert.equal(r.route(msg("implement it"), rung("opus")).rung.alias, "opus"); // requested strongest, class execute: floor wins
  const pinned = r.route(msg("design it"), rung("claude-haiku-4-5"));
  assert.deepEqual([pinned.rung.alias, pinned.class, pinned.classReason, pinned.conversationKey], ["haiku", "execute", "client-model:pinned", null]);
  assert.equal(r.route(msg("design it"), rung("gpt-oss-20b")).rung.alias, "gpt-oss-120b");
  assert.equal(r.route(msg("design it"), rung("gpt-oss-20b")).rung.family, "openai");
  const loose = new Router({ ...cfg, routing: { ...cfg.routing, honorClientModel: false } });
  assert.equal(loose.route(msg("implement it"), rung("opus")).rung.alias, "sonnet");
  assert.throws(() => new Router({ ...cfg, routing: { ...cfg.routing, classes: { anthropic: { execute: "gpt-oss-20b", explore: "opus" } } } }), /not a rung in that family/);
});

test("route: disabled, missing classes and header bypass", () => {
  const off = new Router({ ...cfg, routing: { ...cfg.routing, enabled: false } });
  assert.deepEqual(off.route(msg("design it"), rung("sonnet")), { rung: rung("sonnet"), undecided: false, class: null, classReason: "disabled", conversationKey: null, sticky: false, escalated: false, escalationReason: null });
  assert.equal(new Router({ families: cfg.families }).route(msg("design it"), rung("sonnet")).classReason, "disabled");
  const partial = new Router({ ...cfg, routing: { ...cfg.routing, classes: { anthropic: cfg.routing!.classes!.anthropic } } });
  assert.equal(partial.route(msg("design it"), rung("gpt-oss-20b")).classReason, "no-classes");

  const r = new Router(cfg);
  const d = r.route(msg("design it"), rung("sonnet"), "off");
  assert.deepEqual([d.rung.alias, d.class, d.classReason, d.conversationKey], ["sonnet", null, "header:off", null]);
  const forced = r.route(msg("design it"), rung("sonnet"), "execute");
  assert.deepEqual([forced.rung.alias, forced.class, forced.classReason, forced.sticky], ["sonnet", "execute", "header:execute", false]);
  // the override did not disturb the sticky entry: the unforced follow-up still gets explore
  const next = r.route(msg("design it"), rung("sonnet"));
  assert.deepEqual([next.rung.alias, next.class, next.sticky], ["opus", "explore", true]);
  assert.equal(r.route(msg("hi"), rung("sonnet"), "explore").rung.alias, "opus");
  assert.equal(r.route(msg("hi"), rung("opus"), "execute").rung.alias, "opus"); // floor still applies
});

test("stickiness: a conversation keeps its rung across turns; different conversations classify independently", () => {
  const r = new Router(cfg);
  const first = r.route(msg("design the schema"), rung("sonnet"));
  assert.deepEqual([first.rung.alias, first.sticky], ["opus", false]);
  const turn2 = { model: "claude-sonnet-5", system: "sys", messages: [{ role: "user", content: "design the schema" }, { role: "assistant", content: "here" }, { role: "user", content: "now implement it" }] };
  const second = r.route(turn2, rung("sonnet"));
  assert.deepEqual([second.rung.alias, second.class, second.classReason, second.sticky, second.conversationKey], ["opus", "explore", "sticky", true, first.conversationKey]);
  assert.equal(first.conversationKey!.length, 16);
  const other = r.route(msg("now implement it"), rung("sonnet"));
  assert.deepEqual([other.rung.alias, other.sticky], ["sonnet", false]);
  assert.notEqual(other.conversationKey, first.conversationKey);
  // metadata.user_id separates otherwise identical conversations
  assert.notEqual(r.route({ ...msg("hi"), metadata: { user_id: "a" } }, rung("sonnet")).conversationKey, r.route({ ...msg("hi"), metadata: { user_id: "b" } }, rung("sonnet")).conversationKey);
  // LRU cap evicts the oldest conversation
  const small = new Router({ ...cfg, routing: { ...cfg.routing, maxConversations: 2 } });
  small.route(msg("design a"), rung("sonnet"));
  small.route(msg("design b"), rung("sonnet"));
  small.route(msg("design c"), rung("sonnet"));
  assert.equal(small.route(msg("design a"), rung("sonnet")).sticky, false);
  assert.equal(small.route(msg("design c"), rung("sonnet")).sticky, true);
});

test("escalation: each failure signal bumps one rung, ceiling respected, never de-escalates, not for pinned/bypassed", () => {
  for (const outcome of [
    { stopReason: "max_tokens" }, { outputTokens: 0 }, { errorStatus: 429 }, { errorStatus: 503 }, { malformedToolJson: true },
  ]) {
    const r = new Router(cfg);
    const d = r.route(msg("implement it"), rung("sonnet"));
    assert.equal(d.rung.alias, "sonnet");
    assert.equal(r.observe(d, { stopReason: "end_turn", outputTokens: 10, ...outcome }).escalated, true, JSON.stringify(outcome));
    const next = r.route(msg("implement it"), rung("sonnet"));
    assert.deepEqual([next.rung.alias, next.class, next.sticky], ["opus", "execute", true]);
    // at the ceiling: the trigger is reported but nothing bumps
    assert.deepEqual(r.observe(next, outcome), { escalated: false, reason: r.observe(next, outcome).reason });
    assert.equal(r.route(msg("implement it"), rung("sonnet")).rung.alias, "opus");
  }
  const r = new Router(cfg);
  const d = r.route(msg("implement it"), rung("sonnet"));
  assert.deepEqual(r.observe(d, { stopReason: "end_turn", outputTokens: 12 }), { escalated: false, reason: null });
  assert.deepEqual(r.observe(d, { errorStatus: 404 }), { escalated: false, reason: null }); // client fault
  assert.deepEqual(r.observe(d, { stopReason: "max_tokens", aborted: true }), { escalated: false, reason: null }); // client hung up
  assert.deepEqual(r.observe(r.route(msg("x"), rung("claude-haiku-4-5")), { stopReason: "max_tokens" }), { escalated: false, reason: null });
  assert.deepEqual(r.observe(r.route(msg("x"), rung("sonnet"), "off"), { stopReason: "max_tokens" }), { escalated: false, reason: null });
  assert.equal(r.route(msg("implement the other thing"), rung("sonnet")).rung.alias, "sonnet");
});

test("escalation: identical prompt re-sent within the retry window", () => {
  const r = new Router(cfg);
  const d1 = r.route(msg("implement it"), rung("sonnet"));
  assert.deepEqual([d1.rung.alias, d1.escalated], ["sonnet", false]);
  const d2 = r.route(msg("implement it"), rung("sonnet"));
  assert.deepEqual([d2.rung.alias, d2.escalated, d2.escalationReason, d2.sticky], ["opus", true, "retry", true]);
  const d3 = r.route(msg("implement it"), rung("sonnet"));
  assert.deepEqual([d3.rung.alias, d3.escalated, d3.escalationReason], ["opus", false, "retry"]); // at ceiling
  const slow = new Router({ ...cfg, routing: { ...cfg.routing, retryWindowMs: -1 } });
  slow.route(msg("implement it"), rung("sonnet"));
  const late = slow.route(msg("implement it"), rung("sonnet"));
  assert.deepEqual([late.rung.alias, late.escalated, late.escalationReason], ["sonnet", false, null]); // outside the window
});

test("ToolJsonCheck: assembled fragments must parse", () => {
  const ok = new ToolJsonCheck();
  ok.add(1, '{"a":'); ok.add(1, "1}"); ok.add(2, "");
  assert.equal(ok.malformed(), false);
  const bad = new ToolJsonCheck();
  bad.add(1, '{"a":'); // truncated
  assert.equal(bad.malformed(), true);
});

test("trivial: opening short ask goes to the trivial rung below the client's floor; grows into a sticky class; header and opt-outs", () => {
  const tcfg: Config = { ...cfg, routing: { ...cfg.routing!, classes: { ...cfg.routing!.classes, anthropic: { trivial: "haiku", execute: "sonnet", explore: "opus" } } } };
  const r = new Router(tcfg);
  // short opening ask, no tools: trivial, and it drops below the requested sonnet
  let d = r.route(msg("what does HTTP 429 mean?"), rung("claude-sonnet-5"));
  assert.deepEqual([d.class, d.classReason, d.rung.alias, d.sticky], ["trivial", "shape:trivial", "haiku", false]);
  // not trivial: tools attached, or an explore keyword, or a second turn, or a long ask
  assert.equal(r.route({ ...msg("what does HTTP 429 mean?", "sys2"), tools: [{ name: "t" }] }, rung("claude-sonnet-5")).class, "execute");
  assert.equal(r.route(msg("why does this design leak?", "sys3"), rung("claude-sonnet-5")).class, "explore");
  assert.equal(r.route(msg("x".repeat(301), "sys4"), rung("claude-sonnet-5")).class, "execute");
  // the same conversation growing past trivial is re-classified (not stuck on haiku) and then sticks
  const grown = { model: "claude-sonnet-5", system: "sys", messages: [{ role: "user", content: "what does HTTP 429 mean?" }, { role: "assistant", content: "rate limited" }, { role: "user", content: "implement a retry with backoff for it" }] };
  d = r.route(grown, rung("claude-sonnet-5"));
  assert.deepEqual([d.class, d.classReason, d.rung.alias, d.sticky], ["execute", "keyword:execute", "sonnet", false]);
  assert.deepEqual([r.route(grown, rung("claude-sonnet-5")).classReason], ["sticky"]);
  // an escalated trivial conversation keeps its rung
  d = r.route(msg("hi", "sys5"), rung("claude-sonnet-5"));
  assert.equal(d.rung.alias, "haiku");
  assert.deepEqual(r.observe(d, { outputTokens: 0 }), { escalated: true, reason: "empty" });
  const next = { model: "claude-sonnet-5", system: "sys5", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "ok" }] };
  d = r.route(next, rung("claude-sonnet-5"));
  assert.deepEqual([d.rung.alias, d.classReason], ["sonnet", "sticky"]);
  // header forces trivial for one request; trivialBelowFloor:false keeps the client's model
  assert.equal(r.route({ ...msg("implement the thing", "sys6"), tools: [{ name: "t" }] }, rung("claude-sonnet-5"), "trivial").rung.alias, "haiku");
  const r2 = new Router({ ...tcfg, routing: { ...tcfg.routing!, trivialBelowFloor: false } });
  d = r2.route(msg("what does HTTP 429 mean?"), rung("claude-sonnet-5"));
  assert.deepEqual([d.class, d.rung.alias], ["trivial", "sonnet"]);
  // families without a trivial rung never see the class; haiku requests stay pinned
  assert.equal(r.route({ model: "gpt-oss-20b", messages: [{ role: "user", content: "hi" }] }, rung("gpt-oss-20b")).class, "execute");
  assert.equal(r.route(msg("hi", "sys7"), rung("claude-haiku-4-5")).classReason, "client-model:pinned");
});

test("upgrade on intent: a later user turn with an explore signal moves a sticky conversation up, never down; tool results and shape signals do not", () => {
  const r = new Router(cfg);
  const first = { model: "claude-sonnet-5", system: "sys", messages: [{ role: "user", content: "implement the parser" }] };
  assert.equal(r.route(first, rung("claude-sonnet-5")).rung.alias, "sonnet");
  const turn = (last: any) => ({ ...first, messages: [...first.messages, { role: "assistant", content: "done" }, { role: "user", content: last }] });
  // tool result carrying an explore word is not the user asking
  assert.equal(r.route(turn([{ type: "tool_result", tool_use_id: "1", content: "why design" }]), rung("claude-sonnet-5")).rung.alias, "sonnet");
  // plain follow-up without a signal stays put
  let d = r.route(turn("now add a test"), rung("claude-sonnet-5"));
  assert.deepEqual([d.classReason, d.rung.alias], ["sticky", "sonnet"]);
  // explicit explore ask upgrades
  d = r.route(turn("why does the design leak memory?"), rung("claude-sonnet-5"));
  assert.deepEqual([d.class, d.classReason, d.rung.alias], ["explore", "upgrade:keyword:explore", "opus"]);
  // and it sticks there; an execute ask afterwards does not bring it back down
  d = r.route(turn("implement the fix"), rung("claude-sonnet-5"));
  assert.deepEqual([d.class, d.classReason, d.rung.alias], ["explore", "sticky", "opus"]);
  // opt out
  const r2 = new Router({ ...cfg, routing: { ...cfg.routing!, upgradeOnIntent: false } });
  r2.route(first, rung("claude-sonnet-5"));
  assert.equal(r2.route(turn("why does the design leak memory?"), rung("claude-sonnet-5")).classReason, "sticky");
});

test("auto alias: no floor, no pinning, router owns the decision; undecided flag and reclassify", () => {
  const acfg: Config = { ...cfg, aliases: { ...cfg.aliases, auto: "auto:anthropic", "auto-oss": "auto:openai" },
    routing: { ...cfg.routing!, classes: { ...cfg.routing!.classes, anthropic: { trivial: "haiku", execute: "sonnet", explore: "opus" } }, classifier: { enabled: true, model: "haiku" } } };
  const t = modelTable(acfg);
  const auto = resolveModel(t, "auto")!;
  assert.deepEqual([auto.alias, auto.family, auto.auto], ["sonnet", "anthropic", true]);
  assert.deepEqual([resolveModel(t, "auto-oss")!.alias, resolveModel(t, "auto-oss")!.auto], ["gpt-oss-20b", true]);
  const r = new Router(acfg);
  // a short opening ask on auto lands on haiku (trivial), and is reported undecided only for soft signals
  let d = r.route({ ...msg("what is a monad?", "s1"), model: "auto" }, auto);
  assert.deepEqual([d.class, d.rung.alias, d.undecided], ["trivial", "haiku", false]); // fallback mode: only "default" is undecided
  d = r.route({ ...msg("do the thing with the stuff", "s2"), model: "auto", tools: [{ name: "t" }] }, auto);
  assert.deepEqual([d.class, d.classReason, d.rung.alias, d.undecided], ["execute", "default", "sonnet", true]);
  // classifier says explore: conversation moves to opus and later turns stick there
  const d2 = r.reclassify(d, auto, "explore", "classifier:explore");
  assert.deepEqual([d2.class, d2.classReason, d2.rung.alias, d2.undecided], ["explore", "classifier:explore", "opus", false]);
  const follow = { ...msg("do the thing with the stuff", "s2"), model: "auto", tools: [{ name: "t" }], messages: [{ role: "user", content: "do the thing with the stuff" }, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }] };
  assert.deepEqual([r.route(follow, auto).rung.alias, r.route(follow, auto).classReason], ["opus", "sticky"]);
  // classifier says trivial in a family without a trivial rung -> execute
  const oss = resolveModel(t, "auto-oss")!;
  d = r.route({ model: "auto-oss", messages: [{ role: "user", content: "do the thing" }], tools: [{ name: "t" }] }, oss);
  assert.equal(r.reclassify(d, oss, "trivial", "classifier:trivial").rung.alias, "gpt-oss-20b");
  // "always" mode marks keyword decisions undecided too; thinking stays decisive
  const r2 = new Router({ ...acfg, routing: { ...acfg.routing!, classifier: { enabled: true, model: "haiku", mode: "always" } } });
  assert.equal(r2.route({ ...msg("implement it", "s3"), model: "auto", tools: [{ name: "t" }] }, auto).undecided, true);
  assert.equal(r2.route({ ...msg("implement it", "s4"), model: "auto", thinking: { type: "enabled", budget_tokens: 1 } }, auto).undecided, false);
  // an explicit haiku request is still pinned; auto is not
  assert.equal(r.route(msg("hi", "s5"), rung("claude-haiku-4-5")).classReason, "client-model:pinned");
  assert.throws(() => new Router({ ...acfg, routing: { ...acfg.routing!, classifier: { enabled: true } } }), /classifier\.model/);
});
