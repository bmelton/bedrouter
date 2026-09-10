# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Layout: `src/config.ts` (model map + cost), `src/router.ts` (class router: signals, sticky map, escalation; pure, no I/O), `src/translate.ts` (OpenAI <-> Converse, pure), `src/server.ts` (http routes, Bedrock calls, decision log). Run `npm test`, `npm run typecheck`, `npm run smoke`.
- Ponytail rules apply: stdlib `http`, single runtime dep (`@aws-sdk/client-bedrock-runtime`), no framework. Deliberate ceilings are marked `// ponytail:` in source.
- Anthropic-shape traffic is a native `InvokeModel` passthrough (body minus `model`/`stream`, plus `anthropic_version` and `anthropic_beta` from the header). Do not re-encode it through Converse. See README "Which Bedrock path was verified".
- Bedrock validates model IDs before IAM: an invalid ID returns `ValidationException`, a valid one returns `AccessDeniedException` when the principal lacks `bedrock:InvokeModel`. Useful for checking new IDs without `ListFoundationModels`.
- The dev machine exports `AWS_ACCESS_KEY` / `AWS_SECRET_KEY` (non-standard names) for an IAM user without Bedrock permissions; the SDK ignores those names and `npm run smoke` skips. Do not add a mapping for them in code.
- Routing thresholds and keyword lists live in `bedrouter.example.json` under `routing`; the README "Routing" section is the reference for signals and log fields. `createServer(cfg, client)` accepts a fake Bedrock client for tests (see `test/server.test.ts`).
- Model IDs/prices live only in `bedrouter.example.json`; current IDs come from the AWS model cards (`docs.aws.amazon.com/bedrock/latest/userguide/model-card-*.html`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
