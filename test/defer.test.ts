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
    const v = invoke({
      tool: "ssh_run",
      arguments: { host: "web1", command: "uptime", timeout_secs: 5, reason: "check load" },
    });
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
    const v = invoke({ tool: "ssh_run_many", arguments: { all: true, command: "hostname", reason: "inventory" } });
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
    const v = invoke({
      tool: "ssh_edit_file",
      arguments: { host: "web1", path: "/etc/motd", find: "old", replace: "new", reason: "refresh banner" },
    });
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
    // The dashboard's Diff view: old line removed, new line added.
    expect(v.resume.diff).toBe("- hello old world\n+ hello new world");
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

// ── Required reason + session attribution ───────────────────────────────────────

describe("reason is required on command/write tools", () => {
  const calls: Array<[string, any]> = [
    ["ssh_run", { host: "web1", command: "uptime" }],
    ["ssh_run_many", { all: true, command: "uptime" }],
    ["ssh_write_file", { host: "web1", path: "/tmp/x", content: "x" }],
    ["ssh_edit_file", { host: "web1", path: "/tmp/x", content: "x" }],
  ];
  beforeEach(() => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "a") } });
  });

  for (const [tool, args] of calls) {
    it(`${tool}: missing / blank / oversized reason is rejected before any op`, () => {
      for (const reason of [undefined, "", "   ", "x".repeat(301)]) {
        const v = invoke({ tool, arguments: reason === undefined ? args : { ...args, reason } });
        expect(v.verdict).toBe("allow");
        expect(v.payload.error).toMatch(/reason/);
      }
      const ok = invoke({ tool, arguments: { ...args, reason: "  verify the deploy  " } });
      expect(ok.verdict).toBe("defer");
    });
  }

  it("read / probe accept a call without a reason", () => {
    expect(invoke({ tool: "ssh_read_file", arguments: { host: "web1", path: "/etc/hosts" } }).verdict).toBe("defer");
    expect(invoke({ tool: "ssh_probe", arguments: { host: "web1" } }).verdict).toBe("defer");
  });
});

describe("activity attribution", () => {
  it("an ssh_run entry stores the calling session and the trimmed reason", () => {
    const store = installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "a") } });
    const v = invoke({
      tool: "ssh_run",
      arguments: { host: "web1", command: "df -h", reason: "  check disk before deploy " },
      context: { sessionId: "sess-123", sessionName: "Deploy bot", folderId: "f1" },
      resume: { id: "h1", label: "web1", command: "df -h" },
      op_result: {
        ok: true,
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        timed_out: false,
        server_fingerprint: "x",
        finished_at: "t",
        duration_ms: 4,
      },
    });
    expect(v.verdict).toBe("allow");
    const [entry] = Object.values(store.activity ?? {}) as any[];
    expect(entry).toMatchObject({
      tool: "ssh_run",
      summary: "df -h",
      session_id: "sess-123",
      session_name: "Deploy bot",
      reason: "check disk before deploy",
      source: "agent",
    });
  });
});

describe("activity paging", () => {
  it("returns the newest page, then older pages via `before`", () => {
    const activity: Record<string, any> = {};
    for (let i = 1; i <= 5; i++) activity[String(i).padStart(12, "0")] = { id: i, tool: "ssh_run", ok: true };
    installHost({ activity });
    const get = (q: string) =>
      JSON.parse(
        JSON.parse(serveAuthed({ method: "GET", path: "/api/plugin-ui/ssh-fleet/activity", query: q, body: "" })).payload
          .body,
      );
    const first = get("host=all&since=0&limit=2");
    expect(first.items.map((a: any) => a.id)).toEqual([4, 5]);
    expect(first).toMatchObject({ cursor: 5, has_more: true });
    const older = get("host=all&before=4&limit=2");
    expect(older.items.map((a: any) => a.id)).toEqual([2, 3]);
    expect(older.has_more).toBe(true);
    expect(get("host=all&before=2&limit=2")).toMatchObject({ has_more: false });
  });
});
// ── Dashboard routes: no command execution ────────────────────────────────────

describe("dashboard routes", () => {
  it("there is no POST /run: the page cannot run commands", () => {
    installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } }, {}, {
      exec: () => {
        throw new Error("must not exec");
      },
    });
    const resp = JSON.parse(
      serveAuthed({
        method: "POST",
        path: "/api/plugin-ui/ssh-fleet/run",
        query: "",
        body: JSON.stringify({ host: "web1", command: "echo hi" }),
      }),
    );
    expect(resp.payload.status).toBe(404);
  });

  it("POST /probe returns a real probe result, logged as a dashboard test", () => {
    const store = installHost({ hosts: { h1: pwHost("h1", "web1", "10.0.0.1", "s3cret") } }, {}, {
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
    expect(result.__defer__).toBeUndefined();
    expect(result).toMatchObject({ host: "web1", ok: true, server_fingerprint: "SHA256:y", latency_ms: 12 });
    const [entry] = Object.values(store.activity ?? {}) as any[];
    expect(entry).toMatchObject({ tool: "ssh_probe", source: "dashboard" });
    expect(entry.session_id).toBeUndefined();
  });
});
