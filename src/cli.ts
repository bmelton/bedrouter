#!/usr/bin/env node
// `bedrouter` binary and `npm start`.
//   bedrouter [serve] [--debug]     credential preflight, then serve (default)
//   bedrouter doctor [--probe]      credential source, config, optional 1-token probe of every rung
//   bedrouter report [--since t] [--session key] [--log p] [--json]
//   bedrouter smoke                 one streaming request per endpoint against real Bedrock
//   bedrouter stack --explain       effective input prices and eligible rungs per class
//   bedrouter publish [--since d] [--dry-run]        push closed UTC days to the team stats repository
//   bedrouter rollup <dir> --prices <f> --out <dir>  merge day files into the team page (the stats repo Action)
import "./env.js";

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--debug");
const argv = cmd && !cmd.startsWith("-") ? rest : process.argv.slice(2);

switch (cmd && !cmd.startsWith("-") ? cmd : "serve") {
  case "doctor": process.exit(await (await import("./doctor.js")).main(argv));
  case "report": process.exit(await (await import("./report.js")).main(argv));
  case "smoke": process.exit(await (await import("./smoke.js")).main(argv));
  case "stack": process.exit(await (await import("./stack.js")).main(argv));
  case "publish": process.exit(await (await import("./publish.js")).main(argv));
  case "rollup": process.exit(await (await import("./rollup.js")).main(argv));
  case "serve": {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    const { loadConfig } = await import("./config.js");
    const { describe, preflight } = await import("./preflight.js");
    const { DEBUG, createServer, region } = await import("./server.js");
    const { startPublishLoop } = await import("./publish.js");
    const port = Number(process.env.PORT ?? 20129);
    const client = new BedrockRuntimeClient({ region });
    const p = await preflight(client);
    console.log(describe(p, region));
    if (!p.ok && !process.env.BEDROUTER_SKIP_PREFLIGHT) process.exit(1);
    const cfg = loadConfig();
    // A second provider has a second credential. This is a warning, never a stop: a rung whose token is missing just
    // becomes unavailable, and every other rung still serves. `doctor` prints the detail.
    for (const r of cfg.stack.filter((r) => r.enabled && r.capabilities.transport === "openai-responses")) {
      const { readCodexCredential } = await import("./codex.js");
      const cred = readCodexCredential(r.auth?.kind === "oauth-file" ? r.auth.path : undefined);
      if ("error" in cred) console.log(`warning: rung "${r.alias}" is enabled but ${cred.error}`);
    }
    // Publishing runs beside the server rather than inside it, so createServer stays a pure request path with no
    // background uploader to stub out in a test.
    startPublishLoop(cfg);
    createServer(cfg, client).listen(port, "127.0.0.1", () =>
      console.log(`bedrouter listening on http://127.0.0.1:${port}${DEBUG ? "  (debug: printing every request)" : "  (BEDROUTER_DEBUG=1 or --debug to print requests)"}`));
    break;
  }
  default:
    console.error(`unknown command "${cmd}". Usage: bedrouter [serve|doctor|report|smoke|stack --explain] [options]`);
    process.exit(2);
}
