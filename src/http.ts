// HTTP surfaces: the served dashboard page (`http.request.before`) and the
// authenticated app-UI endpoints (`http.request.authed`) the page polls for
// hosts + live activity and uses to run commands. Credentials are never
// returned here — the hosts list goes through `redact`.

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import { listHosts, redact, saveHostFromInput, resolveHost, deleteHost } from "./hosts";
import { runSync, probeSync } from "./tools";
import { sshRun, sshProbeTool } from "./tools";

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
      return jsonResponse(200, { hosts: listHosts().map(redact) });
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
