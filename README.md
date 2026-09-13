# bedrouter

bedrouter is a local, cost-aware model router for AWS Bedrock. OpenAI-compatible
clients send requests to one `auto` model; bedrouter classifies each request,
filters models by required capabilities, and chooses from one explicitly ordered
stack. Pinned Anthropic models can also use the native Messages endpoint.

## Install and run

```sh
npm install -g bedrouter
cp "$(npm root -g)/bedrouter/bedrouter.example.json" ~/.bedrouter/bedrouter.json
export BEDROUTER_CONFIG=~/.bedrouter/bedrouter.json
export AWS_PROFILE=bedrouter
export AWS_REGION=us-east-1
bedrouter serve
```

The default address is `http://127.0.0.1:20129`. Set
`BEDROUTER_API_KEY` if clients outside your account can reach that address.
Run `bedrouter doctor` to inspect credentials and probe enabled rungs, and
`bedrouter smoke` for an end-to-end request.

AWS enables serverless models by default, subject to account permissions and
regional availability. Anthropic models additionally require the account's
one-time use-case form.

## The stack

`bedrouter.json` has one hand-ordered `stack`. Each rung declares the task
classes it serves and the request features it supports:

```jsonc
{
  "stack": [
    {
      "alias": "nova-micro",
      "bedrockId": "us.amazon.nova-micro-v1:0",
      "vendor": "amazon",
      "enabled": true,
      "inputPerM": 0.035,
      "outputPerM": 0.14,
      "serves": ["trivial"],
      "capabilities": {
        "transport": "bedrock-runtime",
        "api": "converse",
        "toolUse": true,
        "streaming": true,
        "imageInput": false,
        "structuredOutputs": false,
        "promptCaching": true,
        "contextWindow": 128000,
        "maxOutput": 5000
      }
    }
  ],
  "routing": {
    "enabled": true,
    "honorClientModel": false,
    "cacheHitRate": 0.8,
    "classifier": {
      "enabled": true,
      "model": "nova-micro",
      "mode": "fallback"
    }
  }
}
```

The order is authoritative. For a `trivial`, `execute`, or `explore`
request, the router chooses the first enabled rung that serves the class and
supports the request shape. Tools, images, streaming, structured output, output
size, and context size filter the eligible set. A prompt cache point sent to a
model without prompt caching is stripped and recorded as a degradation.

Conversations stay on their current vendor while that vendor has an eligible
rung. Retries, throttling, server failures, truncated output, empty output, and
malformed tool JSON move the next request rightward through the eligible stack.
A capability-related Bedrock `ValidationException` excludes the contradicted
rung and retries the same request once.

At startup, every class must retain at least one enabled rung. This prevents a
probe or manual edit from silently leaving a class unroutable.

```sh
bedrouter stack --explain
```

This prints the configured order, effective input price at the configured cache
hit rate, and the enabled rungs serving each class.

## Client API

Use the OpenAI-compatible endpoint for `auto` and all cross-vendor routing:

```sh
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Summarize this."}]}'
```

`POST /v1/messages` accepts pinned Anthropic aliases only. It rejects `auto`
because native Anthropic request bodies cannot be routed safely to every vendor.

Other endpoints:

- `GET /health` reports process and routing status.
- `GET /v1/models` returns `auto`, enabled aliases, prices, vendor, task
  classes, and capabilities.
- `GET /v1/conversations` and `GET /v1/sessions` expose recent totals.

Clients may send `x-bedrouter-class: trivial|execute|explore|off`. The
`x-bedrouter-session` header associates requests with a client session.
Responses include the selected model, class, reason, and conversation key.

## Logs and reports

Every request appends JSON to `BEDROUTER_LOG` (default
`./bedrouter.log.jsonl`). Along with tokens, cost, latency, and outcome, each
line records `vendor`, `eligibleCount`, `skipped[]`, and `degraded[]`.

```sh
bedrouter report
bedrouter report --json
```

## Development

```sh
npm test
npm run typecheck
npm run build
```
