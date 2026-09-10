// Class-based router: picks the cheapest rung in the client's family that should complete the task, sticks to it per
// conversation (prompt caching), escalates one rung on observable failure. Rules and a small map, no ML.
import { createHash } from "node:crypto";
import type { Config, Family, Rung } from "./config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type Class = "execute" | "explore";

export type RoutingConfig = {
  enabled: boolean;
  honorClientModel: boolean;
  maxConversations: number;
  retryWindowMs: number;
  classes: Partial<Record<Family, Record<Class, string>>>;
  shape: { exploreInputTokens: number; exploreTools: number; executeTurns: number; executeLastUserChars: number };
  keywords: Record<Class, string[]>;
};

export const ROUTING_DEFAULTS: RoutingConfig = {
  enabled: false, // absent block = router off, so an existing bedrouter.json keeps today's behaviour
  honorClientModel: true,
  maxConversations: 1000,
  retryWindowMs: 60_000,
  classes: {},
  shape: { exploreInputTokens: 60_000, exploreTools: 40, executeTurns: 8, executeLastUserChars: 200 },
  keywords: { explore: [], execute: [] },
};

export type Decision = {
  rung: Rung;
  class: Class | null;
  classReason: string;
  conversationKey: string | null; // null = not tracked (router off, bypass, or pinned cheap rung)
  sticky: boolean;
  escalated: boolean;
  escalationReason: string | null;
};

/** What the server observed about a response; every field optional so callers pass what they have. */
export type Outcome = { stopReason?: string | null; outputTokens?: number | null; errorStatus?: number | null; aborted?: boolean; malformedToolJson?: boolean };

type Entry = { class: Class; rung: number; lastSeen: number; lastPrompt: string };

const text = (content: Json): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text ?? "" : "")).join("") : "";

// Claude Code injects <system-reminder> blocks (CLAUDE.md, git status, ...) into user turns; they are not the ask.
const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");

/** Cheap views of either request shape (Anthropic Messages or OpenAI chat). */
export function promptShape(body: Json) {
  const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
  const systemMsgs = messages.filter((m) => m.role === "system" || m.role === "developer");
  const system = [text(body.system), ...systemMsgs.map((m) => text(m.content))].join("\n");
  const users = messages.filter((m) => m.role === "user");
  return {
    system,
    firstUser: stripReminders(text(users[0]?.content)),
    lastUser: stripReminders(text(users[users.length - 1]?.content)).trim(),
    turns: messages.length,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    // ponytail: chars/4 token estimate over the whole body; use the model's tokenizer if thresholds need precision.
    inputTokens: Math.ceil(JSON.stringify(body).length / 4),
    thinking: body.thinking?.type === "enabled" || /^(high|xhigh|max)$/.test(String(body.reasoning_effort ?? "")),
    userId: body.metadata?.user_id ?? body.user ?? "",
  };
}

const wordRe = (words: string[]) =>
  words.length ? new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : /$^/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class Router {
  readonly rc: RoutingConfig;
  private readonly explore: RegExp;
  private readonly execute: RegExp;
  private readonly conv = new Map<string, Entry>(); // ponytail: in-memory LRU capped by maxConversations; persist to disk if restarts matter

  constructor(private readonly cfg: Config) {
    const r = cfg.routing ?? {};
    this.rc = { ...ROUTING_DEFAULTS, ...r, shape: { ...ROUTING_DEFAULTS.shape, ...r.shape }, keywords: { ...ROUTING_DEFAULTS.keywords, ...r.keywords } };
    for (const [family, classes] of Object.entries(this.rc.classes) as [Family, Record<Class, string>][]) {
      for (const [cls, alias] of Object.entries(classes)) {
        if (!cfg.families[family]?.some((x) => x.alias === alias)) throw new Error(`routing.classes.${family}.${cls}: "${alias}" is not a rung in that family`);
      }
    }
    this.explore = wordRe(this.rc.keywords.explore);
    this.execute = wordRe(this.rc.keywords.execute);
  }

  /** Signals 2-4 in order; the client-model signal (1) lives in route() because it needs the ladder. */
  classify(body: Json, s = promptShape(body)): { class: Class; reason: string } {
    const { shape } = this.rc;
    if (s.thinking) return { class: "explore", reason: "thinking" };
    if (s.inputTokens >= shape.exploreInputTokens) return { class: "explore", reason: "shape:long-context" };
    if (s.tools >= shape.exploreTools) return { class: "explore", reason: "shape:many-tools" };
    if (s.turns >= shape.executeTurns && s.lastUser.length <= shape.executeLastUserChars) return { class: "execute", reason: "shape:agentic-loop" };
    if (this.explore.test(s.lastUser)) return { class: "explore", reason: "keyword:explore" };
    if (this.execute.test(s.lastUser)) return { class: "execute", reason: "keyword:execute" };
    return { class: "execute", reason: "default" };
  }

  route(body: Json, requested: Rung, header?: string): Decision {
    const ladder = this.cfg.families[requested.family].map((r) => ({ ...r, family: requested.family }));
    const at = (i: number) => ladder[Math.min(Math.max(i, 0), ladder.length - 1)];
    const off = (reason: string): Decision => ({ rung: requested, class: null, classReason: reason, conversationKey: null, sticky: false, escalated: false, escalationReason: null });
    const classes = this.rc.classes[requested.family];
    if (!this.rc.enabled) return off("disabled");
    if (header === "off") return off("header:off");
    if (!classes) return off("no-classes");

    const reqIdx = ladder.findIndex((r) => r.alias === requested.alias);
    const start = (c: Class) => ladder.findIndex((r) => r.alias === classes[c]);
    // Signal 1: a request below the execute floor is the client's explicit cheap choice (Claude Code's haiku subagents
    // and titles): execute at that rung, never upgraded, not tracked.
    if (reqIdx < start("execute")) return { ...off("client-model:pinned"), class: "execute" };

    const s = promptShape(body);
    const key = sha(s.userId + "\0" + s.system + "\0" + s.firstUser).slice(0, 16);
    const prompt = sha(JSON.stringify(body.messages ?? null));
    const now = Date.now();
    let entry = this.conv.get(key);
    let escalationReason: string | null = null;
    let escalated = false;
    let classReason: string;

    if (entry) {
      classReason = "sticky";
      // Signal: identical prompt re-sent within the retry window = the client gave up on the last answer.
      if (entry.lastPrompt === prompt && now - entry.lastSeen <= this.rc.retryWindowMs) {
        escalationReason = "retry";
        escalated = this.bump(entry, ladder.length);
      }
    } else {
      const c = this.classify(body, s);
      classReason = c.reason;
      entry = { class: c.class, rung: start(c.class), lastSeen: now, lastPrompt: "" };
    }
    const sticky = classReason === "sticky";
    this.touch(key, entry, now, prompt);
    let cls = entry.class;
    let idx = entry.rung;
    if (header === "explore" || header === "execute") {
      // Per-request override: forces the class for this request, leaves the sticky entry alone.
      cls = header;
      idx = start(header);
      classReason = `header:${header}`;
    }
    return { rung: at(this.floor(idx, reqIdx)), class: cls, classReason, conversationKey: key, sticky, escalated, escalationReason };
  }

  /** Feed the response back; bumps the conversation one rung on an observable failure. Returns the reason if one fired. */
  observe(d: Decision, o: Outcome): { escalated: boolean; reason: string | null } {
    const none = { escalated: false, reason: null };
    if (!d.conversationKey || o.aborted) return none;
    const entry = this.conv.get(d.conversationKey);
    if (!entry) return none;
    const reason =
      o.errorStatus === 429 || (o.errorStatus ?? 0) >= 500 ? `bedrock:${o.errorStatus}`
      : o.stopReason === "max_tokens" ? "max_tokens"
      : o.malformedToolJson ? "malformed-tool-json"
      : o.outputTokens === 0 ? "empty"
      : null;
    if (!reason) return none;
    return { escalated: this.bump(entry, this.cfg.families[d.rung.family].length), reason };
  }

  private floor(idx: number, reqIdx: number) { return this.rc.honorClientModel ? Math.max(idx, reqIdx) : idx; }

  private bump(entry: Entry, ladderLen: number): boolean {
    if (entry.rung >= ladderLen - 1) return false; // never past the family's strongest
    entry.rung += 1;
    return true;
  }

  private touch(key: string, entry: Entry, now: number, prompt: string) {
    entry.lastSeen = now;
    entry.lastPrompt = prompt;
    this.conv.delete(key);
    this.conv.set(key, entry);
    if (this.conv.size > this.rc.maxConversations) this.conv.delete(this.conv.keys().next().value!);
  }
}

/** Accumulates streamed tool-call JSON fragments so a truncated/invalid argument object can be detected at end of stream. */
export class ToolJsonCheck {
  private parts = new Map<number, string>();
  add(index: number, fragment: string) { this.parts.set(index, (this.parts.get(index) ?? "") + fragment); }
  malformed(): boolean {
    for (const s of this.parts.values()) { try { JSON.parse(s || "{}"); } catch { return true; } }
    return false;
  }
}
