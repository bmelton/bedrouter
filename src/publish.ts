// Team stats publishing. Each machine writes exactly one path per day, `data/<login>/<date>.json`, to a shared
// repository. One writer per path and one write per path is the property that makes everything else here safe.
//
// The pure half (dailyRollup, mergeIndex, errorClass) is at the top and is unit tested. The half that talks to
// GitHub is below it, and nothing in it is on the request path: a failed publish is logged and forgotten.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { estimateCost, type Config } from "./config.js";
import type { LogLine, PersonRow, View } from "./dashboard.js";

export const VERSION: string = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; } })();
export const readLog = (path: string): LogLine[] => {
  if (!fs.existsSync(path)) return [];
  const out: LogLine[] = [];
  for (const line of fs.readFileSync(path, "utf8").split("\n")) { if (line) try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
  return out;
};

export type RungUsage = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
/**
 * What one machine publishes for one closed UTC day. Counts and sums only: the file holds no array, so nothing
 * per request can leave the machine. Token counts, never dollars, because the page prices everything from the one
 * `prices.json` in the repository and numbers computed on ten laptops from ten configs would not be comparable.
 */
export type DayFile = {
  schema: 1;
  user: string; userId: number;
  date: string;
  bedrouter: string;
  routed: Record<string, RungUsage>;
  requested: Record<string, RungUsage>;
  classes: Record<string, number>;
  classifier: { rung: string | null; calls: number };
  escalations: Record<string, number>;
  errors: Record<string, number>;
};

/** A count by error class. The message itself is never published: AWS text names accounts, regions and entitlements. */
export const errorClass = (message: string): string =>
  /AccessDeniedException|model identifier is invalid|not available for this account/i.test(message) ? "rung-fatal"
    : /ValidationException/i.test(message) ? "validation"
      : /ThrottlingException|\b429\b|\b5\d\d\b/.test(message) ? "throttled"
        : /abort|timeout|socket/i.test(message) ? "aborted"
          : "other";

const emptyUsage = (): RungUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const addUsage = (into: Record<string, RungUsage>, alias: string, l: LogLine) => {
  const u = (into[alias] ??= emptyUsage());
  u.requests++; u.inputTokens += l.inputTokens ?? 0; u.outputTokens += l.outputTokens ?? 0;
  u.cacheReadTokens += l.cacheReadTokens ?? 0; u.cacheWriteTokens += l.cacheWriteTokens ?? 0;
};
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

/**
 * Build one day's payload. Pure, and built field by field from an allowlist rather than by copying a log line, so a
 * new log field is excluded until somebody adds it here on purpose. `test/publish.test.ts` holds that to a fixture
 * line carrying every forbidden field.
 */
export function dailyRollup(lines: LogLine[], date: string, meta: { user: string; userId: number; version: string; classifierRung?: string | null }): DayFile {
  const out: DayFile = {
    schema: 1, user: meta.user, userId: meta.userId, date, bedrouter: meta.version,
    routed: {}, requested: {}, classes: {}, classifier: { rung: meta.classifierRung ?? null, calls: 0 },
    escalations: {}, errors: {},
  };
  for (const l of lines) {
    if (l.ts.slice(0, 10) !== date) continue;
    if (l.classifierMs != null) out.classifier.calls++;
    if (l.class) bump(out.classes, l.class);
    if (l.escalationReason) bump(out.escalations, l.escalationReason);
    if (l.error) bump(out.errors, errorClass(l.error));
    if (l.costUsd == null) continue; // never reached a model, so it has no usage to attribute
    if (l.routedModel) addUsage(out.routed, l.routedModel, l);
    if (l.requestedModel) addUsage(out.requested, l.requestedModel, l);
  }
  return out;
}

/** A real calendar day, not merely a digit pattern: `2026-09-99` matches the shape and is not a date. */
export const validDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
};

/** The UTC days present in a log, closed ones only: a day is published once, complete, and never rewritten. */
export function closedDays(lines: LogLine[], today: string): string[] {
  const days = new Set<string>();
  for (const l of lines) { const d = l.ts.slice(0, 10); if (d < today) days.add(d); }
  return [...days].sort();
}

// --- the team rollup ------------------------------------------------------------------------------------------------

export type Prices = { schema?: number; baselineAlias: string; rungs: Record<string, { inputPerM: number; outputPerM: number }> };
export type MergeResult = { view: View; skipped: { file: string; why: string }[]; unpriced: string[] };

const usageCost = (p: { inputPerM: number; outputPerM: number }, u: RungUsage) =>
  estimateCost(p, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens });

/**
 * Merge day files into the team view model. Pure. A file that fails validation is named in `skipped` and left out
 * rather than failing the build, because one person's bad file must not take the team page down.
 *
 * A *routed* rung that no price covers is the one exception: it throws. That is real spend, and dropping it would
 * quietly remove it from every total, which is worse than a stopped build.
 *
 * A *requested* alias that no price covers is only reported. `auto` is a synthetic alias that names no rung, so it
 * appears in every day file and can never be priced; it feeds the weaker asked-for baseline and nothing else.
 */
export function mergeIndex(files: { path: string; body: unknown }[], prices: Prices): MergeResult {
  const unpriced = new Set<string>();
  const price = (alias: string, where: string) => {
    const p = prices.rungs[alias];
    if (!p) throw new Error(`${where}: no price for rung "${alias}" in prices.json. Add it, or the team totals silently lose that rung's spend.`);
    return p;
  };
  const askedPrice = (alias: string) => { const p = prices.rungs[alias]; if (!p) unpriced.add(alias); return p; };
  const baseline = price(prices.baselineAlias, "prices.json baselineAlias");
  const skipped: MergeResult["skipped"] = [];
  const good: DayFile[] = [];

  for (const f of files) {
    const d = f.body as DayFile;
    const dir = f.path.split("/").at(-2) ?? "";
    const name = f.path.split("/").at(-1) ?? "";
    const why = !d || typeof d !== "object" ? "not an object"
      : d.schema !== 1 ? `unknown schema ${JSON.stringify(d.schema)}`
        : typeof d.user !== "string" || !d.user ? "no user"
          : !validDate(d.date) ? `bad date ${JSON.stringify(d.date)}`
            // A public repository takes direct pushes, so a file claiming to be somebody else is a cheap thing to check.
            : d.user !== dir ? `user "${d.user}" does not match its directory "${dir}"`
              : name !== `${d.date}.json` ? `date "${d.date}" does not match its filename "${name}"`
                : !d.routed || typeof d.routed !== "object" ? "no routed totals"
                  : "";
    if (why) skipped.push({ file: f.path, why }); else good.push(d);
  }

  const buckets = new Map<string, { key: string; requests: number; costUsd: number; baselineUsd: number; requestedUsd: number; byRung: Record<string, number> }>();
  const people = new Map<string, PersonRow>();
  const classes = new Map<string, number>();
  const escalations = new Map<string, number>();
  const rungCost = new Map<string, number>();
  const t = { requests: 0, priced: 0, errors: 0, conversations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, requestedUsd: 0, baselineUsd: 0, classifierCalls: 0, classifierUsd: 0, savedUsd: 0, savedPct: 0, savedVsRequestedUsd: 0, cheaperRequests: 0, comparableRequests: 0, cheaperShare: 0, escalations: 0, topEscalation: null as string | null };

  for (const d of good) {
    const b = buckets.get(d.date) ?? { key: d.date, requests: 0, costUsd: 0, baselineUsd: 0, requestedUsd: 0, byRung: {} as Record<string, number> };
    buckets.set(d.date, b);
    const p = people.get(d.user) ?? { login: d.user, requests: 0, costUsd: 0, baselineUsd: 0, savedUsd: 0, days: 0 };
    people.set(d.user, p);
    p.days++;
    t.classifierCalls += d.classifier?.calls ?? 0;
    for (const [k, n] of Object.entries(d.classes ?? {})) classes.set(k, (classes.get(k) ?? 0) + n);
    for (const [k, n] of Object.entries(d.escalations ?? {})) { escalations.set(k, (escalations.get(k) ?? 0) + n); t.escalations += n; }
    for (const n of Object.values(d.errors ?? {})) t.errors += n;

    for (const [alias, u] of Object.entries(d.routed)) {
      const cost = usageCost(price(alias, f(d)), u), native = usageCost(baseline, u);
      t.requests += u.requests; t.priced += u.requests;
      t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.cacheReadTokens += u.cacheReadTokens;
      t.costUsd += cost; t.baselineUsd += native;
      b.requests += u.requests; b.costUsd += cost; b.baselineUsd += native;
      b.byRung[alias] = (b.byRung[alias] ?? 0) + cost;
      rungCost.set(alias, (rungCost.get(alias) ?? 0) + cost);
      p.requests += u.requests; p.costUsd += cost; p.baselineUsd += native;
    }
    for (const [alias, u] of Object.entries(d.requested ?? {})) {
      const p = askedPrice(alias);
      if (!p) continue;
      const asked = usageCost(p, u);
      t.requestedUsd += asked; b.requestedUsd += asked;
    }
  }
  for (const p of people.values()) p.savedUsd = p.baselineUsd - p.costUsd;

  t.savedUsd = t.baselineUsd - t.costUsd;
  t.savedPct = t.baselineUsd > 0 ? (t.savedUsd / t.baselineUsd) * 100 : 0;
  t.savedVsRequestedUsd = t.requestedUsd - t.costUsd;
  t.topEscalation = [...escalations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const dates = good.map((d) => d.date).sort();

  return {
    skipped,
    unpriced: [...unpriced].sort(),
    view: {
      window: { fromIso: dates[0] ?? null, toIso: dates.at(-1) ?? null, bucket: "day", session: null },
      baseline: { alias: prices.baselineAlias, ...baseline },
      totals: t,
      // The comparison panel is a local view. A published day file carries only prices.json rungs and a baselineAlias,
      // so naming comparison models here would widen the team-stats schema for a display-only panel.
      comparisons: [],
      rungs: [...rungCost.keys()].sort((a, b) => (prices.rungs[a]?.inputPerM ?? 0) - (prices.rungs[b]?.inputPerM ?? 0) || a.localeCompare(b)),
      buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
      // A day file groups tokens by routed rung and by requested rung separately, and never pairs them, so the team
      // page cannot show a `requested -> routed` table. It shows who and what class instead.
      byRoute: [],
      reasonTitle: { panel: "Requests by class", column: "Class" },
      byReason: [...classes.entries()].sort((a, b) => b[1] - a[1]).map(([reason, requests]) => ({ reason, requests })),
      byPerson: [...people.values()].sort((a, b) => b.costUsd - a.costUsd),
    },
  };
}
const f = (d: DayFile) => `data/${d.user}/${d.date}.json`;

// --- GitHub ---------------------------------------------------------------------------------------------------------

export type Credential = { token: string; source: "gh" | "env" };

/**
 * `gh` first, then `BEDROUTER_PUBLISH_TOKEN`. On a machine set up by the HABLO installer `gh` is already
 * authenticated, so nobody has to create a token by hand. The hostname is pinned because a work machine can hold a
 * GitHub Enterprise session that cannot write to a github.com repository.
 *
 * A `gh` token carries whatever scope the developer already has, usually broad `repo`. Nothing here can narrow it,
 * so `doctor` reports the scope instead, and the only path this file ever writes to is the one it builds itself.
 */
export function resolveCredential(prefer: "auto" | "gh" | "env" = "auto"): Credential | null {
  if (prefer !== "env") {
    const r = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 5000 });
    const token = r.status === 0 ? r.stdout.trim() : "";
    if (token) return { token, source: "gh" };
    if (prefer === "gh") return null;
  }
  const env = process.env.BEDROUTER_PUBLISH_TOKEN?.trim();
  return env ? { token: env, source: "env" } : null;
}

const API = "https://api.github.com";
const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bedrouter" });

export type Identity = { login: string; id: number; scopes: string };
let identityCache: Identity | null = null;
/**
 * Identity comes from the credential, never from config: nothing to typo, and no way to publish as somebody else.
 * The login names the directory because GitHub logins are already slug-safe; the numeric id goes in the file
 * because a login can be renamed and an id cannot.
 */
export async function identity(token: string): Promise<Identity> {
  if (identityCache) return identityCache;
  const r = await fetch(`${API}/user`, { headers: headers(token) });
  if (!r.ok) throw new Error(`GET /user returned ${r.status} ${r.statusText}`);
  const body = await r.json() as { login: string; id: number };
  return (identityCache = { login: body.login, id: body.id, scopes: r.headers.get("x-oauth-scopes") ?? "" });
}

/** The day files already in the repository for this login. A 404 means the directory does not exist yet. */
export async function publishedDays(token: string, repo: string, login: string, branch?: string): Promise<Set<string>> {
  const url = `${API}/repos/${repo}/contents/data/${login}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`;
  const r = await fetch(url, { headers: headers(token) });
  if (r.status === 404) return new Set();
  if (!r.ok) throw new Error(`listing data/${login} returned ${r.status} ${r.statusText}`);
  const body = await r.json() as { name: string }[];
  return new Set(body.filter((e) => e.name.endsWith(".json")).map((e) => e.name.slice(0, -5)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One PUT per day file. The contents API commits against the branch tip it read and updates the ref without force,
 * and a ref update is compare-and-swap, so a publisher that loses the race gets 409 and no commit is lost. Two
 * publishers never touch the same path, so the retry has nothing to reconcile and succeeds on the next attempt.
 */
export async function putDayFile(token: string, repo: string, day: DayFile, branch?: string, attempts = 5): Promise<"created" | "exists"> {
  const path = f(day);
  const body = {
    message: `${day.user} ${day.date}`,
    content: Buffer.from(JSON.stringify(day, null, 2) + "\n", "utf8").toString("base64"),
    ...(branch ? { branch } : {}),
  };
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: "PUT", headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return "created";
    // A published day is final, so a path that already exists is success, not a conflict to resolve.
    if (r.status === 422) return "exists";
    if (r.status !== 409 || i >= attempts - 1) throw new Error(`PUT ${path} returned ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 200)}`);
    await sleep(Math.round(2 ** i * 250 * (1 + Math.random())));
  }
}

// --- running --------------------------------------------------------------------------------------------------------

export type PublishReport = { source: Credential["source"] | null; login: string | null; published: string[]; already: string[]; failed: { date: string; why: string }[]; note: string | null };

/**
 * Publish every closed UTC day that the repository does not already hold, oldest first. Backfill is not a separate
 * feature: a laptop that was off for a week publishes seven files on its next run.
 *
 * Never throws for an operational reason. A failed publish is reported and retried on the next interval, because
 * nothing here may ever affect a request.
 */
export async function runPublish(cfg: Config, opts: { logPath?: string; since?: string; dryRun?: boolean; now?: Date; onPayload?: (d: DayFile) => void } = {}): Promise<PublishReport> {
  const out: PublishReport = { source: null, login: null, published: [], already: [], failed: [], note: null };
  const p = cfg.publish;
  if (!p?.enabled || !p.repo) { out.note = "publishing is off (no publish block, or enabled is false)"; return out; }

  const cred = resolveCredential(p.credential ?? "auto");
  if (cred) out.source = cred.source;
  if (!cred && !opts.dryRun) { out.note = "no credential: run `gh auth login`, or set BEDROUTER_PUBLISH_TOKEN"; return out; }

  const lines = readLog(opts.logPath ?? process.env.BEDROUTER_LOG ?? "./bedrouter.log.jsonl");
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const days = closedDays(lines, today).filter((d) => !opts.since || d >= opts.since);
  if (!days.length) { out.note = `no closed day to publish (today is ${today} UTC)`; return out; }

  // A dry run is how somebody checks what the redaction rules actually emit before opting in, so it must work
  // before there is a credential. Identity is a read, so it is still resolved when one exists.
  let me: Identity = { login: "(unknown)", id: 0, scopes: "" };
  try { if (cred) me = await identity(cred.token); }
  catch (err) { if (!opts.dryRun) { out.note = `could not resolve identity: ${(err as Error).message}`; return out; } }
  out.login = me.login;

  let have = new Set<string>();
  if (!opts.dryRun) {
    try { have = await publishedDays(cred!.token, p.repo!, me.login, p.branch); }
    catch (err) { out.note = `could not list published days: ${(err as Error).message}`; return out; }
  }

  const meta = { user: me.login, userId: me.id, version: VERSION, classifierRung: cfg.routing?.classifier?.model ?? null };
  for (const date of days) {
    if (have.has(date)) { out.already.push(date); continue; }
    const day = dailyRollup(lines, date, meta);
    if (opts.dryRun) { opts.onPayload?.(day); out.published.push(date); continue; }
    try { (await putDayFile(cred!.token, p.repo!, day, p.branch)) === "exists" ? out.already.push(date) : out.published.push(date); }
    catch (err) { out.failed.push({ date, why: (err as Error).message }); }
  }
  return out;
}

/**
 * The in-process check the running server makes. The start time is jittered because ten laptops all publishing at
 * exactly the same minute turn a rare collision into a reliable one. Unreferenced, so it never holds the process open.
 */
export function startPublishLoop(cfg: Config, log: (line: string) => void = console.log): void {
  const p = cfg.publish;
  if (!p?.enabled || !p.repo) return;
  const every = p.intervalMs ?? 3_600_000;
  const once = async () => {
    try {
      const r = await runPublish(cfg);
      if (r.published.length) log(`bedrouter publish: wrote ${r.published.join(", ")} to ${p.repo} as ${r.login} (credential: ${r.source})`);
      else if (r.note) log(`bedrouter publish: ${r.note}`);
      for (const f of r.failed) log(`bedrouter publish: ${f.date} failed, will retry: ${f.why}`);
    } catch (err) { log(`bedrouter publish: ${(err as Error).message}`); }
  };
  setTimeout(() => { void once(); setInterval(() => void once(), every).unref(); }, Math.round(Math.random() * Math.min(every, 300_000))).unref();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // bedrouter publish [--since YYYY-MM-DD] [--dry-run] [--log path]
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const { loadConfig } = await import("./config.js");
  const cfg = loadConfig();
  const dryRun = argv.includes("--dry-run");
  const r = await runPublish(cfg, { logPath: opt("log"), since: opt("since"), dryRun, onPayload: (d) => console.log(JSON.stringify(d, null, 2)) });

  if (r.note) console.log(r.note);
  if (r.source) console.log(`credential: ${r.source}${r.login && r.login !== "(unknown)" ? `, publishing as ${r.login}` : ""}`);
  if (r.published.length) console.log(`${dryRun ? "would publish" : "published"} ${r.published.length} day(s): ${r.published.join(", ")}`);
  if (r.already.length) console.log(`already present, skipped ${r.already.length} day(s)`);
  for (const f of r.failed) console.error(`failed ${f.date}: ${f.why}`);
  return r.failed.length ? 1 : 0;
}
