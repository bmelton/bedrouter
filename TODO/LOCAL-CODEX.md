# Feature: second provider (local Codex over OAuth)

- [ ] Spike: verify the Codex Responses endpoint accepts third-party tool definitions and streaming (go/no-go)
- [ ] Spike: confirm token location, refresh flow, and what quota exhaustion returns
- [ ] Settle the seat question: per-developer local only, or shareable
- [ ] Rename `bedrockId` to `modelId` (mechanical, own commit)
- [ ] Add `auth` to the rung, with a resolver table (`aws-default-chain`, `oauth-file`)
- [ ] Add `transport: "openai-responses"` and dispatch on transport in `server.ts`
- [ ] Write `openaiToResponses` / `responsesToOpenai` plus stream event mapping
- [ ] Make `Router.unavailable` time-boxed (`Map<alias, untilMs>`)
- [ ] Classify Codex errors as rung-fatal, quota, or capability
- [ ] Count tokens per provider in `report.ts` and `/v1/conversations/:key`
- [ ] Extend `doctor` and `preflight` to check the Codex credential
- [ ] Add a `codex` rung to `bedrouter.example.json`, disabled by default

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

## Open question: seats

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
