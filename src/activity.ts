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
const PREVIEW_CHARS = 400;

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
}

/// Truncate long output to a bounded preview (full output still goes to the
/// agent; only this capped copy is persisted, keeping records small).
export function preview(s: string | undefined | null): string | undefined {
  if (typeof s !== "string" || s === "") return undefined;
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + " …[truncated]" : s;
}

function keyFor(id: number): string {
  const s = String(id);
  return "0".repeat(Math.max(0, 12 - s.length)) + s; // zero-pad → lexicographic == numeric
}

/// Append an event and return the stored record (with its assigned id).
export function logActivity(ev: Omit<Activity, "id">): Activity {
  const id = nextSeq("activity_seq");
  const rec: Activity = { id, ...ev };
  storePut(COLLECTION, keyFor(id), rec);
  trim();
  return rec;
}

/// The feed for the dashboard: events newer than `since`, optionally for one
/// host, oldest-first, capped. `cursor` is the id to pass as `since` next poll.
export function listActivity(opts: { host?: string; since?: number; limit?: number }): {
  items: Activity[];
  cursor: number;
} {
  const since = typeof opts.since === "number" ? opts.since : 0;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : CAP;
  let items = storeList(COLLECTION)
    .map((i) => i.value as Activity)
    .filter((a) => a && typeof a.id === "number");
  if (opts.host && opts.host !== "all") {
    items = items.filter((a) => a.host_id === opts.host);
  }
  items = items.filter((a) => a.id > since).sort((a, b) => a.id - b.id);
  const cursor = items.length ? items[items.length - 1].id : since;
  if (items.length > limit) items = items.slice(items.length - limit);
  return { items, cursor };
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
