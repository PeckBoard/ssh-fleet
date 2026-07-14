// MCP tool handlers. Each resolves a host from the registry, runs the operation
// through the native ssh host functions, records an activity entry, and returns
// a result to the agent. Full command output goes to the agent; only a capped
// preview is persisted to the activity log.

import { getSetting, sshProbe, sshExec, sshReadFile, sshWriteFile, SshExecResult } from "./host";
import {
  HostRecord,
  redact,
  toConn,
  listHosts,
  getHost,
  deleteHost,
  resolveHost,
  saveHostFromInput,
  updateHostStatus,
  nowIso,
} from "./hosts";
import { logActivity, preview } from "./activity";
import { utf8ToBase64, base64ToUtf8 } from "./b64";

function reqStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error("`" + name + "` (non-empty string) is required");
  }
  return v;
}

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

/// Short summary for the activity log (never dump a whole command line).
function sm(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + " …" : s;
}

/// Global default connect timeout from the plugin settings, if configured.
function defTimeout(): number | undefined {
  const v = getSetting("connect_timeout_secs");
  return typeof v === "number" ? v : undefined;
}

/// Record + surface a failed operation against a host, then rethrow.
function opError(rec: HostRecord, tool: string, summary: string, e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  updateHostStatus(rec.id, { ok: false, error: msg });
  logActivity({
    ts: nowIso() ?? null,
    host_id: rec.id,
    host_label: rec.label,
    tool,
    summary: sm(summary),
    ok: false,
    error: msg,
  });
  throw e;
}

// ── registry tools ───────────────────────────────────────────────────────────

export function sshHostAdd(args: any): any {
  const host = saveHostFromInput({ ...args, id: undefined });
  logActivity({
    ts: nowIso() ?? null,
    host_id: host.id,
    host_label: host.label,
    tool: "ssh_host_add",
    summary: sm(`added ${host.label} (${host.username}@${host.hostname}:${host.port})`),
    ok: true,
  });
  return { host };
}

export function sshHostUpdate(args: any): any {
  const id = reqStr(args?.id, "id");
  if (!getHost(id)) throw new Error(`no host with id '${id}'`);
  return { host: saveHostFromInput({ ...args, id }) };
}

export function sshHostRemove(args: any): any {
  const rec = resolveHost(args?.host);
  deleteHost(rec.id);
  logActivity({
    ts: nowIso() ?? null,
    host_id: rec.id,
    host_label: rec.label,
    tool: "ssh_host_remove",
    summary: sm(`removed ${rec.label}`),
    ok: true,
  });
  return { removed: rec.id, label: rec.label };
}

export function sshHostList(args: any): any {
  let hosts = listHosts();
  const tag = typeof args?.tag === "string" ? args.tag.trim().toLowerCase() : "";
  if (tag) {
    hosts = hosts.filter((h) => (h.tags || []).some((x) => x.toLowerCase() === tag));
  }
  return { count: hosts.length, hosts: hosts.map(redact) };
}

// ── ssh action tools ─────────────────────────────────────────────────────────

export function sshProbeTool(args: any): any {
  const rec = resolveHost(args?.host);
  const conn = toConn(rec, defTimeout());
  try {
    const r = sshProbe(conn);
    updateHostStatus(rec.id, { ok: true, fingerprint: r.server_fingerprint, at: r.finished_at });
    logActivity({
      ts: r.finished_at ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_probe",
      summary: sm(`probe ${rec.hostname}:${rec.port}`),
      ok: true,
    });
    return { host: rec.label, ok: true, server_fingerprint: r.server_fingerprint, latency_ms: r.latency_ms };
  } catch (e) {
    return opError(rec, "ssh_probe", `probe ${rec.hostname}:${rec.port}`, e);
  }
}

/// Run a command on one host, logging + updating status. Shared by ssh_run and
/// ssh_run_many.
function runExec(rec: HostRecord, command: string, timeoutSecs: number | undefined, tool: string): SshExecResult {
  const conn = toConn(rec, defTimeout());
  try {
    const r = sshExec(conn, command, timeoutSecs);
    updateHostStatus(rec.id, { ok: true, fingerprint: r.server_fingerprint, at: r.finished_at });
    logActivity({
      ts: r.finished_at ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool,
      summary: sm(command),
      ok: r.exit_code === 0 && !r.timed_out,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      stdout_preview: preview(r.stdout),
      stderr_preview: preview(r.stderr),
    });
    return r;
  } catch (e) {
    return opError(rec, tool, command, e);
  }
}

export function sshRun(args: any): any {
  const rec = resolveHost(args?.host);
  const command = reqStr(args?.command, "command");
  const r = runExec(rec, command, numOpt(args?.timeout_secs), "ssh_run");
  return {
    host: rec.label,
    host_id: rec.id,
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    stdout_truncated: r.stdout_truncated,
    stderr_truncated: r.stderr_truncated,
    timed_out: r.timed_out,
    duration_ms: r.duration_ms,
  };
}

/// Resolve the target set for ssh_run_many: explicit hosts[], a tag, or all.
function resolveTargets(args: any): HostRecord[] {
  const out: HostRecord[] = [];
  const seen: Record<string, boolean> = {};
  const push = (r: HostRecord) => {
    if (!seen[r.id]) {
      seen[r.id] = true;
      out.push(r);
    }
  };
  if (args?.all === true) {
    listHosts().forEach(push);
  }
  if (Array.isArray(args?.hosts)) {
    for (const ref of args.hosts) push(resolveHost(ref));
  }
  const tag = typeof args?.tag === "string" ? args.tag.trim().toLowerCase() : "";
  if (tag) {
    listHosts()
      .filter((h) => (h.tags || []).some((x) => x.toLowerCase() === tag))
      .forEach(push);
  }
  if (out.length === 0) {
    throw new Error("no target hosts — pass `hosts` (array), `tag`, or `all: true`");
  }
  return out;
}

export function sshRunMany(args: any): any {
  const command = reqStr(args?.command, "command");
  const timeout = numOpt(args?.timeout_secs);
  const targets = resolveTargets(args);
  const results = targets.map((rec) => {
    try {
      const r = runExec(rec, command, timeout, "ssh_run_many");
      return {
        host: rec.label,
        host_id: rec.id,
        ok: r.exit_code === 0 && !r.timed_out,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        timed_out: r.timed_out,
      };
    } catch (e) {
      return { host: rec.label, host_id: rec.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { count: results.length, ok_count: results.filter((r) => r.ok).length, results };
}

export function sshReadFileTool(args: any): any {
  const rec = resolveHost(args?.host);
  const path = reqStr(args?.path, "path");
  const conn = toConn(rec, defTimeout());
  try {
    const r = sshReadFile(conn, path);
    updateHostStatus(rec.id, { ok: true, fingerprint: r.server_fingerprint, at: r.finished_at });
    logActivity({
      ts: r.finished_at ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_read_file",
      summary: sm(`read ${path}`),
      ok: true,
      bytes: r.size,
    });
    return {
      host: rec.label,
      path,
      size: r.size,
      truncated: r.truncated,
      content: base64ToUtf8(r.content_base64),
      content_base64: r.content_base64,
    };
  } catch (e) {
    return opError(rec, "ssh_read_file", `read ${path}`, e);
  }
}

export function sshWriteFileTool(args: any): any {
  const rec = resolveHost(args?.host);
  const path = reqStr(args?.path, "path");
  let b64: string;
  if (typeof args?.content_base64 === "string") {
    b64 = args.content_base64;
  } else if (typeof args?.content === "string") {
    b64 = utf8ToBase64(args.content);
  } else {
    throw new Error("provide `content` (text) or `content_base64` (binary)");
  }
  const conn = toConn(rec, defTimeout());
  try {
    const r = sshWriteFile(conn, path, b64);
    updateHostStatus(rec.id, { ok: true, fingerprint: r.server_fingerprint, at: r.finished_at });
    logActivity({
      ts: r.finished_at ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_write_file",
      summary: sm(`write ${path}`),
      ok: true,
      bytes: r.bytes,
    });
    return { host: rec.label, path, bytes: r.bytes };
  } catch (e) {
    return opError(rec, "ssh_write_file", `write ${path}`, e);
  }
}

export function sshEditFileTool(args: any): any {
  const rec = resolveHost(args?.host);
  const path = reqStr(args?.path, "path");
  const conn = toConn(rec, defTimeout());

  // Read current contents (a full-content edit may target a new file).
  let current = "";
  try {
    current = base64ToUtf8(sshReadFile(conn, path).content_base64);
  } catch (e) {
    if (typeof args?.content !== "string") {
      return opError(rec, "ssh_edit_file", `edit ${path}`, e);
    }
  }

  let next: string;
  let replacements: number | undefined;
  if (typeof args?.content === "string") {
    next = args.content; // full replacement / create
  } else if (typeof args?.find === "string" && args.find !== "") {
    const replace = typeof args?.replace === "string" ? args.replace : "";
    const parts = current.split(args.find);
    replacements = parts.length - 1;
    if (replacements === 0) {
      throw new Error(`find string not found in ${path}`);
    }
    if (numOpt(args?.expect_count) !== undefined && args.expect_count !== replacements) {
      throw new Error(`expected ${args.expect_count} replacement(s) but found ${replacements}`);
    }
    next = parts.join(replace);
  } else {
    throw new Error("provide `content` (full replacement) or `find` (+ optional `replace`)");
  }

  try {
    const w = sshWriteFile(conn, path, utf8ToBase64(next));
    updateHostStatus(rec.id, { ok: true, fingerprint: w.server_fingerprint, at: w.finished_at });
    logActivity({
      ts: w.finished_at ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_edit_file",
      summary: sm(`edit ${path}`),
      ok: true,
      bytes: w.bytes,
    });
    const out: any = { host: rec.label, path, bytes: w.bytes };
    if (replacements !== undefined) out.replacements = replacements;
    return out;
  } catch (e) {
    return opError(rec, "ssh_edit_file", `edit ${path}`, e);
  }
}
