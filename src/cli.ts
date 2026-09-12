#!/usr/bin/env node
// `bedrouter` binary and `npm start`.
//   bedrouter [serve] [--debug]     credential preflight, then serve (default)
//   bedrouter doctor [--probe]      credential source, config, optional 1-token probe of every rung
//   bedrouter report [--since t] [--session key] [--log p] [--json]
//   bedrouter smoke                 one streaming request per endpoint against real Bedrock
import "./env.js";

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--debug");
const argv = cmd && !cmd.startsWith("-") ? rest : process.argv.slice(2);

switch (cmd && !cmd.startsWith("-") ? cmd : "serve") {
  case "doctor": process.exit(await (await import("./doctor.js")).main(argv));
  case "report": process.exit(await (await import("./report.js")).main(argv));
  case "smoke": process.exit(await (await import("./smoke.js")).main(argv));
  case "serve": {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    const { loadConfig } = await import("./config.js");
    const { describe, preflight } = await import("./preflight.js");
    const { DEBUG, createServer, region } = await import("./server.js");
    const port = Number(process.env.PORT ?? 20129);
    const client = new BedrockRuntimeClient({ region });
    const p = await preflight(client);
    console.log(describe(p, region));
    if (!p.ok && !process.env.BEDROUTER_SKIP_PREFLIGHT) process.exit(1);
    createServer(loadConfig(), client).listen(port, "127.0.0.1", () =>
      console.log(`bedrouter listening on http://127.0.0.1:${port}${DEBUG ? "  (debug: printing every request)" : "  (BEDROUTER_DEBUG=1 or --debug to print requests)"}`));
    break;
  }
  default:
    console.error(`unknown command "${cmd}". Usage: bedrouter [serve|doctor|report|smoke] [options]`);
    process.exit(2);
}
