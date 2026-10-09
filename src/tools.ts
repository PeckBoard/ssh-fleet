// MCP tool handlers. Slow SSH tools use the DEFER protocol: phase 1 resolves a
// host from the registry and returns the op for core to run with the plugin
// instance FREE (see the Rust `Verdict::Defer` loop); core then re-enters the
// matching finalizer with the op result to update status, record activity, and
// format the agent-facing result. Registry tools (add/update/remove/list) are
// pure document-store operations and stay synchronous. Full command output goes
// to the agent; only a capped preview is persisted to the activity log.
//
// Every handler receives the `Actor` (calling session + the agent's `reason`),
// stamped onto each activity entry so the dashboard can show who ran what, and
// why. Command/write tools require a reason; it is validated in phase 1, before
// anything touches a host.

import { getSetting, sshProbe } from "./host";
import {
  HostRecord,
  redact,
  keyNameMap,
  toConn,
  listHosts,
  getHost,
  deleteHost,
  resolveHost,
  saveHostFromInput,
  updateHostStatus,
  nowIso,
  buildRecord,
} from "./hosts";
import { Actor, logActivity, preview, diffPreview } from "./activity";
import { deferReq } from "./verdict";
import { utf8ToBase64, base64ToUtf8 } from "./b64";

/// Tools whose call must carry a non-empty `reason` (they run commands or
/// change remote files). Read/probe tools accept an optional one.
export const REASON_REQUIRED_TOOLS: Record<string, boolean> = {
  ssh_run: true,
  ssh_run_many: true,
  ssh_write_file: true,
  ssh_edit_file: true,
  ssh_read_file: false,
  ssh_probe: false,
};

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

/// The connection fields core needs to run an op, carrying the per-plugin
/// connect-timeout setting. Credentials travel only here — never in `resume`.
function connFields(rec: HostRecord): any {
  return toConn(rec, defTimeout());
}

/// Record a failed op against a host (status + activity) in the finalize phase.
/// Callers decide whether to surface the error (single-host tools) or collect
/// it (ssh_run_many).
function recordFailure(id: string, label: string, tool: string, summary: string, error: string, actor: Actor): void {
  updateHostStatus(id, { ok: false, error });
  logActivity(
    {
      ts: nowIso() ?? null,
      host_id: id,
      host_label: label,
      tool,
      summary: sm(summary),
      ok: false,
      error,
    },
    actor,
  );
}

// ── registry tools (synchronous — pure document-store operations) ────────────

export function sshHostAdd(args: any, actor: Actor): any {
  const host = saveHostFromInput({ ...args, id: undefined });
  logActivity(
    {
      ts: nowIso() ?? null,
      host_id: host.id,
      host_label: host.label,
      tool: "ssh_host_add",
      summary: sm(`added ${host.label} (${host.username}@${host.hostname}:${host.port})`),
      ok: true,
    },
    actor,
  );
  return { host };
}

export function sshHostUpdate(args: any, _actor: Actor): any {
  const id = reqStr(args?.id, "id");
  if (!getHost(id)) throw new Error(`no host with id '${id}'`);
  return { host: saveHostFromInput({ ...args, id }) };
}

export function sshHostRemove(args: any, actor: Actor): any {
  const rec = resolveHost(args?.host);
  deleteHost(rec.id);
  logActivity(
    {
      ts: nowIso() ?? null,
      host_id: rec.id,
      host_label: rec.label,
      tool: "ssh_host_remove",
      summary: sm(`removed ${rec.label}`),
      ok: true,
    },
    actor,
  );
  return { removed: rec.id, label: rec.label };
}

export function sshHostList(args: any, _actor: Actor): any {
  let hosts = listHosts();
  const tag = typeof args?.tag === "string" ? args.tag.trim().toLowerCase() : "";
  if (tag) {
    hosts = hosts.filter((h) => (h.tags || []).some((x) => x.toLowerCase() === tag));
  }
  const names = keyNameMap(hosts);
  return { count: hosts.length, hosts: hosts.map((h) => redact(h, names)) };
}

// ── ssh_probe ───────────────────────────────────────────────────────

export function sshProbeTool(args: any, _actor: Actor): any {
  const rec = resolveHost(args?.host);
  return deferReq(
    { kind: "probe", ...connFields(rec) },
    { id: rec.id, label: rec.label, hostname: rec.hostname, port: rec.port },
  );
}

export function sshProbeFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  const summary = `probe ${resume.hostname}:${resume.port}`;
  if (res && res.error) {
    recordFailure(resume.id, resume.label, "ssh_probe", summary, String(res.error), actor);
    throw new Error(String(res.error));
  }
  updateHostStatus(resume.id, { ok: true, fingerprint: res.server_fingerprint, at: res.finished_at });
  logActivity(
    {
      ts: res.finished_at ?? null,
      host_id: resume.id,
      host_label: resume.label,
      tool: "ssh_probe",
      summary: sm(summary),
      ok: true,
      duration_ms: res.latency_ms,
    },
    actor,
  );
  return { host: resume.label, ok: true, server_fingerprint: res.server_fingerprint, latency_ms: res.latency_ms };
}

// ── ssh_run / ssh_run_many ──────────────────────────────────────────

/// Turn one core `exec` op-result into activity + the ssh_run result body.
/// Throws on an error op-result (the caller maps that to a tool error, or
/// collects it for ssh_run_many).
function finalizeExec(tool: string, id: string, label: string, command: string, res: any, actor: Actor): any {
  if (res && res.error) {
    recordFailure(id, label, tool, command, String(res.error), actor);
    throw new Error(String(res.error));
  }
  updateHostStatus(id, { ok: true, fingerprint: res.server_fingerprint, at: res.finished_at });
  logActivity(
    {
      ts: res.finished_at ?? null,
      host_id: id,
      host_label: label,
      tool,
      summary: sm(command),
      ok: res.exit_code === 0 && !res.timed_out,
      exit_code: res.exit_code,
      duration_ms: res.duration_ms,
      stdout_preview: preview(res.stdout),
      stderr_preview: preview(res.stderr),
    },
    actor,
  );
  return {
    exit_code: res.exit_code,
    stdout: res.stdout,
    stderr: res.stderr,
    stdout_truncated: res.stdout_truncated,
    stderr_truncated: res.stderr_truncated,
    timed_out: res.timed_out,
    duration_ms: res.duration_ms,
  };
}

export function sshRun(args: any, _actor: Actor): any {
  const rec = resolveHost(args?.host);
  const command = reqStr(args?.command, "command");
  const op: any = { kind: "exec", ...connFields(rec), command };
  const t = numOpt(args?.timeout_secs);
  if (t !== undefined) op.timeout_secs = t;
  return deferReq(op, { id: rec.id, label: rec.label, command });
}

export function sshRunFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  const r = finalizeExec("ssh_run", resume.id, resume.label, resume.command, res, actor);
  return { host: resume.label, host_id: resume.id, ...r };
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

export function sshRunMany(args: any, _actor: Actor): any {
  const command = reqStr(args?.command, "command");
  const t = numOpt(args?.timeout_secs);
  const targets = resolveTargets(args);
  const ops = targets.map((rec) => {
    const op: any = { kind: "exec", ...connFields(rec), command };
    if (t !== undefined) op.timeout_secs = t;
    return op;
  });
  return deferReq(
    { kind: "batch", ops },
    { command, targets: targets.map((r) => ({ id: r.id, label: r.label })) },
  );
}

export function sshRunManyFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  const arr: any[] = res && Array.isArray(res.results) ? res.results : [];
  const results = (resume.targets as Array<{ id: string; label: string }>).map((t, i) => {
    try {
      const r = finalizeExec("ssh_run_many", t.id, t.label, resume.command, arr[i], actor);
      return {
        host: t.label,
        host_id: t.id,
        ok: r.exit_code === 0 && !r.timed_out,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        timed_out: r.timed_out,
      };
    } catch (e) {
      return { host: t.label, host_id: t.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { count: results.length, ok_count: results.filter((r) => r.ok).length, results };
}

// ── ssh_read_file / ssh_write_file ────────────────────────────────────

export function sshReadFileTool(args: any, _actor: Actor): any {
  const rec = resolveHost(args?.host);
  const path = reqStr(args?.path, "path");
  return deferReq({ kind: "read_file", ...connFields(rec), path }, { id: rec.id, label: rec.label, path });
}

export function sshReadFileFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  if (res && res.error) {
    recordFailure(resume.id, resume.label, "ssh_read_file", `read ${resume.path}`, String(res.error), actor);
    throw new Error(String(res.error));
  }
  updateHostStatus(resume.id, { ok: true, fingerprint: res.server_fingerprint, at: res.finished_at });
  logActivity(
    {
      ts: res.finished_at ?? null,
      host_id: resume.id,
      host_label: resume.label,
      tool: "ssh_read_file",
      summary: sm(`read ${resume.path}`),
      ok: true,
      bytes: res.size,
      stdout_preview: preview(base64ToUtf8(res.content_base64 ?? "")),
    },
    actor,
  );
  return {
    host: resume.label,
    path: resume.path,
    size: res.size,
    truncated: res.truncated,
    content: base64ToUtf8(res.content_base64),
    content_base64: res.content_base64,
  };
}

export function sshWriteFileTool(args: any, _actor: Actor): any {
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
  return deferReq(
    { kind: "write_file", ...connFields(rec), path, content_base64: b64 },
    // The written text (capped) shows as an all-added diff on the dashboard.
    { id: rec.id, label: rec.label, path, diff: typeof args?.content === "string" ? diffPreview("", args.content) : undefined },
  );
}

export function sshWriteFileFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  if (res && res.error) {
    recordFailure(resume.id, resume.label, "ssh_write_file", `write ${resume.path}`, String(res.error), actor);
    throw new Error(String(res.error));
  }
  updateHostStatus(resume.id, { ok: true, fingerprint: res.server_fingerprint, at: res.finished_at });
  logActivity(
    {
      ts: res.finished_at ?? null,
      host_id: resume.id,
      host_label: resume.label,
      tool: "ssh_write_file",
      summary: sm(`write ${resume.path}`),
      ok: true,
      bytes: res.bytes,
      diff_preview: resume.diff,
    },
    actor,
  );
  return { host: resume.label, path: resume.path, bytes: res.bytes };
}

// ── ssh_edit_file (read-modify-write: two defer round-trips) ────────────────

export function sshEditFileTool(args: any, _actor: Actor): any {
  const rec = resolveHost(args?.host);
  const path = reqStr(args?.path, "path");
  // Phase 1: read the current contents. A full-content edit may target a new
  // file, so a read error is tolerated in finalize when `content` is given.
  return deferReq(
    { kind: "read_file", ...connFields(rec), path },
    {
      stage: "read",
      id: rec.id,
      label: rec.label,
      path,
      content: typeof args?.content === "string" ? args.content : undefined,
      find: typeof args?.find === "string" ? args.find : undefined,
      replace: typeof args?.replace === "string" ? args.replace : undefined,
      expect_count: numOpt(args?.expect_count),
    },
  );
}

export function sshEditFileFinalize(_args: any, resume: any, res: any, actor: Actor): any {
  if (resume.stage === "read") {
    // Compute the new content from the read result, then defer the write.
    let current = "";
    if (res && res.error) {
      if (resume.content === undefined) {
        recordFailure(resume.id, resume.label, "ssh_edit_file", `edit ${resume.path}`, String(res.error), actor);
        throw new Error(String(res.error));
      }
    } else {
      current = base64ToUtf8(res.content_base64);
    }

    let next: string;
    let replacements: number | undefined;
    if (resume.content !== undefined) {
      next = resume.content; // full replacement / create
    } else if (typeof resume.find === "string" && resume.find !== "") {
      const replace = typeof resume.replace === "string" ? resume.replace : "";
      const parts = current.split(resume.find);
      replacements = parts.length - 1;
      if (replacements === 0) {
        throw new Error(`find string not found in ${resume.path}`);
      }
      if (resume.expect_count !== undefined && resume.expect_count !== replacements) {
        throw new Error(`expected ${resume.expect_count} replacement(s) but found ${replacements}`);
      }
      next = parts.join(replace);
    } else {
      throw new Error("provide `content` (full replacement) or `find` (+ optional `replace`)");
    }

    // Re-resolve the host by id so credentials are rebuilt here, not carried
    // through `resume`.
    const rec = getHost(resume.id);
    if (!rec) {
      throw new Error(`host '${resume.id}' no longer exists`);
    }
    return deferReq(
      { kind: "write_file", ...connFields(rec), path: resume.path, content_base64: utf8ToBase64(next) },
      {
        stage: "write",
        id: resume.id,
        label: resume.label,
        path: resume.path,
        replacements,
        diff: diffPreview(current, next),
      },
    );
  }

  // stage === "write": the edit landed.
  if (res && res.error) {
    recordFailure(resume.id, resume.label, "ssh_edit_file", `edit ${resume.path}`, String(res.error), actor);
    throw new Error(String(res.error));
  }
  updateHostStatus(resume.id, { ok: true, fingerprint: res.server_fingerprint, at: res.finished_at });
  logActivity(
    {
      ts: res.finished_at ?? null,
      host_id: resume.id,
      host_label: resume.label,
      tool: "ssh_edit_file",
      summary: sm(`edit ${resume.path}`),
      ok: true,
      bytes: res.bytes,
      diff_preview: resume.diff,
    },
    actor,
  );
  const out: any = { host: resume.label, path: resume.path, bytes: res.bytes };
  if (resume.replacements !== undefined) out.replacements = resume.replacements;
  return out;
}

// ── dashboard connectivity test ─────────────────────────────────────────────
//
// The dashboard's per-host "Test" button. It only connects + authenticates (no
// command, nothing user-supplied reaches the host) — the page deliberately has
// no way to run commands; that is the agents' job, under an audited reason.
// Plain request/response (no core defer loop), so it runs synchronously.

export function probeSync(args: any, actor: Actor): any {
  const rec = resolveHost(args?.host);
  const conn = toConn(rec, defTimeout());
  const summary = `probe ${rec.hostname}:${rec.port}`;
  try {
    const r = sshProbe(conn);
    updateHostStatus(rec.id, { ok: true, fingerprint: r.server_fingerprint, at: r.finished_at });
    logActivity(
      {
        ts: r.finished_at ?? null,
        host_id: rec.id,
        host_label: rec.label,
        tool: "ssh_probe",
        summary: sm(summary),
        ok: true,
        duration_ms: r.latency_ms,
      },
      actor,
    );
    return { host: rec.label, ok: true, server_fingerprint: r.server_fingerprint, latency_ms: r.latency_ms };
  } catch (e) {
    recordFailure(rec.id, rec.label, "ssh_probe", summary, e instanceof Error ? e.message : String(e), actor);
    throw e;
  }
}

/// The add/edit form's "Test connection": probe the connection the form
/// describes WITHOUT saving it (an edit's omitted credential falls back to the
/// stored one). Connect + authenticate only; no status or activity is written.
export function probeDraft(input: any): any {
  const id = typeof input?.id === "string" && input.id ? input.id : null;
  const existing = id ? getHost(id) : null;
  const rec = buildRecord(input, existing, () => "draft");
  const r = sshProbe(toConn(rec, defTimeout()));
  return { ok: true, server_fingerprint: r.server_fingerprint, latency_ms: r.latency_ms };
}