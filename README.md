# Bedrouter

A thin local proxy that lets AI coding CLIs (Claude Code, Codex, Cursor, Cline, ...) talk to **AWS Bedrock** through the API shapes they already speak. One endpoint on localhost, Bedrock as the only backend, a static model map with a cost table, and a JSON-lines decision log for every request.

This is the core proxy. Class-based routing (picking the cheapest model that can reliably complete the task) is the next milestone; see the note at the end.

## Install and run

Requires Node 20+ and AWS credentials that can call Bedrock.

```sh
npm install
npm start            # http://127.0.0.1:20129
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `20129` | Listen port (always binds `127.0.0.1`) |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK` | | Standard AWS SDK credential chain (any one source). Note the SDK only reads the standard names; `AWS_ACCESS_KEY` / `AWS_SECRET_KEY` are ignored. |
| `BEDROUTER_CONFIG` | `./bedrouter.json` | Model map; falls back to `bedrouter.example.json` when the default path is missing |
| `BEDROUTER_LOG` | `./bedrouter.log.jsonl` | Decision log path |
| `BEDROUTER_API_KEY` | unset | When set, requests must carry it in `x-api-key` or `Authorization: Bearer`; when unset any key is accepted (localhost tool) |

The IAM principal needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the foundation models and inference profiles named in the config.

## Endpoints

| Route | Shape | Path to Bedrock |
| --- | --- | --- |
| `POST /v1/messages` | Anthropic Messages API (what Claude Code sends), streaming and non-streaming | Native passthrough: `InvokeModel` / `InvokeModelWithResponseStream` with the Anthropic body, so tools, thinking, `cache_control` and `anthropic-beta` headers reach the model unchanged |
| `POST /v1/chat/completions` | OpenAI chat completions, streaming and non-streaming | Translated to `Converse` / `ConverseStream` (works for every family in the config) |
| `GET /v1/models` | OpenAI model list | The configured aliases |
| `GET /health` | | `{ ok, region }` |

A request naming a model that is not in the config gets a 404 listing the valid aliases. There is never a silent fallback.

An Anthropic-shape request may only target the `anthropic` family (a 400 says so); OpenAI-shape requests can target either family because Converse speaks to both.

### Point Claude Code at it

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:20129
export ANTHROPIC_API_KEY=anything        # or the value of BEDROUTER_API_KEY
claude --model claude-sonnet-5
```

The `aliases` block in the config maps the names Claude Code sends by default (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, ...) onto rungs; a trailing `[1m]` is stripped.

### Point an OpenAI-compatible tool at it

Set the base URL to `http://127.0.0.1:20129/v1` and the API key to anything (or `BEDROUTER_API_KEY`). Model names are the aliases from `GET /v1/models`, e.g. `gpt-oss-120b` or `sonnet`. Tool calls, `tool_choice`, data-URL images, `stop`, `temperature`, `top_p`, `max_tokens` are translated; `n`, `logprobs`, http image URLs are not.

## Config format

`bedrouter.json` (copy `bedrouter.example.json`; the example is used automatically when no config exists):

```json
{
  "families": {
    "anthropic": [
      { "alias": "haiku",  "bedrockId": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "inputPerM": 1.1, "outputPerM": 5.5 },
      { "alias": "sonnet", "bedrockId": "us.anthropic.claude-sonnet-5",                "inputPerM": 2.2, "outputPerM": 11 }
    ],
    "openai": [
      { "alias": "gpt-oss-20b", "bedrockId": "openai.gpt-oss-20b-1:0", "inputPerM": 0.07, "outputPerM": 0.2 }
    ]
  },
  "aliases": { "claude-sonnet-5": "sonnet", "gpt-oss": "gpt-oss-20b" }
}
```

- `families.<family>` is an ordered ladder, cheapest first. The family decides the Bedrock path (`anthropic` = native passthrough).
- `bedrockId` is what Bedrock receives. Prefer the `us.` cross-region inference profile IDs where they exist; several Claude models reject the bare foundation-model ID with on-demand throughput.
- `inputPerM` / `outputPerM` are USD per million tokens and feed the cost estimate. Cache reads are charged at 0.1x and cache writes at 1.25x of the input rate. Prices are static; there is no live lookup.
- `aliases` map client model names onto rung aliases. Matching is exact.

### Model IDs and prices in the example

Verified against the AWS model cards (September 2026) and against the live account: Bedrock validates the model ID before authorization, so every ID in the example resolves to a real resource ARN (an invalid ID fails with `ValidationException`, a valid one returned `AccessDeniedException` from the test principal). `ListFoundationModels` was not permitted for that principal, so the inventory was checked this way rather than listed.

Prices for the Claude rows are Anthropic's published Bedrock rates with the 10% premium AWS charges for regional (`us.`) profiles over `global.` ones. Switch the IDs to `global.` and drop the premium if data residency does not matter. The gpt-oss rows are the US East on-demand rates from the Bedrock pricing page. Update the numbers when AWS changes them.

### Which Bedrock path was verified

Bedrock offers two ways to reach Claude natively: `InvokeModel` on `bedrock-runtime` with the Anthropic body (`anthropic_version: "bedrock-2023-05-31"`, betas in `anthropic_beta`), and the newer Messages-API endpoint at `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages` (SigV4 service `bedrock-mantle`, bearer tokens via `x-api-key`). Bedrouter uses `InvokeModel`, because the AWS SDK supports it directly and AWS documents that Opus 4.7+ requests through it are served by the same infrastructure as the Messages endpoint. The mantle endpoint has no SDK client and needs hand-rolled SigV4, so it was left out. Only the ID-validation check above could be run against the real account (the available principal lacks `bedrock:InvokeModel`); the passthrough itself was exercised with unit tests and a mock-free local run, not a live completion.

GPT-5.x models exist on Bedrock only behind the mantle `openai/v1/responses` path, so they are not reachable here; the OpenAI family is `gpt-oss-20b` / `gpt-oss-120b` via Converse.

## Decision log

One JSON object per line in `BEDROUTER_LOG`:

```json
{"ts":"2026-09-10T02:51:53.055Z","endpoint":"/v1/messages","clientModel":"claude-sonnet-5","bedrockId":"us.anthropic.claude-sonnet-5","family":"anthropic","stream":true,"inputTokens":1830,"outputTokens":212,"cacheReadTokens":1500,"cacheWriteTokens":0,"latencyMs":2410,"costUsd":0.0031,"stopReason":"end_turn","error":null}
```

| Field | Meaning |
| --- | --- |
| `ts` | Request start, ISO 8601 |
| `endpoint` | `/v1/messages` or `/v1/chat/completions` |
| `clientModel` / `bedrockId` / `family` | What the client asked for and what it resolved to (`null` when resolution failed) |
| `stream` | Streaming flag from the request |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | From Bedrock usage (`null` when the request never reached the model) |
| `latencyMs` | Wall clock from request start to response end |
| `costUsd` | Estimate from the price table |
| `stopReason` | Bedrock/Anthropic stop reason |
| `error` | Error message, or `null` |

The router milestone will add class and escalation fields to the same lines.

## Development

```sh
npm test         # node:test unit tests: translators, streaming assembly, model map, cost
npm run typecheck
npm run smoke    # one small streaming request per endpoint against real Bedrock; skips when no credentials
```

## Next milestone: class-based routing

Bedrouter's purpose is to send each request to the cheapest model that can reliably complete it at high quality. The next milestone adds a router in front of the ladders: it classifies requests from cheap signals already in the request (no LLM classifier), keeps the chosen class sticky per conversation so prompt caching keeps working, escalates to the next rung on observable failure, and records the class and any escalation in the decision log so the ladder can be tuned from data. Routing stays within a family (Anthropic rungs for Anthropic-shape traffic, OpenAI rungs for OpenAI-shape traffic).
