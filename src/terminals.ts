// Interactive terminals for the dashboard: open a PTY shell on a registered
// host, list the ones core still holds open, close one. The shells live in
// CORE (see peckboard/src/plugin/ssh_term.rs) — this module only resolves the
// host record into connection fields for the `peckboard_ssh_term_*` host
// functions and records the activity. Like the dashboard's /run route, these
// run synchronously inside the authed request (an explicit user action).

import { getSetting, sshTermOpen, sshTermList, sshTermClose, TerminalInfo } from "./host";
import { resolveHost, toConn, updateHostStatus, nowIso } from "./hosts";
import { logActivity } from "./activity";

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

function defTimeout(): number | undefined {
  const v = getSetting("connect_timeout_secs");
  return typeof v === "number" ? v : undefined;
}

/// `POST /terminals` — open a shell on `host` (id / label / hostname) sized
/// `cols`×`rows`. Returns core's view of the new terminal.
export function openTerminal(args: any): { terminal: TerminalInfo } {
  const rec = resolveHost(args?.host);
  const conn = toConn(rec, defTimeout());
  try {
    const terminal = sshTermOpen(conn, {
      label: rec.label,
      host_id: rec.id,
      cols: numOpt(args?.cols),
      rows: numOpt(args?.rows),
    });
    updateHostStatus(rec.id, { ok: true });
    logActivity({
      ts: nowIso() ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_terminal",
      summary: "opened interactive terminal",
      ok: true,
    });
    return { terminal };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    updateHostStatus(rec.id, { ok: false, error });
    logActivity({
      ts: nowIso() ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_terminal",
      summary: "open interactive terminal",
      ok: false,
      error,
    });
    throw e;
  }
}

/// `GET /terminals` — every terminal core still holds for this plugin,
/// including ones whose shell has exited (kept, with scrollback, until closed).
export function listTerminals(): { terminals: TerminalInfo[] } {
  return { terminals: sshTermList() };
}

/// `POST /terminal-close` — end the shell and drop it.
export function closeTerminal(args: any): { closed: string } {
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("`id` is required");
  const t = sshTermClose(id);
  logActivity({
    ts: nowIso() ?? null,
    host_id: t.host_id,
    host_label: t.label,
    tool: "ssh_terminal",
    summary: "closed interactive terminal",
    ok: true,
  });
  return { closed: id };
}
