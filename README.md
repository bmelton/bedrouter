# bedrouter

bedrouter is a local, cost-aware model router for AWS Bedrock. OpenAI-compatible
clients send requests to one `auto` model; bedrouter classifies each request,
filters models by required capabilities, and chooses from one explicitly ordered
stack. Decisions follow the conversation rather than the single request: a class
is decided once and revisited on each human turn, a small classifier model breaks
ties the rules cannot, and a failing or unreachable rung moves later requests
along the stack. Every request records what it cost and what the client's own
model would have cost, so `bedrouter report` prints the difference. Pinned
Anthropic models can also use the native Messages endpoint.

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
    "honorClientModel": true,
    "trivialBelowFloor": true,
    "upgradeOnIntent": true,
    "cacheHitRate": 0.8,
    "retryWindowMs": 60000,
    "maxConversations": 1000,
    "classifier": {
      "enabled": true,
      "model": "nova-micro",
      "mode": "fallback",
      "maxChars": 4000,
      "timeoutMs": 4000
    }
  }
}
```

`bedrouter.example.json` is the reference for every default, including the
`routing.shape` thresholds and the `routing.keywords` lists.

Rungs are selected cheapest-first by *effective* input price, which is the list
price adjusted for prompt caching at the configured `cacheHitRate`: a cache read
bills at a tenth, so a caching rung at `$1.00` beats a non-caching rung at
`$0.50` once the hit rate reaches 0.8. Agentic traffic re-sends the whole prompt
every turn, so this ordering, not the list price, is what a session actually
costs. The configured order is the tiebreak. `bedrouter stack --explain` prints
both figures.

For a `trivial`, `execute`, or `explore` request, the router chooses the first
eligible rung that serves the class and supports the request shape. Tools,
images, streaming, structured output, output size, and context size filter the
eligible set. A prompt cache point sent to a
model without prompt caching is stripped and recorded as a degradation.

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

## Classes and conversations

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

### The classifier

The rules answer most requests. When they fall through to `default`, a small
model decides instead. `routing.classifier.mode` chooses when to ask:
`fallback` asks only on `default`, `always` also re-asks on the soft verdicts
(`keyword:*`, `shape:trivial`).

The verdict is stored on the conversation, so the classifier costs one short
call per conversation and not one per request. `maxChars` clips the excerpt it
reads and `timeoutMs` bounds the call. A timeout, an API error, or a reply that
does not parse keeps the rule verdict and records the reason in
`classifierNote`.

A `trivial` verdict on a request that carries tools becomes `execute`, and the
reason gains `+tools-floor`. A turn that carries tools can be asked to call one,
whatever the turn looks like: "hi" to an agentic harness runs its startup
checks. Classifier spend is counted against savings in `bedrouter report`.

### Conversations

A conversation key is a short hash of the client user id, the system prompt, and
the first human turn. A changed system prompt or a compaction therefore starts a
new conversation, which is why clients that want one continuous view send
`x-bedrouter-session`. The router keeps the most recent `maxConversations`
entries.

Selection prefers the rung the conversation already used, then any rung from the
same vendor, then the cheapest eligible rung. Retries, throttling, server
failures, truncated output, empty output, and malformed tool JSON move the next
request rightward through the eligible stack. An identical prompt seen again
within `retryWindowMs` reads as a client retry and moves rightward too. When no
rung to the right serves the current class, the class rises one step instead,
from `trivial` to `execute` to `explore`. A capability-related Bedrock
`ValidationException` excludes the contradicted rung and retries the same
request once.

### Pinned models

A client that names a rung instead of `auto` still meets the router, and
`honorClientModel` decides how far it may disagree. A pinned rung that already
sits below the cheapest rung serving `execute` turns routing off for that
request, with the reason `client-model:pinned`: the client asked for something
cheaper than the router would ever pick, so there is nothing to save. Above that
floor, `honorClientModel: true` keeps the router from selecting anything cheaper
than the pinned rung. The one exception is a `trivial` class with
`trivialBelowFloor` set, where a cheaper rung is the whole point.

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
- `GET /v1/conversations` and `GET /v1/conversations/:key` expose conversation
  totals.
- `GET /v1/sessions` and `GET /v1/sessions/:key` expose client session totals.

A conversation is what the router derived. A session is whatever the client put
in `x-bedrouter-session`, so it survives system prompt changes, compaction, and
sub-agent calls, and it also counts the requests the router never tracked, such
as pinned rungs and errors. Session totals are seeded from the decision log at
startup, so a restart does not zero a running session.

Clients may send `x-bedrouter-class: trivial|execute|explore|off` to force or
disable a class.

Every response carries the decision, which UI integrations read live. These
header names are a stable interface:

| Header | Value |
| --- | --- |
| `x-bedrouter-model` | the alias that answered |
| `x-bedrouter-requested` | the model the client asked for |
| `x-bedrouter-bedrock-id` | the Bedrock model identifier invoked |
| `x-bedrouter-class` | `trivial`, `execute`, or `explore` |
| `x-bedrouter-reason` | why that class, such as `sticky` or `keyword:explore` |
| `x-bedrouter-conversation` | the conversation key |
| `x-bedrouter-classifier` | the classifier's one-line reason, when it ran |

## What routing costs and saves

Every priced request records two figures: what it cost on the rung that answered,
and `requestedCostUsd`, what the same token usage would have cost on the model
the client asked for. The difference is the saving, and `bedrouter report` totals
it, subtracts classifier spend, and breaks it down by class, by requested and
routed model pair, and by deciding signal:

```
bedrouter report  ./bedrouter.log.jsonl
  requests 680 (656 reached a model, 24 errors), conversations 55
  tokens   in 19074379  out 185081  cache-read 0
  cost     $3.5092 actual vs $1.4656 if every request had run on the model the client asked for
  classifier 12 calls, $0.0039, avg 738 ms (counted against savings)
  saved    $-2.0475 (-139.7%)  <- routing spent more than requested (escalations / explore upgrades)
```

A negative saving is a real result, not a bug, and the report labels it. It means
the router spent more than the client's own model would have, because an
escalation or an `explore` upgrade moved traffic to a stronger rung. Read it with
the `By deciding signal` table, which names the signal that made those calls, and
with the escalation triggers at the end of the report.

```sh
bedrouter report --since 2026-09-13T00:00:00Z --session <key> --log ./other.jsonl --json
```

### The two baselines

Savings need a counterfactual, and one number cannot carry both stories.

The **asked-for baseline** is `requestedCostUsd` above: the same tokens priced at
the rung the client named. It is the honest number for pinned traffic. It is weak
for `auto` traffic, because `auto` already resolves to a cheap `execute` rung, so
the comparison starts from a low price and the reported saving is near zero.

The **native baseline** prices the same tokens at one configured top rung, which
answers "what would this have cost if every request had gone to the big model".
Set the rung in `bedrouter.json`:

```json
"routing": { "baselineAlias": "opus" }
```

Absent that key, the baseline is the dearest enabled rung that serves `explore`,
taken from the selection order rather than from list price. A name that no
enabled rung answers to is an error the dashboard reports; it never changes a
routing decision.

Both figures are computed when the page renders, from the token counts each log
line already holds. Nothing extra is written on the request path, so correcting a
price in the config re-prices the whole history at once. Both are estimates, not
invoices: the counterfactual holds the token counts fixed and varies only the
price, and the same prompt on another model emits a different number of output
tokens.

### The dashboard

`GET /dashboard` renders those numbers as one page: spend per day split by routed
rung against the native baseline, the savings rate per day, six headline tiles,
and the `by deciding signal` and `requested -> routed` tables. A route that costs
more than the baseline shows a negative saving in a distinct colour, never a
zero, because a router that quietly spends more is the thing the page exists to
catch.

| Route | Returns |
| --- | --- |
| `GET /dashboard` | The page. One self-contained document: inline SVG charts, no script, style, font or image from anywhere else. A Content-Security-Policy header enforces it |
| `GET /dashboard/data.json` | The same view model as JSON, so the numbers can be read without parsing HTML |

Both accept `since` (ISO timestamp), `bucket` (`day` by default, or `hour`), and
`session`, matching `bedrouter report`. The page reads the log after the fact and
makes no Bedrock call, so a broken dashboard cannot make a request fail.

```sh
bedrouter report --html spend.html --bucket hour     # the same page, written to disk
```

The snapshot is meant to be sent to somebody, so the view model carries
aggregates only: counts, tokens, dollars, model aliases, and signal names.
`classifierNote` is free text a model wrote about a prompt and can therefore
quote one, so `aggregate()` drops it rather than the renderer hiding it.

## Team stats

Off unless a `publish` block is present. Nothing leaves a machine without it.

```json
"publish": { "enabled": true, "repo": "acme/bedrouter-stats", "branch": "main", "intervalMs": 3600000, "credential": "auto" }
```

With it, the running server checks hourly and writes one file per closed UTC day
to one path in a shared repository:

```
data/<github-login>/2026-09-16.json
```

One writer per path, and each path written once. That is what makes the rest
safe. Concurrent publishers cannot clobber each other, because the contents API
updates the branch ref without force and a ref update is compare-and-swap: a
publisher that loses the race gets `409`, re-reads the tip and retries, and has
no content to reconcile. Backfill is not a separate feature; a laptop that was
off for a week publishes seven files on its next check.

A failed publish is never fatal and never blocks a request.

| Command | What it does |
| --- | --- |
| `bedrouter publish --dry-run` | Prints the payloads without writing. This is how to see what the redaction rules actually emit before opting in |
| `bedrouter publish --since 2026-09-01` | Publishes by hand, oldest day first, skipping days already present |
| `bedrouter rollup data --prices prices.json --out dist` | Merges day files into the team page. The stats repository's Action runs this |

### The credential

`credential: "auto"` takes `gh auth token --hostname github.com` when `gh` is
authenticated, and falls back to `BEDROUTER_PUBLISH_TOKEN` from the environment
or `.env`. With neither, publishing logs the reason once and does nothing. Pin
the source with `"gh"` or `"env"`.

Identity comes from the credential, not from config: one `GET /user` gives the
login that names the directory and the numeric id that goes in the file, because
a login can be renamed and an id cannot. Nothing to typo, and no way to publish
as somebody else.

A `gh` token usually carries broad `repo` scope, which is wider than this needs.
Nothing here can narrow a token at use time, so `bedrouter doctor` reports the
source, the identity and the scopes instead, and the only path bedrouter ever
writes is the one it builds itself. For least privilege, use a fine-grained PAT
with `contents: write` on the stats repository alone and set `"credential":
"env"`.

### What is published, and what never is

Token counts, never dollars. Savings computed on each laptop would depend on
that machine's prices and how stale its config is, so the aggregate would sum
numbers that were not computed the same way. The team page prices everything
from one `prices.json` in the stats repository, so every person's numbers are
comparable and a price correction re-prices every past day at once.

A day file holds counts and sums grouped by routed rung and by requested rung,
plus class counts, classifier call count, escalation counts, and error counts by
class. It contains no array at all.

Never published: `classifierNote`, `conversationKey`, `sessionKey`, error text,
and anything per request. `dailyRollup()` builds the payload from an allowlist,
so a field added to the log is excluded until somebody adds it there on purpose,
and `test/publish.test.ts` holds it to a fixture line carrying every forbidden
field.

A day file still shows that a named person worked on a given date and roughly how
much. In a public stats repository that is world-readable. It is inherent to
per-person daily stats, and the stats repository's README says so on its face.

Only closed UTC days are published, so a file is complete when written and never
needs an update. Late lines for an already-published day are dropped rather than
rewriting history.

## Logs

Every request appends one JSON line to `BEDROUTER_LOG` (default
`./bedrouter.log.jsonl`). Along with tokens, cost, latency, and outcome, each
line records `vendor`, `eligibleCount`, `skipped[]`, `degraded[]`,
`requestedCostUsd`, `class`, `classReason`, `sticky`, `escalated`,
`escalationReason`, `conversationKey`, `sessionKey`, and, when the classifier
ran, `classifierNote`, `classifierMs`, and `classifierCostUsd`.

## Development

```sh
npm test
npm run typecheck
npm run build
```
