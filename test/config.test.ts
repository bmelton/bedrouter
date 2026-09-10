import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, loadConfig, modelTable, resolveModel, type Config } from "../src/config.js";

const cfg: Config = {
  families: {
    anthropic: [
      { alias: "haiku", bedrockId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", inputPerM: 1, outputPerM: 5 },
      { alias: "sonnet", bedrockId: "us.anthropic.claude-sonnet-5", inputPerM: 2, outputPerM: 10 },
    ],
    openai: [{ alias: "gpt-oss-120b", bedrockId: "openai.gpt-oss-120b-1:0", inputPerM: 0.15, outputPerM: 0.6 }],
  },
  aliases: { "claude-sonnet-5": "sonnet", "gpt-oss": "gpt-oss-120b" },
};

test("modelTable/resolveModel: rung aliases, client aliases, [1m] suffix, unknown", () => {
  const table = modelTable(cfg);
  assert.equal(resolveModel(table, "haiku")!.bedrockId, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(resolveModel(table, "haiku")!.family, "anthropic");
  assert.equal(resolveModel(table, "claude-sonnet-5")!.bedrockId, "us.anthropic.claude-sonnet-5");
  assert.equal(resolveModel(table, "claude-sonnet-5[1m]")!.alias, "sonnet");
  assert.equal(resolveModel(table, "gpt-oss")!.family, "openai");
  assert.equal(resolveModel(table, "claude-3-opus"), undefined);
  assert.equal(resolveModel(table, undefined), undefined);
  assert.deepEqual([...table.keys()], ["haiku", "sonnet", "gpt-oss-120b", "claude-sonnet-5", "gpt-oss"]);
});

test("modelTable rejects alias pointing at unknown rung", () => {
  assert.throws(() => modelTable({ ...cfg, aliases: { x: "nope" } }), /unknown rung "nope"/);
});

test("estimateCost: input/output plus cache multipliers", () => {
  const rung = { inputPerM: 2, outputPerM: 10 };
  assert.equal(estimateCost(rung, { input: 1_000_000, output: 0 }), 2);
  assert.equal(estimateCost(rung, { input: 0, output: 100_000 }), 1);
  assert.ok(Math.abs(estimateCost(rung, { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 1000 }) - (0.002 + 0.001 + 0.002 + 0.0025)) < 1e-12);
});

test("loadConfig reads the committed example", () => {
  const example = loadConfig("./bedrouter.example.json");
  const table = modelTable(example);
  assert.ok(resolveModel(table, "claude-haiku-4-5-20251001"));
  assert.ok(resolveModel(table, "claude-opus-5"));
  assert.equal(resolveModel(table, "gpt-oss")!.family, "openai");
});
