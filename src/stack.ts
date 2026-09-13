import "./env.js";
import { loadConfig } from "./config.js";
import type { Class } from "./router.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (!argv.includes("--explain")) { console.error("usage: bedrouter stack --explain"); return 2; }
  const cfg = loadConfig(), hit = cfg.routing?.cacheHitRate ?? 0.8;
  console.log(`stack (authoritative order; cache hit-rate advisory ${(hit * 100).toFixed(0)}%)`);
  for (const r of cfg.stack) {
    const effective = r.capabilities.promptCaching ? r.inputPerM * ((1 - hit) + hit * 0.1) : r.inputPerM;
    console.log(`${r.enabled ? " " : "×"} ${r.alias.padEnd(20)} ${r.vendor.padEnd(12)} in $${r.inputPerM.toFixed(3)} effective $${effective.toFixed(3)}  serves ${r.serves.join(",") || "-"}`);
  }
  for (const cls of ["trivial", "execute", "explore"] as Class[]) console.log(`${cls.padEnd(8)} ${cfg.stack.filter((r) => r.enabled && r.serves.includes(cls)).map((r) => r.alias).join(" → ") || "NONE"}`);
  return 0;
}
