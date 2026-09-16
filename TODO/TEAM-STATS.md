# Feature: team stats publishing

- [ ] Add an opt-in `publish` block to the config; absent means off
- [ ] Write `dailyRollup(lines, date)` in `src/publish.ts`: pure, returns the day file
- [ ] Resolve identity from the token with one `GET /user` call, cached for the process
- [ ] Write the contents API PUT with 409 retry and jitter
- [ ] Publish only closed UTC days, and only days with no file already present
- [ ] Add `bedrouter publish [--since] [--dry-run]` and an hourly in-process check
- [ ] Add `bedrouter rollup <dir> --prices <file> --out <dir>` for the stats repo Action
- [ ] Add `test/publish.test.ts` over `dailyRollup()` and `mergeIndex()`, including the redaction assertions
- [ ] Create the stats repo: `prices.json`, the workflow, the page, and a README explaining the numbers
- [ ] Add `BEDROUTER_PUBLISH_TOKEN` to Infisical, and document the PAT scope in the README

Depends on the aggregation and pricing model in [PRICE-DASHBOARD.md](PRICE-DASHBOARD.md).
The team page renders the same view model from merged data.

## Goal

Each developer's bedrouter publishes one small file per day to a shared public
repository. A GitHub Action merges those files into one page that shows what the
team spent, what the same work would have cost without the router, and how that
splits by person. No server, no database, and no service to operate.

## Shape

Each laptop writes exactly one path:

    data/<github-login>/2026-09-16.json

One writer per path, and each path is written once. That property is what makes
every other simplification in this document safe.

The stats repo holds raw day files, one `prices.json`, a page source, and a
workflow. It holds no generated file at all: the Action builds `index.json` into
the Pages artifact and deploys it, so nothing derived is ever committed and the
Action never races a publisher. A generated README table is possible but
reintroduces a committed derived file and the conflict class that goes with it,
so it stays out unless somebody asks.

Public repo means GitHub Pages is free and the page needs no auth to read its
own data.

## Writing

One `PUT /repos/{owner}/{repo}/contents/data/{login}/{date}.json` per day file.

Concurrent publishers do not clobber each other. The contents API commits with
the branch tip it read as the parent and updates the ref without force, and a
ref update is compare-and-swap, so a publisher that loses the race gets `409
Conflict` and no commit is lost. The retry re-reads the tip and re-PUTs. Because
two publishers never touch the same path, the retry has no content to reconcile
and succeeds on the next attempt.

Five attempts, exponential backoff with jitter, then give up and try again on the
next interval. A failed publish is never fatal and never blocks a request.

The publish job also jitters its start time. Ten laptops that all publish at
exactly 00:05 turn a rare collision into a reliable one.

## What is published

Token counts, never dollars. Savings computed on each laptop would depend on that
machine's prices, its `baselineAlias`, and how stale its config is, so the
aggregate would sum numbers that were not computed the same way. The page prices
everything from the single `prices.json` in the repo, which means the numbers are
comparable across people and a price correction re-prices every past day for
everybody at once. This is the same choice as the render-time baseline in
PRICE-DASHBOARD.md, for the same reason.

    {
      "schema": 1,
      "user": "bmelton", "userId": 12345,
      "date": "2026-09-16",
      "bedrouter": "0.6.0",
      "routed":    { "gpt-oss-120b": { "requests": 505, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 } },
      "requested": { "gpt-oss-20b":  { "requests": 505, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 } },
      "classes":   { "explore": 469, "execute": 233, "trivial": 7 },
      "classifier": { "rung": "haiku", "calls": 12, "inputTokens": 0, "outputTokens": 0 },
      "escalations": { "retry": 3 },
      "errors": { "rung-fatal": 4, "other": 2 }
    }

Tokens appear twice, grouped by routed rung and by requested rung. The page needs
both to price the actual spend and the asked-for baseline. The native baseline
needs only the routed totals, priced at one configured rung.

A day file is a few hundred bytes. Ten people for a year is about 3,600 files,
which the Action reads in one pass.

    // ponytail: the rollup reads every day file each build. Pre-roll into
    // monthly files if this passes a few thousand.

## What is never published

The repo is public, so this list is the feature, not a footnote.

- `classifierNote`. Free text written by a model about a prompt, and therefore
  capable of quoting one.
- `conversationKey`. A hash of the system prompt plus the first user turn, so it
  is a fingerprint that can confirm a guessed prompt.
- `sessionKey`. Client-supplied, and clients name sessions after branches,
  tickets, and paths.
- Error text. The log holds AWS messages such as "not available for this
  account". Publish counts by error class instead.
- Anything per request. The file has no array in it. Only counts and sums leave
  the machine.

`dailyRollup()` builds the payload from an allowlist of fields, so a new log
field is excluded until somebody adds it on purpose. The test asserts that a
fixture line carrying all five forbidden fields produces a payload whose
serialized form contains none of them.

A day file still reveals that a named person worked on a given date and roughly
how much. That is inherent to per-person daily stats in a public repo, it was
chosen deliberately, and it is stated on the page so nobody discovers it later.

## Identity and credentials

A fine-grained PAT per developer, `contents: write` on the one stats repo and
nothing else. On the first publish of a process, `GET /user` returns `login` and
`id`. The login is the directory name, because GitHub logins are already
slug-safe and need no encoding. The numeric id goes in the file, because a login
can be renamed and the id cannot.

Identity is therefore derived from the credential rather than configured. Nothing
to typo, and no way to publish as somebody else.

The token loads from the environment as `BEDROUTER_PUBLISH_TOKEN`, from `.env`,
populated from Infisical. It never appears in `bedrouter.json`. Add it to the
app's Infisical store before this ships.

## Configuration

Absent block means the feature is off. Nothing leaves a machine without an
explicit opt-in.

    "publish": {
      "enabled": true,
      "repo": "acme/bedrouter-stats",
      "branch": "main",
      "intervalMs": 3600000
    }

## Scheduling and backfill

The running server checks hourly. It lists the closed UTC days present in the
local log, skips any day that already has a file in the repo, and publishes the
rest oldest first. Backfill is not a separate feature: a laptop that was off for
a week publishes seven files on its next check.

Only closed UTC days are published, so a file is complete when written and never
needs an update. If late lines arrive for an already-published day, they are
dropped and counted locally rather than rewriting history.

    // ponytail: a published day is final. Add sha-based overwrite if late lines
    // turn out to matter.

`bedrouter publish --dry-run` prints the payloads without writing, which is also
how somebody checks what the redaction rules actually emit before opting in.

## Rollup

The stats repo's workflow runs `npx bedrouter rollup data/ --prices prices.json
--out dist/` and deploys `dist/` to Pages. All the logic lives here and is tested
here, so the stats repo is data, one workflow file, and a page.

The rollup validates each file against the schema and skips malformed ones,
naming them in the build log rather than failing the build. One person's bad file
cannot break the team page. It also ignores any file whose `user` field does not
match its own directory, which is a cheap integrity check on a public repo with
direct push.

## Test

`dailyRollup()` and `mergeIndex()` are pure and take arrays, so one test file
covers both: totals, the routed and requested groupings, the redaction
assertions, a malformed file that gets skipped, and a file whose `user` field
disagrees with its path.

The 409 retry is worth one real check before the first publish: two concurrent
PUTs to different paths on the same branch in a scratch repo, asserting both
files exist afterward and that one call returned 409.

## Not doing

- A server, a database, or an ingest endpoint.
- Per-request data leaving the machine, in any form, ever.
- Realtime. A day closes, then it publishes.
- Budgets, quotas, or alerts.
- Editing or deleting published days from a laptop. Removing a day is a commit in
  the stats repo, made by a person.
