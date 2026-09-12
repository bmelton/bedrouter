# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Layout: `src/env.ts` (loads `.env`; imported first), `src/preflight.ts` (credential check + friendly SSO errors), `src/config.ts` (model map + cost), `src/router.ts` (class router: signals, sticky map, upgrade-on-intent, escalation, `reclassify()` for the classifier verdict; pure, no I/O), `src/classifier.ts` (classifier prompt/parse + one Converse call), `src/translate.ts` (OpenAI <-> Converse, pure), `src/server.ts` (http routes, Bedrock calls, decision log), `scripts/{doctor,smoke,report}.ts`. Run `npm test`, `npm run typecheck`, `npm run smoke`.
- Credentials are the SDK default chain only; `AWS_PROFILE` in `.env` is the per-machine switch (Identity Center profile at home, corporate SSO profile at work). Never add a bespoke credential path. The `trivial` class and `auto` aliases (`auto:<family>` in `aliases`, `Rung.auto`) are the only ways below the client's requested model. The classifier model runs only when `Decision.undecided` is true; keep it that way so cost stays one call per conversation.
- Pi integration is deliberately not in this repo: it lives in the separate `pi-bedrouter` package, which expects a running bedrouter.
- Ponytail rules apply: stdlib `http`, single runtime dep (`@aws-sdk/client-bedrock-runtime`), no framework. Deliberate ceilings are marked `// ponytail:` in source.
- Anthropic-shape traffic is a native `InvokeModel` passthrough (body minus `model`/`stream`, plus `anthropic_version` and `anthropic_beta` from the header). Do not re-encode it through Converse. See README "Which Bedrock path was verified".
- Bedrock validates model IDs before IAM: an invalid ID returns `ValidationException`, a valid one returns `AccessDeniedException` when the principal lacks `bedrock:InvokeModel`. Useful for checking new IDs without `ListFoundationModels`.
- Routing thresholds and keyword lists live in `bedrouter.example.json` under `routing`; the README "Routing" section is the reference for signals and log fields. `createServer(cfg, client)` accepts a fake Bedrock client for tests (see `test/server.test.ts`).
- Model IDs/prices live only in `bedrouter.example.json`; current IDs come from the AWS model cards (`docs.aws.amazon.com/bedrock/latest/userguide/model-card-*.html`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
