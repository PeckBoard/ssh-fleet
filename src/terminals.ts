// Interactive terminals are a Peckboard CORE feature (full-size tabs in the
// main app, tmux-backed persistence — see peckboard/src/terminal/). This
// plugin only answers core's two terminal hooks for the hosts it stores:
//
// - `terminal.hosts.list`: the host picker's entries — identity only;
// - `terminal.host.resolve`: one host's connection fields (WITH its secret),
//   asked by core at every connect and automatic reconnect. They go straight
//   back to core, never to a browser, and core never persists them.

import { getSetting } from "./host";
import { getHost, listHosts, toConn, nowIso } from "./hosts";
import { logActivity } from "./activity";

function defTimeout(): number | undefined {
  const v = getSetting("connect_timeout_secs");
  return typeof v === "number" ? v : undefined;
}

/// `terminal.hosts.list` — every stored host, no credentials.
export function terminalHosts(): { hosts: unknown[] } {
  return {
    hosts: listHosts().map((h) => ({
      id: h.id,
      label: h.label || h.hostname,
      hostname: h.hostname,
      username: h.username,
      port: h.port,
      tags: h.tags ?? [],
    })),
  };
}

/// `terminal.host.resolve` — the connection for one host, by exact id.
export function resolveTerminalHost(payload: any): { label: string; conn: unknown } {
  const id = typeof payload?.host_id === "string" ? payload.host_id : "";
  const rec = id ? getHost(id) : null;
  if (!rec) throw new Error(`SSH Fleet has no host '${id}' (was it removed?)`);
  logActivity({
    ts: nowIso() ?? null,
    host_id: rec.id,
    host_label: rec.label,
    tool: "ssh_terminal",
    summary: "interactive terminal connected",
    ok: true,
  });
  return { label: rec.label || rec.hostname, conn: toConn(rec, defTimeout()) };
}
