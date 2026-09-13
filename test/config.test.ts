import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, loadConfig, modelTable, resolveModel, type Config, type Rung } from "../src/config.js";

const cap = { transport: "bedrock-runtime" as const, api: "converse" as const, toolUse: true, streaming: true, imageInput: false, structuredOutputs: true, promptCaching: false, contextWindow: 1000, maxOutput: 100 };
const rung = (alias: string, vendor: string, serves: Rung["serves"], enabled = true): Rung => ({ alias, vendor, serves, enabled, bedrockId: alias, inputPerM: 1, outputPerM: 2, capabilities: cap });
const cfg: Config = { stack: [rung("tiny", "a", ["trivial"]), rung("work", "b", ["execute"]), rung("deep", "b", ["explore"])], aliases: { named: "work" } };

test("model table has one auto alias, enabled rungs, and ordinary aliases", () => {
  const table = modelTable(cfg);
  assert.deepEqual([...table.keys()], ["tiny", "work", "deep", "auto", "named"]);
  assert.deepEqual([resolveModel(table, "auto")!.auto, resolveModel(table, "auto")!.vendor], [true, "b"]);
  assert.equal(resolveModel(table, "named")!.alias, "work");
  assert.equal(resolveModel(table, "work[1m]")!.alias, "work");
});

test("config validates that every class retains an enabled rung", () => {
  assert.ok(loadConfig("/definitely/missing").stack.length > 0);
  assert.throws(() => modelTable({ ...cfg, aliases: { bad: "missing" } }), /unknown or disabled/);
  assert.ok(estimateCost(cfg.stack[0], { input: 1_000_000, output: 1_000_000 }) > 2.9);
});
