// HTTP surfaces: the served dashboard page (`http.request.before`) and the
// authenticated app-UI endpoints (`http.request.authed`) the page polls for
// hosts + live activity, uses to run commands, and uses to open / list /
// close interactive terminals. Credentials are never returned here — the
// hosts list goes through `redact`, and a terminal's view carries only its
// identity (user@host:port) and state.

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import { listHosts, redact, keyNameMap, saveHostFromInput, resolveHost, deleteHost } from "./hosts";
import { sshKeyList } from "./host";
import { listActivity } from "./activity";
import { runSync, probeSync } from "./tools";
import { openTerminal, listTerminals, closeTerminal } from "./terminals";

const PAGE_PATH = "/plugin-api/v1/ssh-fleet";
const API = "/api/plugin-ui/ssh-fleet";

function up(v: unknown): string {
  return (typeof v === "string" ? v : "").toUpperCase();
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function parseBody(body: string): any {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("invalid request body: " + errMsg(e));
  }
}

/// Serve the dashboard page (the sidebar item opens this).
export function serveHttp(payload: any): string {
  if (up(payload?.method) === "GET" && str(payload?.path) === PAGE_PATH) {
    return htmlResponse(200, PAGE);
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}

/// Authenticated app-UI endpoints under /api/plugin-ui/ssh-fleet/*.
export function serveAuthed(payload: any): string {
  const method = up(payload?.method);
  const path = str(payload?.path);
  const query = str(payload?.query);
  const body = str(payload?.body);

  try {
    if (method === "GET" && path === `${API}/hosts`) {
      const hosts = listHosts();
      const names = keyNameMap(hosts);
      return jsonResponse(200, { hosts: hosts.map((h) => redact(h, names)) });
    }
    // The vault-key picker in the add/edit form. Metadata only — core never
    // hands the plugin key material.
    if (method === "GET" && path === `${API}/ssh-keys`) {
      return jsonResponse(200, { keys: sshKeyList() });
    }
    if (method === "POST" && path === `${API}/hosts`) {
      return jsonResponse(200, { host: saveHostFromInput(parseBody(body)) });
    }
    if (method === "POST" && path === `${API}/host-remove`) {
      const b = parseBody(body);
      const rec = resolveHost(b?.id ?? b?.host);
      deleteHost(rec.id);
      return jsonResponse(200, { removed: rec.id });
    }
    if (method === "GET" && path === `${API}/activity`) {
      const host = queryParam(query, "host");
      const sinceRaw = Number(queryParam(query, "since") || "0");
      return jsonResponse(200, listActivity({ host, since: isFinite(sinceRaw) ? sinceRaw : 0 }));
    }
    if (method === "POST" && path === `${API}/probe`) {
      const b = parseBody(body);
      return jsonResponse(200, probeSync({ host: b?.host }));
    }
    if (method === "POST" && path === `${API}/run`) {
      const b = parseBody(body);
      return jsonResponse(200, runSync({ host: b?.host, command: b?.command, timeout_secs: b?.timeout_secs }));
    }
    // Interactive terminals: the shells live in core; the page attaches to
    // one over /ws/terminal with a plugin-scoped ticket (see page.ts).
    if (method === "GET" && path === `${API}/terminals`) {
      return jsonResponse(200, listTerminals());
    }
    if (method === "POST" && path === `${API}/terminals`) {
      const b = parseBody(body);
      return jsonResponse(200, openTerminal({ host: b?.host, cols: b?.cols, rows: b?.rows }));
    }
    if (method === "POST" && path === `${API}/terminal-close`) {
      const b = parseBody(body);
      return jsonResponse(200, closeTerminal({ id: b?.id }));
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

/// Extract and URL-decode `name`'s value from a `&`-separated query string.
export function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) !== name) continue;
    const v = pair.slice(idx + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, "%20"));
    } catch (_e) {
      return v;
    }
  }
  return undefined;
}
