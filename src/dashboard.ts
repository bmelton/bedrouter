// The price dashboard: a pure aggregation over the decision log, and a self-contained HTML rendering of it.
// No I/O lives here, so `aggregate()` takes an array of log lines and `renderHtml()` takes its result. The server
// and `report --html` both read the log themselves and call into this file.
import { estimateCost, type Rung } from "./config.js";

/** The decision-log fields the dashboard reads. A superset of this is written by server.ts; everything else is ignored. */
export type LogLine = {
  ts: string;
  class?: string | null;
  classReason?: string | null;
  requestedModel?: string | null;
  routedModel?: string | null;
  costUsd?: number | null;
  requestedCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  error?: string | null;
  escalated?: boolean;
  escalationReason?: string | null;
  conversationKey?: string | null;
  sessionKey?: string | null;
  classifierMs?: number | null;
  classifierCostUsd?: number | null;
};

export type Baseline = { alias: string; inputPerM: number; outputPerM: number };
export type AggregateOpts = {
  baseline: Baseline;
  /** alias -> position in Router.ranked, cheapest first. The only thing that may compare rung positions. */
  ranks: Record<string, number>;
  bucket?: "day" | "hour";
  since?: number;
  session?: string;
};

export type Bucket = { key: string; requests: number; costUsd: number; baselineUsd: number; requestedUsd: number; byRung: Record<string, number> };
export type RouteRow = { requested: string; routed: string; requests: number; costUsd: number; baselineUsd: number; savedUsd: number; upgrade: boolean };
export type ReasonRow = { reason: string; requests: number; costUsd: number };
export type Totals = {
  requests: number; priced: number; errors: number; conversations: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  costUsd: number; requestedUsd: number; baselineUsd: number;
  classifierCalls: number; classifierUsd: number;
  savedUsd: number; savedPct: number; savedVsRequestedUsd: number;
  /** Only a pinned request has a rung position to be measured against: `auto` names no rung, so it is not comparable. */
  cheaperRequests: number; comparableRequests: number; cheaperShare: number;
  escalations: number; topEscalation: string | null;
};
export type View = {
  window: { fromIso: string | null; toIso: string | null; bucket: "day" | "hour"; session: string | null };
  baseline: Baseline;
  totals: Totals;
  rungs: string[];
  buckets: Bucket[];
  byRoute: RouteRow[];
  byReason: ReasonRow[];
};

/**
 * The native baseline: what every request would have cost on the rung a client reaches for when there is no router.
 * Absent an explicit alias, that is the most expensive enabled rung that serves `explore`.
 * `ranked` must be `Router.ranked`, never `cfg.stack`.
 */
export function baselineRung(ranked: Rung[], alias?: string | null): Rung {
  if (alias) {
    const named = ranked.find((r) => r.alias === alias);
    if (!named) throw new Error(`routing.baselineAlias "${alias}" is not a rung in the stack`);
    if (!named.enabled) throw new Error(`routing.baselineAlias "${alias}" names a disabled rung`);
    return named;
  }
  for (let i = ranked.length - 1; i >= 0; i--) if (ranked[i].enabled && ranked[i].serves.includes("explore")) return ranked[i];
  const last = ranked.filter((r) => r.enabled).at(-1);
  if (!last) throw new Error("no enabled rung to use as a baseline");
  return last;
}

const usageOf = (l: LogLine) => ({ input: l.inputTokens ?? 0, output: l.outputTokens ?? 0, cacheRead: l.cacheReadTokens ?? 0, cacheWrite: l.cacheWriteTokens ?? 0 });

/**
 * Build the view model. Pure: same lines and options produce the same object, and nothing here reads the clock,
 * the filesystem, or the network. `classifierNote` is never copied out of a line, which is what makes the rendered
 * page safe to send to somebody else.
 */
export function aggregate(lines: LogLine[], opts: AggregateOpts): View {
  const bucket = opts.bucket ?? "day";
  const cut = bucket === "day" ? 10 : 13;
  const rows = lines.filter((l) => (!opts.since || Date.parse(l.ts) >= opts.since) && (!opts.session || l.sessionKey === opts.session));
  const priced = rows.filter((l) => l.costUsd != null);

  const buckets = new Map<string, Bucket>();
  const routes = new Map<string, RouteRow>();
  const reasons = new Map<string, ReasonRow>();
  const escalations = new Map<string, number>();
  const rungCost = new Map<string, number>();
  const t: Totals = {
    requests: rows.length, priced: priced.length, errors: rows.filter((l) => l.error).length,
    conversations: new Set(rows.map((l) => l.conversationKey).filter(Boolean)).size,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    costUsd: 0, requestedUsd: 0, baselineUsd: 0,
    classifierCalls: 0, classifierUsd: 0,
    savedUsd: 0, savedPct: 0, savedVsRequestedUsd: 0,
    cheaperRequests: 0, comparableRequests: 0, cheaperShare: 0,
    escalations: 0, topEscalation: null,
  };

  // A bucket is opened by any request, priced or not, so a day on which every request failed still appears on the
  // chart with a zero bar rather than vanishing from the axis.
  for (const l of rows) {
    if (l.classifierMs != null) { t.classifierCalls++; t.classifierUsd += l.classifierCostUsd ?? 0; }
    if (l.escalationReason) { t.escalations++; escalations.set(l.escalationReason, (escalations.get(l.escalationReason) ?? 0) + 1); }
    const bk = l.ts.slice(0, cut);
    let b = buckets.get(bk);
    if (!b) buckets.set(bk, (b = { key: bk, requests: 0, costUsd: 0, baselineUsd: 0, requestedUsd: 0, byRung: {} }));
    b.requests++;
  }

  for (const l of priced) {
    const cost = l.costUsd ?? 0;
    const requested = l.requestedCostUsd ?? cost;
    // The counterfactual holds the token counts fixed and varies only the price, so the whole history re-prices itself
    // when the config price changes. It is an estimate, never an invoice: another model emits a different output length.
    const native = estimateCost(opts.baseline, usageOf(l));
    const routed = l.routedModel ?? "?";

    t.inputTokens += l.inputTokens ?? 0; t.outputTokens += l.outputTokens ?? 0; t.cacheReadTokens += l.cacheReadTokens ?? 0;
    t.costUsd += cost; t.requestedUsd += requested; t.baselineUsd += native;
    rungCost.set(routed, (rungCost.get(routed) ?? 0) + cost);

    const reqRank = opts.ranks[l.requestedModel ?? ""], gotRank = opts.ranks[routed];
    if (reqRank != null && gotRank != null) { t.comparableRequests++; if (gotRank < reqRank) t.cheaperRequests++; }

    const b = buckets.get(l.ts.slice(0, cut))!;
    b.costUsd += cost; b.baselineUsd += native; b.requestedUsd += requested;
    b.byRung[routed] = (b.byRung[routed] ?? 0) + cost;

    const rk = `${l.requestedModel ?? "?"} -> ${routed}`;
    let r = routes.get(rk);
    if (!r) routes.set(rk, (r = { requested: l.requestedModel ?? "?", routed, requests: 0, costUsd: 0, baselineUsd: 0, savedUsd: 0, upgrade: false }));
    r.requests++; r.costUsd += cost; r.baselineUsd += native; r.savedUsd = r.baselineUsd - r.costUsd; r.upgrade = r.savedUsd < 0;

    const rsn = l.classReason ?? "(none)";
    let rr = reasons.get(rsn);
    if (!rr) reasons.set(rsn, (rr = { reason: rsn, requests: 0, costUsd: 0 }));
    rr.requests++; rr.costUsd += cost;
  }

  // The classifier is what the router spends to make its decision, so it is subtracted from savings, as report.ts does.
  t.savedUsd = t.baselineUsd - t.costUsd - t.classifierUsd;
  t.savedPct = t.baselineUsd > 0 ? (t.savedUsd / t.baselineUsd) * 100 : 0;
  t.savedVsRequestedUsd = t.requestedUsd - t.costUsd - t.classifierUsd;
  t.cheaperShare = t.comparableRequests > 0 ? (t.cheaperRequests / t.comparableRequests) * 100 : 0;
  t.topEscalation = [...escalations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const times = rows.map((l) => l.ts).sort();
  return {
    window: { fromIso: times[0] ?? null, toIso: times.at(-1) ?? null, bucket, session: opts.session ?? null },
    baseline: { alias: opts.baseline.alias, inputPerM: opts.baseline.inputPerM, outputPerM: opts.baseline.outputPerM },
    totals: t,
    rungs: [...rungCost.keys()].sort((a, b) => (opts.ranks[a] ?? 1e9) - (opts.ranks[b] ?? 1e9) || a.localeCompare(b)),
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byRoute: [...routes.values()].sort((a, b) => b.costUsd - a.costUsd),
    byReason: [...reasons.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

// --- rendering ------------------------------------------------------------------------------------------------------

// ponytail: hand-rolled SVG, so the page carries no chart library and the HTML snapshot stays small enough to mail.
// The cost is no tooltips and no animation. Vendor a chart library if a third chart type is ever needed.
const PALETTE = ["#2563eb", "#0891b2", "#059669", "#65a30d", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#4f46e5"];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(Math.abs(n) < 0.01 ? 5 : 2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

function stackedChart(view: View, colour: (rung: string) => string): string {
  const bs = view.buckets;
  if (!bs.length) return `<p class="empty">No priced requests in this window.</p>`;
  const top = Math.max(...bs.map((b) => Math.max(b.costUsd, b.baselineUsd)), 1e-9);
  const slot = Math.max(28, Math.min(72, 720 / bs.length));
  const W = Math.max(360, bs.length * slot), H = 200, pad = 26;
  const y = (v: number) => H - pad - (v / top) * (H - pad * 2);
  const parts: string[] = [`<line x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}" class="axis"/>`];
  bs.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const wide = slot * 0.66, narrow = slot * 0.4;
    parts.push(`<rect x="${(cx - wide / 2).toFixed(1)}" y="${y(b.baselineUsd).toFixed(1)}" width="${wide.toFixed(1)}" height="${(H - pad - y(b.baselineUsd)).toFixed(1)}" class="baseline"><title>${esc(b.key)} baseline ${usd(b.baselineUsd)}</title></rect>`);
    let cursor = H - pad;
    for (const rung of view.rungs) {
      const v = b.byRung[rung];
      if (!v) continue;
      const h = (v / top) * (H - pad * 2);
      cursor -= h;
      parts.push(`<rect x="${(cx - narrow / 2).toFixed(1)}" y="${cursor.toFixed(1)}" width="${narrow.toFixed(1)}" height="${h.toFixed(1)}" fill="${colour(rung)}"><title>${esc(b.key)} ${esc(rung)} ${usd(v)}</title></rect>`);
    }
    if (slot >= 40 || i % 2 === 0) parts.push(`<text x="${cx.toFixed(1)}" y="${H - pad + 14}" class="tick">${esc(b.key.slice(5))}</text>`);
  });
  parts.push(`<text x="2" y="${pad - 10}" class="tick left">${usd(top)}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend by ${view.window.bucket}, split by routed rung, against the native baseline">${parts.join("")}</svg>`;
}

function rateChart(view: View): string {
  const bs = view.buckets.filter((b) => b.baselineUsd > 0);
  if (!bs.length) return `<p class="empty">No baseline cost in this window, so there is no rate to show.</p>`;
  const rates = bs.map((b) => ((b.baselineUsd - b.costUsd) / b.baselineUsd) * 100);
  const lo = Math.min(0, ...rates), hi = Math.max(0, ...rates), span = hi - lo || 1;
  const slot = Math.max(28, Math.min(72, 720 / bs.length));
  const W = Math.max(360, bs.length * slot), H = 200, pad = 26;
  const y = (v: number) => H - pad - ((v - lo) / span) * (H - pad * 2);
  const zero = y(0);
  const parts: string[] = [`<line x1="0" y1="${zero.toFixed(1)}" x2="${W}" y2="${zero.toFixed(1)}" class="axis"/>`];
  bs.forEach((b, i) => {
    const r = rates[i], cx = i * slot + slot / 2, w = slot * 0.5;
    const top = r >= 0 ? y(r) : zero, h = Math.abs(y(r) - zero);
    parts.push(`<rect x="${(cx - w / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" class="${r < 0 ? "worse" : "better"}"><title>${esc(b.key)} ${pct(r)}</title></rect>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(r >= 0 ? top - 4 : top + h + 12).toFixed(1)}" class="tick">${r.toFixed(0)}%</text>`);
    if (slot >= 40 || i % 2 === 0) parts.push(`<text x="${cx.toFixed(1)}" y="${H - 4}" class="tick">${esc(b.key.slice(5))}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Savings rate by ${view.window.bucket}">${parts.join("")}</svg>`;
}

const CSS = `
:root{--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--card:#f9fafb;--good:#059669;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f16;--fg:#e5e7eb;--muted:#9ca3af;--line:#1f2937;--card:#111827;--good:#34d399;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:18px;margin:0 0 2px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 8px}
.wrap{max-width:1100px;margin:0 auto}
.sub{color:var(--muted);margin:0 0 20px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:20px}
.panel{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--card);min-width:0;overflow-x:auto}
svg{width:100%;height:auto;display:block}
.axis{stroke:var(--line);stroke-width:1}
.baseline{fill:var(--muted);opacity:.18}
.better{fill:var(--good)}.worse{fill:var(--bad)}
text.tick{fill:var(--muted);font-size:10px;text-anchor:middle}
text.left{text-anchor:start}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:12px;color:var(--muted)}
.legend span{display:flex;align-items:center;gap:5px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:20px}
.tile{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--card)}
.tile b{display:block;font-size:24px;font-weight:650;letter-spacing:-.02em}
.tile small{color:var(--muted)}
.good{color:var(--good)}.bad{color:var(--bad)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:4px 6px;border-bottom:1px solid var(--line)}
td{padding:4px 6px;border-bottom:1px solid var(--line)}
td.n,th.n{text-align:right}
.empty{color:var(--muted);margin:8px 0}
footer{color:var(--muted);font-size:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:12px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
label{color:var(--muted);font-size:12px}
`;

/** One self-contained document. No network request of any kind, which the Content-Security-Policy also enforces. */
export function renderHtml(view: View, opts: { generatedAt: string; live?: boolean }): string {
  const t = view.totals;
  const colourOf = new Map(view.rungs.map((r, i) => [r, PALETTE[i % PALETTE.length]]));
  const colour = (r: string) => colourOf.get(r) ?? PALETTE[0];
  const sign = (n: number) => (n < 0 ? "bad" : "good");
  const tile = (value: string, cls: string, label: string) => `<div class="tile"><b class="${cls}">${value}</b><small>${label}</small></div>`;

  const legend = view.rungs.map((r) => `<span><i class="sw" style="background:${colour(r)}"></i>${esc(r)}</span>`).join("") +
    `<span><i class="sw" style="background:var(--muted);opacity:.35"></i>${esc(view.baseline.alias)} baseline</span>`;

  const reasonRows = view.byReason.map((r) => `<tr><td>${esc(r.reason)}</td><td class="n">${num(r.requests)}</td><td class="n">${usd(r.costUsd)}</td></tr>`).join("") ||
    `<tr><td colspan="3" class="empty">Nothing yet.</td></tr>`;
  const routeRows = view.byRoute.map((r) => `<tr><td>${esc(r.requested)} &rarr; ${esc(r.routed)}</td><td class="n">${num(r.requests)}</td><td class="n">${usd(r.costUsd)}</td><td class="n ${sign(r.savedUsd)}">${usd(r.savedUsd)}</td></tr>`).join("") ||
    `<tr><td colspan="4" class="empty">Nothing yet.</td></tr>`;

  const window = view.window.fromIso ? `${view.window.fromIso.slice(0, 16).replace("T", " ")} to ${view.window.toIso!.slice(0, 16).replace("T", " ")} UTC` : "no requests in range";
  // ponytail: auto-refresh reloads the page rather than re-rendering from data.json in the browser, which would mean a
  // second copy of this renderer in JavaScript. data.json stays the machine-readable surface and the testable one.
  const script = opts.live
    ? `<script>const b=document.getElementById('r'),c=document.getElementById('a');b.onclick=()=>location.reload();let t;c.onchange=()=>{clearTimeout(t);if(c.checked)t=setTimeout(()=>location.reload(),5000)};</script>`
    : "";
  const controls = opts.live
    ? `<p class="sub"><button id="r" type="button">Refresh</button> <label><input id="a" type="checkbox"> auto every 5s</label></p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bedrouter dashboard</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>bedrouter${view.window.session ? ` &middot; session ${esc(view.window.session)}` : ""}</h1>
<p class="sub">${esc(window)} &middot; ${num(t.requests)} requests &middot; baseline <b>${esc(view.baseline.alias)}</b> at $${view.baseline.inputPerM}/$${view.baseline.outputPerM} per million.
Savings are an estimate: the token counts are held fixed and only the price varies, so another model's output length is not modelled.</p>
${controls}
<div class="charts">
  <div class="panel"><h2>Spend by ${view.window.bucket}, by routed rung</h2>${stackedChart(view, colour)}<div class="legend">${legend}</div></div>
  <div class="panel"><h2>Savings rate by ${view.window.bucket}</h2>${rateChart(view)}</div>
</div>
<div class="tiles">
${tile(usd(t.savedUsd), sign(t.savedUsd), `saved against ${esc(view.baseline.alias)}`)}
${tile(pct(t.savedPct), sign(t.savedUsd), "of the native baseline")}
${tile(num(t.requests), "", `requests, ${num(t.priced)} reached a model`)}
${tile(pct(t.cheaperShare), "", `served below the rung asked for, of ${num(t.comparableRequests)} pinned`)}
${tile(usd(t.classifierUsd), "", `classifier, ${num(t.classifierCalls)} calls`)}
${tile(num(t.escalations), "", t.topEscalation ? `escalations, mostly ${esc(t.topEscalation)}` : "escalations")}
</div>
<div class="cols">
  <div class="panel"><h2>What the router did</h2>
    <table><thead><tr><th>Deciding signal</th><th class="n">Requests</th><th class="n">Cost</th></tr></thead><tbody>${reasonRows}</tbody></table></div>
  <div class="panel"><h2>Where the money went</h2>
    <table><thead><tr><th>Requested &rarr; routed</th><th class="n">Requests</th><th class="n">Cost</th><th class="n">Saved</th></tr></thead><tbody>${routeRows}</tbody></table></div>
</div>
<footer>Actual ${usd(t.costUsd)} &middot; asked-for baseline ${usd(t.requestedUsd)} (${usd(t.savedVsRequestedUsd)} saved) &middot; native baseline ${usd(t.baselineUsd)} &middot; tokens in ${num(t.inputTokens)}, out ${num(t.outputTokens)}, cache-read ${num(t.cacheReadTokens)} &middot; ${num(t.errors)} errors &middot; generated ${esc(opts.generatedAt)}</footer>
</div>${script}</body></html>
`;
}
