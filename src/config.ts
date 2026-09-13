import fs from "node:fs";
import type { Class, RoutingConfig } from "./router.js";

export type Capabilities = { transport: "bedrock-runtime"; api: "converse"; toolUse: boolean; streaming: boolean; imageInput: boolean; structuredOutputs: boolean; promptCaching: boolean; contextWindow: number; maxOutput: number };
export type Rung = { alias: string; bedrockId: string; vendor: string; enabled: boolean; inputPerM: number; outputPerM: number; serves: Class[]; capabilities: Capabilities; auto?: boolean };
export type Config = { stack: Rung[]; aliases?: Record<string, string>; routing?: Omit<Partial<RoutingConfig>, "shape" | "keywords" | "classifier"> & { shape?: Partial<RoutingConfig["shape"]>; keywords?: Partial<RoutingConfig["keywords"]>; classifier?: Partial<RoutingConfig["classifier"]> } };
export const DEFAULT_CONFIG_PATH = "./bedrouter.json";

export function loadConfig(file = process.env.BEDROUTER_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
  if (!process.env.BEDROUTER_CONFIG && !fs.existsSync(file)) file = "./bedrouter.example.json";
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  if (!Array.isArray(cfg.stack) || !cfg.stack.length) throw new Error(`${file}: missing non-empty "stack"`);
  for (const cls of ["trivial", "execute", "explore"] as Class[]) if (!cfg.stack.some((r) => r.enabled && r.serves.includes(cls))) throw new Error(`${file}: no enabled rung serves ${cls}`);
  return cfg;
}

export function modelTable(cfg: Config): Map<string, Rung> {
  const table = new Map<string, Rung>();
  for (const r of cfg.stack) if (r.enabled) table.set(r.alias, r);
  const representative = cfg.stack.find((r) => r.enabled && r.serves.includes("execute")) ?? cfg.stack.find((r) => r.enabled)!;
  table.set("auto", { ...representative, alias: "auto", auto: true });
  for (const [name, target] of Object.entries(cfg.aliases ?? {})) {
    if (name === "auto") continue;
    const rung = table.get(target);
    if (!rung) throw new Error(`alias "${name}" points at unknown or disabled rung "${target}"`);
    table.set(name, rung);
  }
  return table;
}

export function resolveModel(table: Map<string, Rung>, name: unknown): Rung | undefined { return typeof name === "string" ? table.get(name.replace(/\[1m\]$/, "")) : undefined; }
export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
export function estimateCost(rung: Pick<Rung, "inputPerM" | "outputPerM">, u: Usage): number { const per = (n: number) => n / 1_000_000; return u.input * per(rung.inputPerM) + u.output * per(rung.outputPerM) + (u.cacheRead ?? 0) * per(rung.inputPerM) * .1 + (u.cacheWrite ?? 0) * per(rung.inputPerM) * 1.25; }
