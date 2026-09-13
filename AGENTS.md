# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Layout: `src/env.ts` (loads `.env`; imported first), `src/preflight.ts` (credential check + friendly SSO errors), `src/config.ts` (model map + cost), `src/router.ts` (class router: signals, sticky map, upgrade-on-intent, escalation, `reclassify()` for the classifier verdict; pure, no I/O), `src/classifier.ts` (classifier prompt/parse + one Converse call), `src/translate.ts` (OpenAI <-> Converse, pure), `src/server.ts` (http routes, Bedrock calls, decision log), `src/cli.ts` dispatches serve/doctor/report/smoke (`src/{doctor,report,smoke}.ts`); `npm run build` → `dist/` is the published binary. Run `npm test`, `npm run typecheck`, `npm run smoke`. Routing decisions are echoed as `x-bedrouter-*` response headers and tallied per conversation (`/v1/conversations/:key`) for pi-bedrouter's footer; keep both stable.
- Credentials are the SDK default chain only; `AWS_PROFILE` in `.env` is the per-machine switch (Identity Center profile at home, corporate SSO profile at work). Never add a bespoke credential path. The ordered `stack` is authoritative; `serves` ranks models and `capabilities` filters requests. `auto` is the only synthetic model. The classifier runs only when `Decision.undecided` is true, so cost stays one call per conversation.
- Pi integration is deliberately not in this repo: it lives in the separate `pi-bedrouter` package, which expects a running bedrouter.
- Ponytail rules apply: stdlib `http`, single runtime dep (`@aws-sdk/client-bedrock-runtime`), no framework. Deliberate ceilings are marked `// ponytail:` in source.
- Anthropic-shape traffic remains a native `InvokeModel` path for pinned Anthropic rungs. Cross-vendor `auto` traffic uses OpenAI chat shape translated to Converse.
- Bedrock validates model IDs before IAM: an invalid ID returns `ValidationException`, a valid one returns `AccessDeniedException` when the principal lacks `bedrock:InvokeModel`. Useful for checking new IDs without `ListFoundationModels`.
- Routing thresholds and keyword lists live in `bedrouter.example.json` under `routing`; the README "Routing" section is the reference for signals and log fields. `createServer(cfg, client)` accepts a fake Bedrock client for tests (see `test/server.test.ts`).
- Model IDs, prices, `serves`, and capability facts live only in `bedrouter.example.json`; verify objective facts against AWS model cards.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
