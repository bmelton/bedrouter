# Build order for the bedrouter backlog

> Status: the plan, not a feature. It sequences the three specs in `TODO/` and
> owns the decisions that span them: the GitHub credential, the price source of
> truth, the `publish` config block, and the two places `bedrockId` is spelled.
> It holds no design of its own. Each feature lives in its own document and this
> file links to it.
>
> Installer work lands in the separate `HABLO-installer` repository. That
> repository's own `TODO/PLAN.md` gets one line pointing here.

- [x] **Wave 1** [PRICE-DASHBOARD.md](PRICE-DASHBOARD.md) (9 items, bedrouter only, ships as 0.7.0)
- [x] **Wave 2a** [TEAM-STATS.md](TEAM-STATS.md) (11 items, bedrouter plus a new stats repository, ships as 0.8.0)
- [x] **Wave 2b** HABLO-installer: render the `publish` block, no user input for shared values (9 items, below)
- [x] **Wave 3** [LOCAL-CODEX.md](LOCAL-CODEX.md) (13 items; the spikes said go, with three design changes)
- [x] Plan-owned: the credential resolver, `bedrouter doctor` reporting it (below)
- [x] Plan-owned: `prices.json` drift check in `rollup` (below)
- [x] Plan-owned: `modelId` accepted beside `bedrockId` for one minor version (below, landed with wave 3)
- [x] Plan-owned: `Taskfile.yml` with a `secrets` task (below)

33 feature items plus 4 plan-owned decisions. The count is the only size signal
here. It is not an estimate of time.

> All four waves are code-complete on branch `feat/dashboard-and-team-stats`
> (and `feat/team-stats-publish` in HABLO-installer), with 52 bedrouter tests and
> 3 new installer tests passing. Nothing is pushed and nothing is published.
> [TODO.md](TODO.md) holds every remaining action that needs a person.
>
> The Codex spikes ran on 2026-09-16 and returned **go**, but changed three
> things the design had assumed. They are recorded in
> [LOCAL-CODEX.md](LOCAL-CODEX.md) under "Spike results" and summarised under
> "Implementation notes".

## The shape of it

```
wave 1   PRICE-DASHBOARD ──┐  defines aggregate() and the view model
                           │
wave 2a  TEAM-STATS ───────┤  reuses aggregate(); adds publish + rollup
wave 2b  HABLO-installer ──┘  renders the publish block it just defined
                              (2b cannot start before 2a settles the shape)

         LOCAL-CODEX spikes 1 and 2  ── run from day one, in parallel
wave 3   LOCAL-CODEX rest ─────────── gated on the spike verdict
```

**The dashboard comes first, and not because it is smaller.** It defines
`aggregate()`, the two baselines, and the view model. TEAM-STATS renders the
same view model from merged data and reuses the same redaction rules. Building
the stats feature first means writing the pricing logic twice and then merging
two versions of it, which is the expensive part.

**Wave 2b cannot lead wave 2a.** The installer renders `bedrouter.json`. It
cannot render a `publish` block whose keys are not yet decided. The two land in
one wave, in that order.

**The Codex spikes are not in a wave.** Items 1 and 2 of
[LOCAL-CODEX.md](LOCAL-CODEX.md) are a go/no-go script. They touch no file that
waves 1 and 2 touch, and they answer whether a free rung exists at all, which
changes what the savings numbers mean. Run them whenever there is an hour.
Everything else in that document waits for the verdict.

## Plan-owned decision: the GitHub credential

`gh` first, a fine-grained PAT second, resolved once per process.

1. If `gh` is on `PATH` and `gh auth token --hostname github.com` returns a
   token, use it.
2. Otherwise use `BEDROUTER_PUBLISH_TOKEN` from the environment or `.env`.
3. With neither, publishing is a no-op that logs the reason once per process.
   It is never fatal and never blocks a request.

`gh` is already a firstmate requirement in `hablo.json`, so on a HABLO machine
step 1 almost always succeeds and no developer creates a token by hand. The
hostname is pinned because a work machine may hold a GitHub Enterprise session
that cannot write to a public github.com repository.

Identity stays as [TEAM-STATS.md](TEAM-STATS.md) specifies: one `GET /user`
with whichever token was resolved, cached for the process. One code path, no
`gh api` branch.

**The cost of choosing `gh`.** A `gh` token normally carries the broad `repo`
scope, not the `contents: write` on one repository that the spec asked for. So
bedrouter can write anywhere the developer can. Two cheap mitigations, both
plan-owned:

- `dailyRollup()` builds the path, and the publisher issues `PUT` to
  `data/<login>/<date>.json` and nothing else. The path is not configurable.
- `bedrouter doctor` prints the credential source (`gh` or `env`) and the
  scopes from the `x-oauth-scopes` response header on `GET /user`, so an
  over-scoped token is visible rather than assumed.

`publish.credential` in `bedrouter.json` takes `auto` (the default above), `gh`,
or `env`, so a developer who wants the narrow PAT can pin it.

```
// ponytail: scope is reported, not enforced. GitHub has no way to narrow a
// token at use time, so the ceiling is the token the developer already holds.
```

## Plan-owned decision: where prices live

`prices.json` in the stats repository is the single source of truth for the team
page, exactly as [TEAM-STATS.md](TEAM-STATS.md) argues. It is a hand-made
extract of the `stack` in the team's `hablo.json`: one entry per alias, with
`inputPerM` and `outputPerM`. AWS prices change a few times a year, so a
generator is not worth owning.

The drift that matters is silent, so `bedrouter rollup` fails the build when a
day file names an alias that `prices.json` does not hold, and names the alias in
the error. A new rung therefore stops the team page until somebody prices it,
rather than quietly dropping that rung's spend from the totals.

This is the one place where the plan adds a rule the feature documents do not
already carry.

## Plan-owned decision: `bedrockId` and `modelId`

[LOCAL-CODEX.md](LOCAL-CODEX.md) renames `bedrockId` to `modelId`. That field is
also written by `install.mjs` and stored in `hablo.json`, in both the `stack`
and the entitlement probe. A rename in one repository breaks the other.

So: `config.ts` reads `modelId ?? bedrockId` for one minor version. The
installer switches `hablo.json` and the probe in the same release. The fallback
is deleted one release later, with a `ponytail:` comment naming that release so
it does not become permanent.

The rename keeps its own commit, as the document says.

## Plan-owned decision: the Taskfile

bedrouter runs on npm scripts today and has no `Taskfile.yml`. Wave 2a adds
`BEDROUTER_PUBLISH_TOKEN` to Infisical, which needs a `secrets` task to pull it
into `.env`. Add `Taskfile.yml` with `secrets`, `build`, `test`, and
`typecheck`, delegating to the existing npm scripts rather than replacing them.

This is a wave 2a item, not a separate wave. The PAT is the fallback path, so
this blocks nothing on a machine with `gh`.

## Wave 2b: HABLO-installer

The split the team rollout depends on: shared values are committed, personal
values are resolved on the machine.

**Shared, in `hablo.json`, needing no user input:**

```
"bedrouter": {
  "routing": { "baselineAlias": "opus" },
  "publish": {
    "enabled": true,
    "repo": "acme/bedrouter-stats",
    "branch": "main",
    "intervalMs": 3600000,
    "credential": "auto"
  }
}
```

**Personal, never committed:** the token. Resolved from `gh` on the machine, or
from `BEDROUTER_PUBLISH_TOKEN` in `~/.bedrouter/.env`. This is the same split
`jira.envSource` already makes, and it needs no new mechanism.

- [x] Add `bedrouter.publish` and `bedrouter.routing.baselineAlias` to `hablo.json`
- [x] Step 4: render both into `~/.bedrouter/bedrouter.json` from the manifest
- [x] Step 4: print what leaves the machine, to which repository, and the flag that turns it off
- [x] Add `--skip-publish` and `--publish-repo <owner/name>` to `install.mjs`
- [x] Add `--publish-cred gh|env|auto` so an unattended run answers the credential question
- [x] When stdin is a TTY, `gh` is authenticated, and `--publish-cred` is absent: ask once, then record the answer in `bedrouter.json`
- [x] Step 4: report the resolved credential source, or say that publishing is configured but has no credential yet
- [x] README: one options-table row per new flag, and the shared-versus-personal split in prose
- [x] Three tests in `test/install.test.mjs`: off by default, rendered when named, never asked when unattended

A non-interactive run never blocks. With no TTY and no flag, the installer takes
`auto`, prints the source it found, and continues.

Three things come for free and need no item. `writeJson` already records every
key it renders into the receipt, so uninstall reverses the `publish` block with
no new code. `~/.bedrouter/.env` and `bedrouter.json` are already in
`backup.essentials`, so the PAT path is already archived. `loadConfig` validates
only `stack`, so a manifest that renders a `publish` block into an older
bedrouter is inert rather than broken, and no version gate is needed.

## Releases

| Release | Contents |
| --- | --- |
| `bedrouter@0.7.0` | The dashboard, `report --html`, `routing.baselineAlias` |
| `bedrouter@0.8.0` | `publish`, `rollup`, the credential resolver, the Taskfile |
| HABLO-installer | Wave 2b, after 0.8.0 is on npm |

The stats repository is created during wave 2a, before the first publish, and
its `README` states plainly what a public per-person daily file reveals.

## What this plan does not cover

- **Log rotation.** `bedrouter.log.jsonl` has none. The dashboard is the thing
  that will make an unbounded log visible, and both documents say so. It is its
  own change, it blocks neither wave, and it gets its own document when the file
  size makes the case.
- **Anything in the three feature documents' "Not doing" sections.** A server,
  a database, per-request data leaving a machine, budgets, alerts, realtime,
  cost buckets, and routing preference modes all stay out.
- **The Codex seat question.** [LOCAL-CODEX.md](LOCAL-CODEX.md) assumes local
  and per-developer, and ships the rung `enabled: false`. The assumption holds
  until the spike says otherwise. Nothing in waves 1 and 2 depends on it.
