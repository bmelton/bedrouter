# Feature: price dashboard

- [x] Add `routing.baselineAlias` to the config, with a default taken from `Router.ranked`
- [x] Write `aggregate(lines, opts)` in `src/dashboard.ts`: pure, no I/O, returns the view model
- [x] Price every line a second time against the baseline rung at render time
- [x] Write `renderHtml(view)`: one self-contained page, no network fetches
- [x] Add `GET /dashboard` and `GET /dashboard/data.json` to `server.ts`
- [x] ~~`GET /dashboard/chart.js`~~ and ~~vendor Chart.js v4 UMD~~: superseded on 2026-09-16. The two
      charts are hand-rolled inline SVG, so there is no vendored file, no version and SHA README, and
      no third route. See "Chart library" below, which is kept as the record of what was traded away.
- [x] Add `report --html <file>` so the same page writes to disk as a snapshot
- [x] Add `test/dashboard.test.ts` over `aggregate()`, including the negative-savings case
- [x] Document the two baselines in the README "Routing" section

The team rollup in [TEAM-STATS.md](TEAM-STATS.md) renders the same view model
from merged per-developer data, and reuses the redaction rules below.

## Goal

bedrouter already knows what each request cost and what it would have cost
somewhere else. That knowledge is stuck in a terminal table (`npm run report`)
and in response headers. The dashboard puts it on one page that a person can
read in five seconds and show to somebody else: what the router spent, what the
same work would have cost without the router, and where the difference came
from.

The page is a local view of a local log. It is not a service, it is not
multi-tenant, and it does not collect anything the log does not already hold.

## What does not change

The router, the classifier, and the request path. The dashboard reads
`bedrouter.log.jsonl` after the fact. No new field is written on the hot path,
no new call is made, and a broken dashboard cannot make a request fail.

`Router.ranked` stays the only thing that compares rung positions, including the
default baseline choice below.

## The two baselines

Savings need a counterfactual, and one number cannot carry both stories.

**Asked-for baseline.** `requestedCostUsd`, which the log already holds: the same
tokens priced at the rung the client named. This is the honest number for pinned
traffic. It is weak for `auto` traffic, because `modelTable()` resolves `auto` to
the representative `execute` rung, so the baseline is already a cheap rung and
the reported saving is near zero. In the current log, 74 of 715 requests arrived
as `auto`.

**Native baseline.** The same tokens priced at one configured top rung, which
answers "what would this have cost if every request had gone to the big model".
Add to `bedrouter.json`:

    "routing": { "baselineAlias": "opus" }

Default when absent: the highest-price enabled rung in `Router.ranked` that
serves `explore`. This is the rung a client would have reached for, so it is the
right stand-in for "no router".

Both numbers are computed at render time by calling `estimateCost(baselineRung,
usage)` over the token counts each line already carries. Nothing is written to
the log, so the whole existing history re-prices itself, and a price correction
in the config applies to past days as well as future ones.

Both numbers are estimates, not invoices. The same prompt on another model
produces a different number of output tokens, so the counterfactual holds the
token counts fixed and varies only the price. The page says this on its face,
once, near the headline figure. The classifier cost is subtracted from savings,
as `report.ts` already does.

## Data source

`bedrouter.log.jsonl`, read whole on request and cached by mtime and size. At
715 lines and 470 KB the read is not worth optimising.

    // ponytail: whole-file read per request, cached by mtime. Stream and index
    // by day if the log passes a few hundred MB.

The log has no rotation today, so the dashboard is also the thing that will make
an unbounded log visible. `--since` limits the window; day buckets keep the
chart readable whatever the range.

## Routes

| Route | Returns |
| --- | --- |
| `GET /dashboard` | The page. One HTML document, one script tag to the vendored chart file. |
| `GET /dashboard/data.json` | The view model from `aggregate()`. Lets the page refresh without a reload, and makes the numbers testable without parsing HTML. |
| `GET /dashboard/chart.js` | The vendored chart library, served with a long cache header. |

Query parameters: `since` (ISO timestamp), `bucket` (`day` by default, `hour`),
`session` (one client session key). The same parameters `report.ts` accepts.

`report --html <file>` calls the same `renderHtml()` and writes the result to
disk, so a snapshot can be sent to somebody who does not run bedrouter. The
snapshot inlines the chart library instead of linking it.

## Layout

The reference layout is two charts across the top, then a row of value tiles,
then two text panels.

**Spend by day, split by rung.** Stacked bars, one bar per day, one colour per
routed rung, so the cheap tier and the expensive tier are visible as areas
rather than as a table row. A light overlay bar shows the native baseline for
the same day, so the gap between the stack and the overlay is the saving.

**Savings rate by day.** One bar per day, `saved / baseline` as a percentage,
with the value printed above each bar. This is the chart that shows whether the
router is holding its ground over time.

**Value tiles.** Six of them, each a large number with one line of context
underneath:

- Total saved, in dollars, over the selected window
- Savings rate, as a percentage of the native baseline
- Requests routed, and how many reached a model
- Share of requests served by a rung cheaper than the one asked for
- Classifier cost, and how many calls produced it
- Escalations, and the most common trigger

**What the router did.** The `byReason` table from `report.ts`, as a list: the
deciding signal, the request count, and the dollars behind it. This is the panel
that explains a surprising headline number.

**Where the money went.** The `byRoute` table, sorted by spend, as
`requested -> routed` with the cost and the saving for each pair. Today that
list is led by `gpt-oss-20b -> gpt-oss-120b` at 505 requests, which is an upgrade
and therefore a negative saving. The page must show a negative saving as a
negative number in a distinct colour, never as a zero. A router that quietly
spends more is the failure this dashboard exists to catch.

## Chart library

> Superseded on 2026-09-16: the charts are hand-rolled inline SVG, about 50 lines
> in `renderHtml()`. The page still makes no network request and still works
> offline, and the snapshot is 9 KB rather than 200 KB, so it can be mailed. What
> was traded away is tooltips beyond the SVG `<title>` element, animation, and
> cheap addition of a third chart type. The section below stands as the record of
> the option that was not taken.

Chart.js v4, UMD build, MIT licence, vendored as `src/vendor/chart.umd.js` and
copied to `dist/vendor/` by the build. A sibling `src/vendor/README.md` records
the exact version and the SHA-256 of the file, so an update is a reviewable diff
rather than a silent swap.

This is a dependency in everything but name, and it is accepted on purpose: it
keeps the page working offline, keeps a third-party script out of the request
path, and avoids a runtime CDN fetch in a local cost tool. The cost is about
200 KB in the published package and a manual update path. It is listed in
`package.json` `files` alongside `dist`.

The page loads it with one script tag and no other network request. A
Content-Security-Policy response header of `default-src 'none'; script-src
'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'` enforces that, so a
future edit cannot quietly add a CDN.

## Privacy

The page shows aggregates: counts, tokens, dollars, model aliases, and signal
names. It never shows `classifierNote`, which is free text written by a model
about a prompt and can therefore quote one. The HTML snapshot is meant to be
shared, so this rule is what makes sharing safe. `aggregate()` drops the field
rather than the renderer hiding it.

The route is unauthenticated, like every other bedrouter route, because the
server binds to localhost. If bedrouter ever binds to a routable address, the
dashboard is not the place to solve that.

## Test

`aggregate()` is pure and takes an array of log lines, so one test file covers
it: a fixture of about a dozen lines, then assertions on the totals, the day
buckets, the savings rate, the negative-savings case, and the dropped
`classifierNote`. No DOM test and no snapshot of the HTML.

## Not doing

- Live streaming or websockets. The page has a refresh button and a five-second
  poll of `data.json`.
- A database. The jsonl log is the store.
- Log rotation, which is its own change and is not blocked by this one.
- Per-user or multi-machine rollup. One machine, one log.
- Budgets or alerts. Read the number first, then decide whether a threshold is
  worth having.
