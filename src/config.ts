import fs from "node:fs";
import type { RoutingConfig } from "./router.js";

export type Family = "anthropic" | "openai";

export type Rung = {
  alias: string;
  bedrockId: string;
  inputPerM: number;
  outputPerM: number;
  family: Family;
  /** Set on `auto` aliases: the client is not choosing a model, only a family; the router owns the whole decision. */
  auto?: boolean;
};

export type Config = {
  families: Record<Family, Omit<Rung, "family">[]>;
  aliases?: Record<string, string>;
  routing?: Omit<Partial<RoutingConfig>, "shape" | "keywords" | "classifier"> & { shape?: Partial<RoutingConfig["shape"]>; keywords?: Partial<RoutingConfig["keywords"]>; classifier?: Partial<RoutingConfig["classifier"]> };
};

export const DEFAULT_CONFIG_PATH = "./bedrouter.json";

export function loadConfig(path = process.env.BEDROUTER_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
  // ponytail: fall back to the committed example so `npm start` works on a fresh clone;
  // copy it to ./bedrouter.json (gitignored) to customise.
  if (!process.env.BEDROUTER_CONFIG && !fs.existsSync(path)) path = "./bedrouter.example.json";
  const cfg = JSON.parse(fs.readFileSync(path, "utf8")) as Config;
  if (!cfg.families) throw new Error(`${path}: missing "families"`);
  return cfg;
}

/** alias -> rung for every rung alias plus every client alias. */
export function modelTable(cfg: Config): Map<string, Rung> {
  const table = new Map<string, Rung>();
  for (const [family, rungs] of Object.entries(cfg.families) as [Family, Omit<Rung, "family">[]][]) {
    for (const r of rungs) table.set(r.alias, { ...r, family });
  }
  for (const [name, target] of Object.entries(cfg.aliases ?? {})) {
    // "auto:<family>" = no model preference; resolves to the family's execute rung (or the first rung) with the auto flag,
    // which removes the client-model floor and the pinned-cheap rule for that request.
    const auto = /^auto:(\w+)$/.exec(target);
    if (auto) {
      const family = auto[1] as Family;
      const rungs = cfg.families[family];
      if (!rungs?.length) throw new Error(`alias "${name}": unknown family "${family}"`);
      const exec = cfg.routing?.classes?.[family]?.execute;
      const base = rungs.find((r) => r.alias === exec) ?? rungs[0];
      table.set(name, { ...base, family, auto: true });
      continue;
    }
    const rung = table.get(target);
    if (!rung) throw new Error(`alias "${name}" points at unknown rung "${target}"`);
    table.set(name, rung);
  }
  return table;
}

export function resolveModel(table: Map<string, Rung>, name: unknown): Rung | undefined {
  if (typeof name !== "string") return undefined;
  // ponytail: Claude Code appends "[1m]" to request the 1M context window; strip it, no other fuzzing.
  return table.get(name.replace(/\[1m\]$/, ""));
}

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

/** USD estimate. Cache reads at 0.1x and 5-minute cache writes at 1.25x of the input rate (Anthropic/Bedrock multipliers). */
export function estimateCost(rung: Pick<Rung, "inputPerM" | "outputPerM">, u: Usage): number {
  const perTok = (perM: number) => perM / 1_000_000;
  return (
    u.input * perTok(rung.inputPerM) +
    u.output * perTok(rung.outputPerM) +
    (u.cacheRead ?? 0) * perTok(rung.inputPerM) * 0.1 +
    (u.cacheWrite ?? 0) * perTok(rung.inputPerM) * 1.25
  );
}
