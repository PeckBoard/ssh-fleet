// Shared response helpers: verdict envelopes and small HTTP wrappers. Pure —
// safe to import under vitest without an Extism runtime.

/// A `Verdict::Skip`.
export function skip(): string {
  return JSON.stringify({ verdict: "skip" });
}

/// A `Verdict::Allow` carrying an MCP tool result value.
export function allow(value: unknown): string {
  return JSON.stringify({ verdict: "allow", payload: value });
}

/// A `Verdict::Cancel` with a reason (an MCP tool error / refusal).
export function cancel(reason: string): string {
  return JSON.stringify({ verdict: "cancel", reason });
}
/// A `Verdict::Defer`: hand `op` to core to run with the plugin instance FREE
/// (so a slow SSH op doesn't hold the single-instance lock), plus an opaque
/// `resume` value core echoes back. Core re-enters `handle` with the original
/// payload plus `{resume, op_result}` for the finalize phase.
export function defer(op: unknown, resume: unknown): string {
  return JSON.stringify({ verdict: "defer", op, resume });
}

/// A phase-1 tool's request to defer: `handleInvoke` turns this into a
/// `defer()` verdict. Kept as an in-process sentinel (never serialized as-is)
/// so tool handlers can stay plain functions.
export interface DeferReq {
  __defer__: { op: unknown; resume: unknown };
}

/// Build a [`DeferReq`] sentinel.
export function deferReq(op: unknown, resume: unknown): DeferReq {
  return { __defer__: { op, resume } };
}

/// Is `v` a [`DeferReq`] sentinel (vs a plain tool result)?
export function isDeferReq(v: unknown): v is DeferReq {
  return typeof v === "object" && v !== null && "__defer__" in v;
}


/// Wrap a JSON value as a `Verdict::Allow` HTTP response.
export function jsonResponse(status: number, value: unknown): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  });
}

/// Wrap an HTML body as a `Verdict::Allow` HTTP response.
export function htmlResponse(status: number, body: string): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
    },
  });
}

/// Stringify a caught error to a message string.
export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
