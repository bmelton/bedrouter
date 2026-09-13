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

Rungs are selected cheapest-first by *effective* input price, which is the list
price adjusted for prompt caching at the configured `cacheHitRate`: a cache read
bills at a tenth, so a caching rung at `$1.00` beats a non-caching rung at
`$0.50` once the hit rate reaches 0.8. Agentic traffic re-sends the whole prompt
every turn, so this ordering, not the list price, is what a session actually
costs. The configured order is the tiebreak. `bedrouter stack --explain` prints
both figures.

For a `trivial`, `execute`, or `explore`
request, the router chooses the first eligible rung that serves the class and
supports the request shape. Tools, images, streaming, structured output, output
size, and context size filter the eligible set. A prompt cache point sent to a
model without prompt caching is stripped and recorded as a degradation.

Classification reads only what the human typed. A harness that speaks in the
user's name, with a session digest, a watcher wake, or an agent nudge, is skipped:
a user turn is treated as injected when it starts with one of
`routing.injectedMarkers` (default `U+2063`, the invisible separator firstmate
prefixes) or exceeds `routing.shape.humanTurnMaxChars`. Without this, a single
word inside a 17KB digest sets the class for a whole session.

Every human turn re-decides the class. Raising it needs a strong signal, so a
conversation does not thrash upward, and `upgradeOnIntent` gates that. Lowering
it needs none, and is recorded as `downgrade:<reason>`, because a class that
sticks forever turns one bad guess into the price of every later request.

Conversations stay on their current vendor while that vendor has an eligible
rung. Retries, throttling, server failures, truncated output, empty output, and
malformed tool JSON move the next request rightward through the eligible stack.
A capability-related Bedrock `ValidationException` excludes the contradicted
rung and retries the same request once.

The stack may list rungs this account cannot invoke, so one config file is
portable across accounts. An `AccessDeniedException`, or a `ValidationException`
that reports an invalid model identifier, is a fact about the account and the
region rather than the request. The router drops that rung and answers the same
request from the next eligible rung. The drop lasts for the life of the process,
so each denied rung costs one failed call per restart, and a new entitlement
needs no config edit. Up to three reselections run per request; after that the
Bedrock error reaches the client. `skipped[]` records each dropped rung as
`<alias>:unavailable`.

An output cap is a ceiling, not a requirement. The router reads it from
`max_completion_tokens` or `max_tokens`, and prefers a rung that can honour it
in full. When no rung can, the chosen rung answers within its own limit, the
outgoing value is lowered to match, and `degraded[]` records
`<alias>:clamp-maxTokens:<limit>`. A reply that truly stops at the cap still
raises the class for the next request.

When no rung serves the chosen class, the class degrades one step, from
`explore` to `execute` to `trivial`, and the reason becomes `degrade:<class>`. A
weaker answer beats a failed request. Emptiness caused by a capability filter is
unaffected, because the same filter applies to every class.

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
