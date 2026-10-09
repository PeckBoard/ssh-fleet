// The rolling activity log. Every ssh_* tool call appends one record here; the
// dashboard polls `listActivity` with a `since` cursor for live updates. Kept
// in the plugin document store, capped and trimmed so it can't grow unbounded.
//
// Ordering + the poll cursor use a monotonic sequence (see counter.ts), so no
// wall clock is needed; the human `ts` comes from the ssh host-fn response.

import { storeList, storePut, storeDelete } from "./host";
import { nextSeq } from "./counter";

const COLLECTION = "activity";
const CAP = 500;
const PREVIEW_CHARS = 2000; // enough for the dashboard's expandable output

export interface Activity {
  id: number; // monotonic sequence; also the feed cursor
  ts: string | null; // finished_at from the ssh host fn (or best-effort)
  host_id: string | null;
  host_label: string;
  tool: string;
  summary: string;
  ok: boolean;
  exit_code?: number | null;
  duration_ms?: number | null;
  bytes?: number | null;
  stdout_preview?: string;
  stderr_preview?: string;
  error?: string;
  // Compact line diff for ssh_edit_file / content preview for ssh_write_file.
  diff_preview?: string;
  // Who did it and why (absent on entries written before 0.6.0).
  session_id?: string | null;
  session_name?: string | null;
  reason?: string | null;
  source?: "agent" | "dashboard";
}

/// The caller of a tool / dashboard action, stamped onto every activity entry.
/// `session_*` come from core's verified invoke context (never tool args).
export interface Actor {
  session_id?: string | null;
  session_name?: string | null;
  reason?: string | null;
  source: "agent" | "dashboard";
}

export const DASHBOARD: Actor = { source: "dashboard" };

export const REASON_MAX = 300;

/// Validate a tool's `reason` argument: trimmed, ≤ REASON_MAX chars, and
/// non-empty when `required`. Returns the trimmed reason (or undefined).
export function checkReason(v: unknown, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new Error("`reason` is required: one short sentence on why you are running this");
    return undefined;
  }
  if (typeof v !== "string") throw new Error("`reason` must be a string");
  const r = v.trim();
  if (r === "") {
    if (required) throw new Error("`reason` must not be empty: say briefly why you are running this");
    return undefined;
  }
  if (r.length > REASON_MAX) {
    throw new Error(`\`reason\` is too long (${r.length} chars) — keep it under ${REASON_MAX}`);
  }
  return r;
}

/// Build the actor for an MCP tool call from core's invoke payload.
export function actorFrom(payload: any, reason?: string): Actor {
  const ctx = payload?.context ?? {};
  const sid = typeof ctx.sessionId === "string" && ctx.sessionId ? ctx.sessionId : null;
  const sname = typeof ctx.sessionName === "string" && ctx.sessionName ? ctx.sessionName : null;
  return { session_id: sid, session_name: sname, reason: reason ?? null, source: "agent" };
}

function actorFields(a: Actor): Partial<Activity> {
  const out: Partial<Activity> = { source: a.source };
  if (a.session_id) out.session_id = a.session_id;
  if (a.session_name) out.session_name = a.session_name;
  if (a.reason) out.reason = a.reason;
  return out;
}

/// Truncate long output to a bounded preview (full output still goes to the
/// agent; only this capped copy is persisted, keeping records small).
export function preview(s: string | undefined | null): string | undefined {
  if (typeof s !== "string" || s === "") return undefined;
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + " …[truncated]" : s;
}

/// A compact line diff of `before` → `after` for the dashboard: the common
/// leading/trailing lines are trimmed to 2 lines of context, the changed middle
/// is shown as `-` / `+` lines. Capped like the output previews. Not a minimal
/// diff — one changed region — which is what a find/replace edit produces.
export function diffPreview(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const a = before === "" ? [] : before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ctx = 2;
  const out: string[] = [];
  if (pre > ctx) out.push(`@@ line ${pre - ctx + 1}`);
  for (let i = Math.max(0, pre - ctx); i < pre; i++) out.push("  " + a[i]);
  for (let i = pre; i < a.length - suf; i++) out.push("- " + a[i]);
  for (let i = pre; i < b.length - suf; i++) out.push("+ " + b[i]);
  for (let i = a.length - suf; i < Math.min(a.length, a.length - suf + ctx); i++) out.push("  " + a[i]);
  return preview(out.join("\n"));
}

function keyFor(id: number): string {
  const s = String(id);
  return "0".repeat(Math.max(0, 12 - s.length)) + s; // zero-pad → lexicographic == numeric
}

/// Append an event, stamped with its actor, and return the stored record.
export function logActivity(ev: Omit<Activity, "id">, actor?: Actor): Activity {
  const id = nextSeq("activity_seq");
  const rec: Activity = { id, ...ev, ...(actor ? actorFields(actor) : {}) };
  storePut(COLLECTION, keyFor(id), rec);
  trim();
  return rec;
}

/// The feed for the dashboard, oldest-first. Two modes:
/// - `since` (live poll): events newer than `since`, the newest `limit` of them.
///   `cursor` is the id to pass as `since` next poll.
/// - `before` ("Load older"): the `limit` events just older than `before`.
/// `has_more` says whether older events exist beyond the returned page.
export function listActivity(opts: { host?: string; since?: number; before?: number; limit?: number }): {
  items: Activity[];
  cursor: number;
  has_more: boolean;
} {
  const since = typeof opts.since === "number" ? opts.since : 0;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : CAP;
  let items = storeList(COLLECTION)
    .map((i) => i.value as Activity)
    .filter((a) => a && typeof a.id === "number");
  if (opts.host && opts.host !== "all") {
    items = items.filter((a) => a.host_id === opts.host);
  }
  items.sort((a, b) => a.id - b.id);
  if (typeof opts.before === "number" && opts.before > 0) {
    const before = opts.before;
    items = items.filter((a) => a.id < before);
    const has_more = items.length > limit;
    if (has_more) items = items.slice(items.length - limit);
    return { items, cursor: since, has_more };
  }
  items = items.filter((a) => a.id > since);
  const cursor = items.length ? items[items.length - 1].id : since;
  const has_more = items.length > limit;
  if (has_more) items = items.slice(items.length - limit);
  return { items, cursor, has_more };
}

/// Drop the oldest records once the log exceeds the cap.
function trim(): void {
  const all = storeList(COLLECTION).map((i) => ({ key: i.key, id: (i.value as Activity)?.id ?? 0 }));
  if (all.length <= CAP) return;
  all.sort((a, b) => a.id - b.id);
  const excess = all.length - CAP;
  for (let i = 0; i < excess; i++) {
    try {
      storeDelete(COLLECTION, all[i].key);
    } catch (_e) {
      /* trimming is best-effort */
    }
  }
}
