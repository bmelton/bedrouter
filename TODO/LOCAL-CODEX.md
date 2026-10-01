# Feature: second provider (local Codex over OAuth)

- [x] Spike: verify the Codex Responses endpoint accepts third-party tool definitions and streaming (go/no-go)
- [x] Spike: confirm token location, refresh flow, and what quota exhaustion returns
      (**GO**, with three design changes. See "Spike results" below before doing anything else.)
- [x] Settle the seat question: per-developer local only, or shareable (settled below: local, per developer)
- [x] Rename `bedrockId` to `modelId` (mechanical, own commit)
- [x] Add `auth` to the rung, with a resolver table (`aws-default-chain`, `oauth-file`)
- [x] Add `transport: "openai-responses"` and dispatch on transport in `server.ts`
- [x] Write `openaiToResponses` / `responsesToOpenai` plus stream event mapping
- [x] Make `Router.unavailable` time-boxed (`Map<alias, untilMs>`)
- [x] Classify Codex errors as rung-fatal, quota, or capability
- [x] Count tokens per provider in `report.ts` and `/v1/conversations/:key`
- [x] Extend `doctor` and `preflight` to check the Codex credential
- [x] Add a `codex` rung to `bedrouter.example.json`, disabled by default

## Goal

bedrouter keeps its name and its job. It gains a second provider so that a
corporate ChatGPT Enterprise allocation, which is prepaid and therefore free at
the margin, is consumed before any Bedrock rung bills a dollar. Capability is
never traded for price: a request goes to a free rung only when that rung can
actually serve it.

## What does not change

The router already does this. `Router.ranked` sorts the stack by
`effectiveInputPerM`, and `eligible()` filters by `serves` and by capability
before price is ever compared. A free rung is a rung with `inputPerM: 0` and
`outputPerM: 0`. It sorts first, and it still has to pass `toolUse`,
`contextWindow`, `maxOutput`, `streaming`, and the rest.

So there is no cost-bucket field and no routing preference mode. A second
ranking system that competed with `Router.ranked` would contradict the rule in
AGENTS.md that everything comparing rung positions uses `Router.ranked`. Price 0
plus the existing ranking is the whole routing feature.

Escalation, stickiness, class decay, the classifier, and the `degrade:<class>`
fallback all stay as they are.

## Design

### Rung shape

Two fields carry the change. `capabilities.transport` already exists as a
discriminator with a single value, so the config shape survives:

    "transport": "bedrock-runtime" | "openai-responses"
    "api":       "converse" | "responses"

`bedrockId` becomes wrong the moment a rung is not on Bedrock. Rename it to
`modelId` across `config.ts`, `server.ts`, `report.ts`, `smoke.ts`, and the
example config. Mechanical, no behaviour change, its own commit so the real diff
stays readable.

### Authentication

Credentials become a per-rung property rather than a global assumption, because
there are now two genuinely different mechanisms and there will be more:

    "auth": { "kind": "aws-default-chain" }
    "auth": { "kind": "oauth-file", "path": "~/.codex/auth.json" }

A resolver table maps `kind` to a function that returns what the transport needs:
credentials for the AWS SDK, an `Authorization` header for HTTP. A table with two
entries, not a plugin system. A third kind (a bearer token named by an env var,
for a provider that issues static keys) is added when a provider needs it, not
before.

Two constraints hold:

- For Bedrock rungs the AGENTS.md rule is unchanged. `aws-default-chain` is the
  SDK default chain and nothing else. `AWS_PROFILE` in `.env` stays the
  per-machine switch. No bespoke AWS credential path is added.
- No secret value is written into config, code, or tests. `oauth-file` names a
  path that the `codex` CLI already maintains. bedrouter reads that file and
  refreshes the token when it is stale. bedrouter does not implement a login
  flow: when the credential is missing or unrecoverable, `doctor` tells the user
  to run `codex login`, in the same way `preflight.ts` reports an SSO error.

### Transport

`server.ts` dispatches on `rung.capabilities.transport`. The Bedrock path is
untouched. The new path is plain `fetch` with SSE, so the single-runtime-dep rule
holds.

The Codex backend speaks the Responses API, so `translate.ts` gains a second pair
beside the Converse pair: `openaiToResponses`, `responsesToOpenai`, and a stream
event mapper next to `converseEventToOpenai`. Both stay pure and unit tested.
This is the bulk of the work. The existing Converse pair is 227 lines with
streaming included, which is the right order of magnitude to expect.

The Anthropic-shape `InvokeModel` path in `POST /v1/messages` is not extended.
Cross-vendor traffic already goes through the OpenAI chat shape, and that is the
path a Codex rung serves.

### Quota exhaustion

An allocation that runs out looks exactly like the rung-fatal errors already
handled, except that it comes back. `Router.unavailable` changes from
`Set<string>` to `Map<string, number>`, holding the epoch time at which the rung
becomes eligible again. `markUnavailable(alias, untilMs = Infinity)` keeps the
current permanent behaviour for the Bedrock entitlement verdicts, which are per
(account, region, rung) and never expire. `eligible()` skips a rung while
`now < until` and reports `unavailable` as it does today.

Error classification on the Codex path:

| Response | Meaning | Action |
|---|---|---|
| 401 / 403 | Credential is dead | Rung-fatal until the token refreshes |
| 429 | Allocation spent or rate limited | Unavailable until `Retry-After`, or a short default |
| 400 contradicting a capability | Config claims a capability the rung lacks | Same as `validation-contradiction` today |

The existing retry machinery then answers the same request on the next eligible
rung, which is the cheapest Bedrock rung that serves the class. Free first,
Bedrock after, with no new concept and no operator action.

### Accounting

`inputPerM: 0` is correct for ranking and wrong for reporting. A zero-cost rung
would make `report.ts` and `/v1/conversations/:key` show `$0.00` while the
monthly allocation drains invisibly, and the first visible signal would be the
429.

So usage is tallied in tokens per provider alongside the dollar estimate. Free is
not cheap, it is a different unit, and both units are reported. The
`x-bedrouter-*` response headers gain the provider, so pi-bedrouter's footer can
show which pool paid for the turn. The header set stays otherwise stable.

No configured allocation budget. Declaring the monthly limit in config would
duplicate state the provider owns and would drift out of date. The 429 is
authoritative.

## Spike results, 2026-09-16

Run against a live account from a plain `fetch`, not the Codex client. Endpoint:

    POST https://chatgpt.com/backend-api/codex/responses

Verdict: **go.** Third-party tool definitions survive, and a 40-tool surface
behaves. Three findings change the design below, and one changes the premise.

### 1. Tools pass through, at Pi's scale

One tool definition returns a `function_call` item with the arguments streamed as
`response.function_call_arguments.delta` and closed by `.done`, in a shape
`responsesToOpenai` can map directly. A 40-tool surface costs 1471 input tokens
and calls the right tool by name. A `function_call_output` turn is accepted, so
the second agent turn round-trips.

`tool_mode: "code_mode_only"` in `~/.codex/models_cache.json` is a client-side
hint, not a server restriction: `gpt-5.6-sol` and `gpt-6-astra` carry it and both
accepted arbitrary tools anyway.

This was the question that could have killed the feature. It did not.

A full agent loop was then run through bedrouter itself: turn one returned a
`read_file` tool call, turn two fed the result back as a `tool` message and got a
coherent answer, both on `codex`. Image input was verified the same way, with a
64x64 half-red half-blue PNG that the model described correctly, so
`imageInput: true` is a measurement rather than a guess. The content part must be
`{"type":"input_image","image_url":"data:..."}` with the URL as a **string**: the
chat-completions shape, `image_url: {url}`, is refused with a 400.

### 2. Streaming is mandatory, not a capability

    {"detail": "Stream must be set to true"}   // 400

`stream: false` is refused outright. So `capabilities.streaming` is always true
for a Codex rung, and a non-streaming client request cannot be passed through:
the transport must consume the SSE stream and assemble one response. That is work
the Converse path never needed, because Bedrock offers both shapes.

### 3. `max_output_tokens` is unsupported

    {"detail": "Unsupported parameter: max_output_tokens"}   // 400

This contradicts the rule in AGENTS.md that the client's cap is a ceiling to be
honoured or clamped. On this transport it can be neither: the field has to be
**dropped**, and `forRung` must learn the difference between clamping a cap and
removing one. A Codex rung's `capabilities.maxOutput` is therefore not a number
the client can influence, and recording a real one requires measuring where the
model stops on its own.

### 4. Quota is observable before it runs out

Every 200 carries the allocation state, so waiting for a 429 is unnecessary:

| Header | Value seen |
| --- | --- |
| `x-codex-plan-type` | `plus` |
| `x-codex-primary-used-percent` / `-window-minutes` | `0` / `300` (a 5-hour window) |
| `x-codex-secondary-used-percent` / `-window-minutes` | `15` / `10080` (a 7-day window) |
| `x-codex-primary-reset-after-seconds` / `-reset-at` | `17944` / epoch |
| `x-codex-credits-balance`, `-has-credits`, `-unlimited` | `0`, `False`, `False` |

`markUnavailable(alias, untilMs)` can therefore be fed `reset-after-seconds`
directly, and a rung can be stood down *before* exhaustion by reading
`used-percent`. **The 429 body itself is still unverified**, because triggering
it means spending the whole allocation. The headers make that unnecessary rather
than answering it.

### 5. Two error shapes, not one

    400  {"detail": "..."}                                        parameter or model problem
    401  {"error": {"message": "...", "code": "unauthorized_unknown"}, "status": 401}

An unusable model id is a 400 with a readable `detail`
("The 'x' model is not supported when using Codex with a ChatGPT account"), not
the Bedrock-style split between `ValidationException` and `AccessDeniedException`.
Error classification needs both shapes.

### 6. The credential, confirmed

`~/.codex/auth.json` holds `tokens.{id_token, access_token, refresh_token,
account_id}` plus `last_refresh`, and `auth_mode: "chatgpt"`. The access token is
a JWT for `https://api.openai.com/v1` with a **240 hour** lifetime, so a refresh
is due roughly every ten days rather than hourly. The `chatgpt-account-id` header
turns out to be optional: a request without it still returned 200.

### 7. The premise changed: this is a Plus plan, not Enterprise

The goal above says the point is consuming a prepaid **ChatGPT Enterprise**
allocation. The account that answered this spike reports `x-codex-plan-type:
plus`, with 15% of a weekly window already spent and no credit balance. A
personal Plus subscription is still prepaid, so "free at the margin" holds, but
the allocation is far smaller than the goal assumes and the seat question below
is no longer about a corporate entitlement.

### Models

All seven report `context_window: 272000` and `max_context_window: 872000`.
`gpt-5.5` is the only one whose `tool_mode` is unset; the rest are
`code_mode_only`, which the spike showed does not restrict tools.

| Slug | Visible | Notes |
| --- | --- | --- |
| `gpt-5.6-sol` | yes | The configured default in `~/.codex/config.toml` |
| `gpt-6-astra` | yes | |
| `gpt-5.6-terra`, `gpt-5.6-luna` | yes | |
| `gpt-5.5` | yes | Only model without `code_mode_only` |
| `gpt-reserve`, `codex-auto-review` | hidden | `visibility: hide` |

## Verification, before any translator is written

The go/no-go is one script. Send a request carrying a real tool definition to the
Codex Responses endpoint, with a Codex OAuth token, from something that is not
the Codex client. Then check:

1. Do arbitrary tool definitions survive, and do tool calls come back in a shape
   `responsesToOpenai` can map? Pi always sends tools. If tools do not pass
   through, the rung fails `toolUse` for the traffic that matters and this
   feature is dead. AGENTS.md records what a wrong capability flag costs.
2. Does streaming work, and what do the SSE events look like?
3. Which model IDs are reachable, and what are their real `contextWindow` and
   `maxOutput` values? These go in the config as verified facts, not guesses.
4. What does exhaustion return: status, headers, and whether a reset time is
   given.
5. Where the token lives and how refresh works. The assumption is
   `~/.codex/auth.json` with an access token, a refresh token, and an account
   identifier, but this is unverified.

## Settled: seats, 2026-09-16

**Local, per developer.** Each machine reads its own `~/.codex/auth.json`, which
its own `codex login` maintains. No shared bedrouter serves a team from one
token, and nothing in the code makes that possible: the credential is read from a
file path on the machine, never from config or an environment secret.

The `codex` rung ships `enabled: false`, so turning it on is a deliberate local
act. That holds whether the seat is a personal Plus subscription, as on the
machine that ran the spike, or a corporate Enterprise seat on another machine.
The design is identical either way; only the size of the allocation differs, and
the router reads that from the response rather than from config.

## Implementation notes, beyond the design above

Four places where what was built differs from what was written, each because the
spike said so:

- **No token refresh.** The access token lasts 240 hours and the Codex CLI
  rewrites `auth.json` when it refreshes, so bedrouter re-reads the file and gets
  the new token for free. An expired token is detected locally from the JWT
  `exp`, before any request is sent, and the rung stands down for five minutes
  with a message naming `codex login`. Implementing the OAuth refresh would mean
  bedrouter holding a client secret, which the "no credential storage of our own"
  rule forbids.
- **Quota is read, not awaited.** `routing.quotaStandDownPercent` (default 90)
  stands a rung down when either allocation window passes it, using the reset
  time the response already carries. The 429 path remains as the backstop.
- **The output cap is dropped, not clamped.** `forRung` gained a third behaviour
  and `eligible()` records `drop-maxTokens` rather than `clamp-maxTokens`.
- **Non-streaming is assembled.** `collectChunks()` folds the chunk stream back
  into one `chat.completion`, because the endpoint refuses `stream: false`.

Verified end to end on 2026-09-16: a live request through bedrouter routed to
`codex`, returned a mapped `get_weather` tool call on both the streaming and the
non-streaming path, logged `provider=codex`, `costUsd=0`, 60 input and 19 output
tokens, `quotaPercent=15`, and `degraded=["codex:drop-maxTokens"]`.

## Superseded: the original seat question

A ChatGPT Enterprise entitlement is per seat, and the Codex endpoint exists for
that person's Codex client. A bedrouter on a developer's own machine, reading
that developer's own token, is a defensible reading of the entitlement. One
shared bedrouter serving a team from a single token is seat sharing, and it
becomes a problem at the moment the team depends on it.

Assumption taken here: local, per developer. Everything above works either way,
but the decision belongs on the record before the rung ships enabled. Ship the
`codex` rung `enabled: false` in `bedrouter.example.json` so that enabling it is
a deliberate local act.

## Out of scope

- No cost buckets and no routing preference modes. Price 0 plus `Router.ranked`
  covers the requirement.
- The classifier stays on the cheap Bedrock rung. Routing it to Codex would add
  latency and spend the scarce allocation on a routing decision rather than on
  the user's work.
- No login flow, no token minting, no credential storage of our own.
- No third provider. The `auth` and `transport` tables take a new entry when a
  third provider is real.
