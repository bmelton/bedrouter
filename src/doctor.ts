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
  console.log(`  stack: ${cfg.stack.map((r) => `${r.alias}=${r.modelId}${r.enabled ? "" : " (disabled)"}`).join("  ")}`);

  // A rung on another provider has its own credential, and it fails in its own way. Report it beside the AWS one
  // rather than leaving a silent hole: bedrouter mints no token and runs no login flow, so the fix is `codex login`.
  const codexRungs = cfg.stack.filter((r) => r.capabilities.transport === "openai-responses");
  if (codexRungs.length) {
    const { readCodexCredential } = await import("./codex.js");
    for (const r of codexRungs) {
      const file = r.auth?.kind === "oauth-file" ? r.auth.path ?? "~/.codex/auth.json" : "~/.codex/auth.json";
      const cred = readCodexCredential(file);
      if ("error" in cred) console.log(`codex: ${r.alias} (${r.enabled ? "enabled" : "disabled"}) -> ${cred.error}`);
      else console.log(`codex: ${r.alias} (${r.enabled ? "enabled" : "disabled"}) -> ${file} ok, token valid until ${new Date(cred.expiresAt).toISOString()}`);
    }
  }

  const { Router } = await import("./router.js");
  const { baselineRung } = await import("./dashboard.js");
  const router = new Router(cfg);
  try { const b = baselineRung(router.ranked, router.rc.baselineAlias); console.log(`  dashboard baseline: ${b.alias} at $${b.inputPerM}/$${b.outputPerM} per million${router.rc.baselineAlias ? "" : " (default: dearest enabled rung that serves explore)"}`); }
  catch (err) { console.log(`  dashboard baseline: ${(err as Error).message}`); }

  const pub = cfg.publish;
  if (!pub?.enabled || !pub.repo) console.log(`publish: off${pub ? "" : " (no publish block in the config)"}`);
  else {
    const { resolveCredential, identity } = await import("./publish.js");
    const cred = resolveCredential(pub.credential ?? "auto");
    console.log(`publish: ${pub.repo}${pub.branch ? ` (${pub.branch})` : ""}, every ${Math.round((pub.intervalMs ?? 3_600_000) / 60_000)} min`);
    if (!cred) console.log("  credential: none. Run `gh auth login`, or set BEDROUTER_PUBLISH_TOKEN in .env");
    else {
      // A gh token carries whatever scope the developer already has and nothing here can narrow it, so the scope is
      // reported rather than assumed. bedrouter only ever writes data/<login>/<date>.json.
      try { const me = await identity(cred.token); console.log(`  credential: ${cred.source}, publishing as ${me.login} (id ${me.id})${me.scopes ? `, token scopes: ${me.scopes}` : ", fine-grained token (no scope header)"}`); }
      catch (err) { console.log(`  credential: ${cred.source}, but GET /user failed: ${(err as Error).message}`); }
    }
  }

  if (p.ok && argv.includes("--probe")) {
    console.log("\nprobe: one 1-token request per rung");
    let denied = 0;
    for (const r of cfg.stack.filter((r) => r.enabled)) {
      const started = Date.now();
      try {
        await client.send(new ConverseCommand({ modelId: r.modelId, messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 1 } }));
        console.log(`  ok      ${r.alias.padEnd(14)} ${r.modelId}  (${Date.now() - started} ms)`);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        const why = /not available for this account/i.test(e.message ?? "") ? "not available for this account (Bedrock entitlement, not IAM)" : e.message;
        console.log(`  DENIED  ${r.alias.padEnd(14)} ${r.modelId}  ${e.name}: ${why}`);
        denied++;
      }
    }
    if (denied) console.log(`\n${denied} rung(s) unusable here. Disable or replace them in bedrouter.json; every class must retain at least one enabled rung.`);
  }
  return p.ok ? 0 : 1;
}
