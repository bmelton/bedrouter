import "./env.js";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, preflight } from "./preflight.js";
import { loadConfig } from "./config.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Prints which credential source bedrouter will use and whether it works. Exit 0 when credentials resolve, 1 otherwise.
  // `--probe` additionally sends a 1-token request to every rung in the config and reports which ones this account can
  // invoke, so the stack can be matched to the account (personal accounts lack some frontier models).

  const region = process.env.AWS_REGION ?? "us-east-1";
  const client = new BedrockRuntimeClient({ region });
  const p = await preflight(client);
  console.log(describe(p, region));
  const cfg = loadConfig();
  console.log(`config: ${process.env.BEDROUTER_CONFIG ?? "./bedrouter.json (or bedrouter.example.json)"}, routing ${cfg.routing?.enabled ? "on" : "off"}`);
  console.log(`  stack: ${cfg.stack.map((r) => `${r.alias}=${r.bedrockId}${r.enabled ? "" : " (disabled)"}`).join("  ")}`);

  if (p.ok && argv.includes("--probe")) {
    console.log("\nprobe: one 1-token request per rung");
    let denied = 0;
    for (const r of cfg.stack.filter((r) => r.enabled)) {
      const started = Date.now();
      try {
        await client.send(new ConverseCommand({ modelId: r.bedrockId, messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 1 } }));
        console.log(`  ok      ${r.alias.padEnd(14)} ${r.bedrockId}  (${Date.now() - started} ms)`);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        const why = /not available for this account/i.test(e.message ?? "") ? "not available for this account (Bedrock entitlement, not IAM)" : e.message;
        console.log(`  DENIED  ${r.alias.padEnd(14)} ${r.bedrockId}  ${e.name}: ${why}`);
        denied++;
      }
    }
    if (denied) console.log(`\n${denied} rung(s) unusable here. Disable or replace them in bedrouter.json; every class must retain at least one enabled rung.`);
  }
  return p.ok ? 0 : 1;
}
