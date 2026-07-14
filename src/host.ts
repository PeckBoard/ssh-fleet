// FFI layer: the Peckboard core host functions this plugin calls, and the
// host_call marshaling helper. Host calls are kept LAZY (inside functions) so
// the pure modules load under vitest without an Extism runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSetting(key: string): any {
  const result = hostCall("peckboard_get_plugin_setting", { key });
  return result?.value ?? null;
}

// ── Plugin document store (data_store permission) ────────────────────────────

export function storePut(collection: string, key: string, data: unknown): void {
  hostCall("peckboard_store_put", { collection, key, data });
}

export function storeGet(collection: string, key: string): any {
  const result = hostCall("peckboard_store_get", { collection, key });
  return result?.value ?? null;
}

export function storeList(collection: string): Array<{ key: string; value: any }> {
  const result = hostCall("peckboard_store_list", { collection });
  return result?.items ?? [];
}

export function storeDelete(collection: string, key: string): void {
  hostCall("peckboard_store_delete", { collection, key });
}

// ── SSH (ssh permission) ─────────────────────────────────────────────────────

/// Password or private-key credentials passed to the ssh host functions.
export type SshAuth =
  | { password: string }
  | { private_key: string; passphrase?: string };

/// The connection-shaped fields every ssh host function needs.
export interface SshConn {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  known_host?: string;
  connect_timeout_secs?: number;
}

export interface SshExecResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  server_fingerprint: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

/// Connect + authenticate, returning the server-key fingerprint (for pinning)
/// and round-trip latency.
export function sshProbe(conn: SshConn): {
  ok: boolean;
  server_fingerprint: string;
  latency_ms: number;
  finished_at: string;
} {
  return hostCall("peckboard_ssh_probe", conn);
}

/// Run a command on the host; captures stdout/stderr (1 MiB/stream) + exit code.
export function sshExec(conn: SshConn, command: string, timeoutSecs?: number): SshExecResult {
  const input: Record<string, unknown> = { ...conn, command };
  if (typeof timeoutSecs === "number") {
    input.timeout_secs = timeoutSecs;
  }
  return hostCall("peckboard_ssh_exec", input) as SshExecResult;
}

/// Read a remote file over SFTP; returns base64 content (1 MiB cap).
export function sshReadFile(conn: SshConn, path: string): {
  ok: boolean;
  content_base64: string;
  size: number;
  truncated: boolean;
  server_fingerprint: string;
  finished_at: string;
} {
  return hostCall("peckboard_ssh_read_file", { ...conn, path });
}

/// Write bytes (base64) to a remote file over SFTP (create/truncate).
export function sshWriteFile(conn: SshConn, path: string, contentBase64: string): {
  ok: boolean;
  bytes: number;
  server_fingerprint: string;
  finished_at: string;
} {
  return hostCall("peckboard_ssh_write_file", { ...conn, path, content_base64: contentBase64 });
}
