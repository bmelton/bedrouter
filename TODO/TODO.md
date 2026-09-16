# Actions that need a person

Everything in [PLAN.md](PLAN.md) waves 1, 2a and 2b is written and tested.
Nothing below could be done without a credential, an account, or a decision that
is not mine to make. Ordered so that each item unblocks the ones under it.

- [ ] 1. Create the stats repository on GitHub and push the scaffold
- [ ] 2. Turn on GitHub Pages for it
- [ ] 3. Name the repository in `hablo.json`, and set `enabled: true`
- [ ] 4. Add `BEDROUTER_PUBLISH_TOKEN` to Infisical
- [ ] 5. Check the 409 retry against a real repository, once, before the first publish
- [ ] 6. Publish `bedrouter@0.8.0` to npm
- [ ] 7. Decide the team `baselineAlias`
- [ ] 8. Run the Codex spikes, which gate wave 3
- [ ] 9. Two pre-existing HABLO-installer problems, neither mine

## 1. Create the stats repository and push it

A scaffold is committed at `~/projects/ai/bedrouter-stats`, one commit, no
remote. It holds `prices.json` (16 rungs, extracted from the stack in
`hablo.json`), the Pages workflow, a README, and an empty `data/`.

I did not create the repository. It has to be public for free Pages, and
publishing a repository under your account or your organisation is your call,
not mine.

```sh
cd ~/projects/ai/bedrouter-stats
gh repo create <owner>/bedrouter-stats --public --source=. --push
```

Read `README.md` in that repository first. It states plainly what a public
per-person daily file reveals: that a named person worked on a given date and
roughly how much.

## 2. Turn on GitHub Pages

Settings -> Pages -> Source: **GitHub Actions**. The workflow deploys `dist/`
as an artifact and commits nothing, so no build can race a publisher.

## 3. Name the repository in the manifest

In `~/projects/ai/HABLO-installer/hablo.json`, under `bedrouter.publish`:

```json
"enabled": true,
"repo": "<owner>/bedrouter-stats"
```

This is the shared half of the split. Commit it once and every `./install.sh`
on the team renders it with no user input. Until then publishing is off
everywhere, which is why I left `repo` as `null`.

Verify with `./install.sh --dry-run`, which prints what would leave the machine.

## 4. Add `BEDROUTER_PUBLISH_TOKEN` to Infisical

This is the fallback credential, for machines without `gh`. I did not generate a
value and there is no placeholder anywhere in the tree.

- Scope: a fine-grained PAT, `contents: write` on the stats repository and
  nothing else.
- `Taskfile.yml` now has a `secrets` task that runs `infisical export` into
  `.env`. It assumes this repository is linked to an Infisical project. If it is
  not, that link is part of this item.

A machine with `gh` authenticated for github.com needs none of this.

## 5. Check the 409 retry for real

TEAM-STATS.md asks for one live check before the first publish, and it is the
one part of the publish path a unit test cannot reach. In a scratch repository:

two concurrent `PUT`s to different paths on the same branch, asserting both
files exist afterwards and that one call returned 409.

The retry is five attempts with exponential backoff and jitter, in `putDayFile`.

## 6. Publish `bedrouter@0.8.0`

`package.json` is bumped to 0.8.0. The plan called for 0.7.0 (dashboard) and
0.8.0 (publish) as two releases; both waves landed in one pass, so one version
carries them.

Publication needs `npm login`. HABLO's own plan records `npm whoami` returning
E401 on this machine as of 2026-09-13, so that is likely still true.

Until 0.8.0 is on npm, `.github/workflows/pages.yml` in the stats repository
pins a version that does not exist and the page build will fail. The pin is
deliberate: a page rebuild should be reproducible and an upgrade should be a
reviewable diff.

## 7. Decide the team `baselineAlias`

`hablo.json` has `"baselineAlias": null`, which resolves to the dearest enabled
rung that serves `explore`. On the current stack that is `opus`, and it gives
96.4% savings against the real 715-line log.

That default is defensible, but it is a claim about what the team would have used
without a router, so it is worth an explicit decision. Set it to a named rung if
`opus` overstates the counterfactual.

## 8. Run the Codex spikes

Wave 3 is gated on items 1 and 2 of [LOCAL-CODEX.md](LOCAL-CODEX.md), which need
a Codex OAuth token at `~/.codex/auth.json` and live calls to a third-party
endpoint. I did not attempt either.

The `bedrockId` to `modelId` rename is the only plan-owned decision still open,
and it belongs to that wave. `config.ts` must read `modelId ?? bedrockId` for one
minor version, because `install.mjs` and `hablo.json` both write `bedrockId` and
a rename in one repository breaks the other.

## 9. Two pre-existing HABLO-installer problems

Neither is caused by this work. Both were there before I started, and I left
them alone.

- `node --test test/` fails one test, "Wave 0 installs and disables tone policy",
  with `could not build hablo-jira-agent:
  github.com/bmelton/HABLO-installer/jira/internal/dispatch`. A Go build failure
  in the Jira dispatch package. The same failure occurs on a clean checkout with
  my changes stashed. My three new tests pass.
- `HELLO.md` is deleted in the working tree and the deletion is uncommitted,
  from the earlier HAB-1 ticket. Commit it or restore it, as you prefer.

## Known gaps, recorded rather than guessed

Two things the decision log cannot supply today. Neither blocks anything, and
both would need a new log field before they could be fixed.

- **Classifier tokens.** The log holds `classifierCostUsd` and `classifierMs`,
  not token counts. So a day file carries `classifier.calls` only, and the team
  page counts classifier calls without pricing them. The local dashboard still
  prices classifier spend correctly, because it has the cost figure.
- **No requested-to-routed pairing on the team page.** A day file groups tokens
  by routed rung and by requested rung separately and never pairs them, so the
  team page cannot show the `requested -> routed` table. It shows a per-person
  table and a class breakdown instead. The local dashboard has the pairing and
  shows the table.

One maintenance duty this creates: `prices.json` in the stats repository is a
hand-made extract of the stack in `hablo.json`. When a rung is added there, add
it there too. A day file naming an unpriced rung stops the page build on purpose,
so the failure is loud rather than a silently wrong total.
