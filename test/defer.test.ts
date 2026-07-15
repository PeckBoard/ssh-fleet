import { describe, it, expect, beforeEach } from "vitest";
import { dispatch } from "../src/lib";
import { defer, deferReq, isDeferReq } from "../src/verdict";
import { serveAuthed } from "../src/http";

// ── Pure verdict helpers ─────────────────────────────────────────────────────

describe("defer verdict", () => {
  it("serializes a defer verdict", () => {
    expect(JSON.parse(defer({ kind: "exec" }, { id: "h1" }))).toEqual({
      verdict: "defer",
      op: { kind: "exec" },
      resume: { id: "h1" },
    });
  });

  it("deferReq round-trips through isDeferReq", () => {
    expect(isDeferReq(deferReq({ kind: "probe" }, { id: "h1" }))).toBe(true);
    expect(isDeferReq({ foo: 1 })).toBe(false);
    expect(isDeferReq(null)).toBe(false);
  });
});

// ── In-memory Host/Memory shim ───────────────────────────────────────────────
//
// The tool logic drives the plugin document-store + settings host functions.
// This shim backs them with a plain object so the phase-1 emit and phase-2
// finalize paths run under vitest without an Extism runtime (mirrors how the
// real host functions marshal JSON through Memory offsets).

type Store = Record<string, Record<string, any>>;

function installHost(
  store: Store,
  settings: Record<string, any> = {},
  ssh: { exec?: (input: any) => any; probe?: (input: any) => any } = {},
): Store {
  const bufs = new Map<bigint, string>();
  let next = 1n;
  const put = (s: string): bigint => {
    const off = next++;
    bufs.set(off, s);
    return off;
  };
  const read = (off: bigint) => JSON.parse(bufs.get(off)!);
  const fns: Record<string, (off: bigint) => bigint> = {
    peckboard_get_plugin_setting: (off) => put(JSON.stringify({ value: settings[read(off).key] ?? null })),
    peckboard_store_get: (off) => {
      const { collection, key } = read(off);
      return put(JSON.stringify({ value: store[collection]?.[key] ?? null }));
    },
    peckboard_store_put: (off) => {
      const { collection, key, data } = read(off);
      (store[collection] ||= {})[key] = data;
      return put(JSON.stringify({ ok: true }));
    },
    peckboard_store_list: (off) => {
      const { collection } = read(off);
      const items = Object.entries(store[collection] ?? {}).map(([key, value]) => ({ key, value }));
      return put(JSON.stringify({ items }));
    },
    peckboard_store_delete: (off) => {
      const { collection, key } = read(off);
      if (store[collection]) delete store[collection][key];
      return put(JSON.stringify({ ok: true }));
    },
    peckboard_ssh_exec: (off) =>
      put(JSON.stringify(ssh.exec ? ssh.exec(read(off)) : { error: "no ssh_exec mock" })),
    peckboard_ssh_probe: (off) =>
      put(JSON.stringify(ssh.probe ? ssh.probe(read(off)) : { error: "no ssh_probe mock" })),
  };
  (globalThis as any).Host = { getFunctions: () => fns };
  (globalThis as any).Memory = {
    fromString: (s: string) => ({ offset: put(s) }),
    find: (off: bigint) => ({ readString: () => bufs.get(off)! }),
  };
  return store;
}

const pwHost = (id: string, label: string, host: string, secret: string) => ({
  id,
  label,
  hostname: host,
  port: 22,
  username: "root",
  auth_kind: "password",
  password: secret,
  last_status: "unknown",
});

const invoke = (payload: any) => JSON.parse(dispatch("mcp.tool.invoke", payload));

// ── ssh_run ──────────────────────────────────────────────────────────────────

describe("ssh_run defer protocol", () => {
  let store: Store;
  beforeEach(() => {
    store = installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } });
  });

  it("phase 1 emits an exec defer carrying the connection + resume", () => {
    const v = invoke({ tool: "ssh_run", arguments: { host: "web1", command: "uptime", timeout_secs: 5 } });
    expect(v.verdict).toBe("defer");
    expect(v.op).toMatchObject({
      kind: "exec",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      command: "uptime",
      timeout_secs: 5,
      auth: { password: "s3cret" },
    });
    expect(v.resume).toEqual({ id: "h1", label: "web1", command: "uptime" });
  });

  it("finalize turns a core op_result into the tool result and logs activity", () => {
    const v = invoke({
      tool: "ssh_run",
      arguments: { host: "web1", command: "uptime" },
      resume: { id: "h1", label: "web1", command: "uptime" },
      op_result: {
        ok: true,
        exit_code: 0,
        stdout: "up 3 days",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        timed_out: false,
        server_fingerprint: "SHA256:aaa",
        finished_at: "2026-07-15T00:00:00Z",
        duration_ms: 12,
      },
    });
    expect(v.verdict).toBe("allow");
    expect(v.payload).toMatchObject({ host: "web1", host_id: "h1", exit_code: 0, stdout: "up 3 days", timed_out: false });
    expect(store.hosts.h1.last_status).toBe("ok");
    expect(store.hosts.h1.last_fingerprint).toBe("SHA256:aaa");
    const activity = Object.values(store.activity ?? {});
    expect(activity.length).toBe(1);
    expect(activity[0]).toMatchObject({ tool: "ssh_run", host_id: "h1", ok: true, exit_code: 0 });
  });

  it("finalize surfaces an error op_result as a tool error and records failure", () => {
    const v = invoke({
      tool: "ssh_run",
      arguments: { host: "web1", command: "boom" },
      resume: { id: "h1", label: "web1", command: "boom" },
      op_result: { error: "connect failed: timed out" },
    });
    expect(v.verdict).toBe("allow");
    expect(v.payload.error).toContain("connect failed");
    expect(store.hosts.h1.last_status).toBe("error");
    expect(store.hosts.h1.last_error).toContain("connect failed");
  });
});

// ── ssh_run_many ─────────────────────────────────────────────────────────────

describe("ssh_run_many defer protocol", () => {
  let store: Store;
  beforeEach(() => {
    store = installHost({
      hosts: {
        h1: pwHost("h1", "web1", "10.0.0.1", "a"),
        h2: pwHost("h2", "web2", "10.0.0.2", "b"),
      },
    });
  });

  it("phase 1 emits a batch op over all targets", () => {
    const v = invoke({ tool: "ssh_run_many", arguments: { all: true, command: "hostname" } });
    expect(v.verdict).toBe("defer");
    expect(v.op.kind).toBe("batch");
    expect(v.op.ops).toHaveLength(2);
    expect(v.op.ops.every((o: any) => o.kind === "exec" && o.command === "hostname")).toBe(true);
    expect(v.resume.targets).toHaveLength(2);
  });

  it("finalize maps per-host results in order, collecting failures", () => {
    const v = invoke({
      tool: "ssh_run_many",
      arguments: { all: true, command: "hostname" },
      resume: {
        command: "hostname",
        targets: [
          { id: "h1", label: "web1" },
          { id: "h2", label: "web2" },
        ],
      },
      op_result: {
        results: [
          {
            ok: true,
            exit_code: 0,
            stdout: "web1",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            server_fingerprint: "SHA256:1",
            finished_at: "t",
            duration_ms: 1,
          },
          { error: "auth failed" },
        ],
      },
    });
    expect(v.verdict).toBe("allow");
    expect(v.payload.count).toBe(2);
    expect(v.payload.ok_count).toBe(1);
    expect(v.payload.results[0]).toMatchObject({ host: "web1", ok: true, exit_code: 0, stdout: "web1" });
    expect(v.payload.results[1]).toMatchObject({ host: "web2", ok: false, error: "auth failed" });
  });
});

// ── ssh_edit_file (two-stage defer: read → write) ────────────────────────────

describe("ssh_edit_file two-stage defer", () => {
  beforeEach(() => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "a") } });
  });

  it("phase 1 defers a read", () => {
    const v = invoke({ tool: "ssh_edit_file", arguments: { host: "web1", path: "/etc/motd", find: "old", replace: "new" } });
    expect(v.verdict).toBe("defer");
    expect(v.op).toMatchObject({ kind: "read_file", path: "/etc/motd" });
    expect(v.resume).toMatchObject({ stage: "read", path: "/etc/motd", find: "old", replace: "new" });
  });

  it("read finalize applies the edit and defers a write", () => {
    const current = Buffer.from("hello old world", "utf8").toString("base64");
    const v = invoke({
      tool: "ssh_edit_file",
      arguments: {},
      resume: { stage: "read", id: "h1", label: "web1", path: "/etc/motd", find: "old", replace: "new" },
      op_result: { ok: true, content_base64: current, size: 15, truncated: false, server_fingerprint: "x", finished_at: "t" },
    });
    expect(v.verdict).toBe("defer");
    expect(v.op.kind).toBe("write_file");
    expect(Buffer.from(v.op.content_base64, "base64").toString("utf8")).toBe("hello new world");
    expect(v.resume).toMatchObject({ stage: "write", replacements: 1 });
  });

  it("write finalize returns the result", () => {
    const v = invoke({
      tool: "ssh_edit_file",
      arguments: {},
      resume: { stage: "write", id: "h1", label: "web1", path: "/etc/motd", replacements: 1 },
      op_result: { ok: true, bytes: 15, server_fingerprint: "x", finished_at: "t" },
    });
    expect(v.verdict).toBe("allow");
    expect(v.payload).toMatchObject({ host: "web1", path: "/etc/motd", bytes: 15, replacements: 1 });
  });
});

// ── Dashboard HTTP routes run synchronously (NOT via defer) ─────────────────
//
// Regression: /run and /probe are request/response and don't go through the
// core defer loop, so they must return a real result — not a `deferReq`
// sentinel, which rendered "exit undefined" on the dashboard.

describe("dashboard run/probe routes", () => {
  it("POST /run returns a real exec result, not a defer sentinel", () => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } }, {}, {
      exec: () => ({
        ok: true,
        exit_code: 0,
        stdout: "hi",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        timed_out: false,
        server_fingerprint: "SHA256:x",
        started_at: "t",
        finished_at: "t",
        duration_ms: 5,
      }),
    });
    const resp = JSON.parse(
      serveAuthed({
        method: "POST",
        path: "/api/plugin-ui/ssh-fleet/run",
        query: "",
        body: JSON.stringify({ host: "web1", command: "echo hi" }),
      }),
    );
    expect(resp.verdict).toBe("allow");
    const result = JSON.parse(resp.payload.body);
    expect(result.__defer__).toBeUndefined();
    expect(result).toMatchObject({ host: "web1", host_id: "h1", exit_code: 0, stdout: "hi" });
  });

  it("POST /probe returns a real probe result", () => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } }, {}, {
      probe: () => ({ ok: true, server_fingerprint: "SHA256:y", latency_ms: 12, finished_at: "t" }),
    });
    const resp = JSON.parse(
      serveAuthed({
        method: "POST",
        path: "/api/plugin-ui/ssh-fleet/probe",
        query: "",
        body: JSON.stringify({ host: "web1" }),
      }),
    );
    expect(resp.verdict).toBe("allow");
    const result = JSON.parse(resp.payload.body);
    expect(result).toMatchObject({ host: "web1", ok: true, server_fingerprint: "SHA256:y", latency_ms: 12 });
  });

  it("a dashboard run appears in the activity feed", () => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } }, {}, {
      exec: () => ({
        ok: true,
        exit_code: 0,
        stdout: "Steam\nanaconda-ks.cfg",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        timed_out: false,
        server_fingerprint: "x",
        started_at: "t",
        finished_at: "t",
        duration_ms: 3,
      }),
    });
    serveAuthed({
      method: "POST",
      path: "/api/plugin-ui/ssh-fleet/run",
      query: "",
      body: JSON.stringify({ host: "web1", command: "ls" }),
    });
    const resp = JSON.parse(
      serveAuthed({ method: "GET", path: "/api/plugin-ui/ssh-fleet/activity", query: "host=h1&since=0", body: "" }),
    );
    const feed = JSON.parse(resp.payload.body);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ tool: "ssh_run", host_id: "h1", host_label: "web1", exit_code: 0 });
  });
});
