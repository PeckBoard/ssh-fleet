// The SSH host registry: structured host records (identity + credentials)
// persisted in the plugin document store, plus the pure helpers that validate
// input, redact secrets for the wire, and build a connection for the ssh host
// functions.
//
// SECURITY: passwords / private keys / passphrases live only in these records
// (the plugin's private data_store, never surfaced in the Settings UI) and are
// fed straight to the ssh host functions. They are NEVER returned over the wire
// or to an MCP tool caller — every outward view goes through `redact`.

import { storeList, storeGet, storePut, storeDelete, SshConn, SshAuth } from "./host";
import { nextSeq } from "./counter";

const COLLECTION = "hosts";

export type AuthKind = "password" | "key";

export interface HostRecord {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  password?: string;
  private_key?: string;
  passphrase?: string;
  known_host?: string; // pinned SHA256:… server-key fingerprint (TOFU)
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  last_status?: "ok" | "error" | "unknown";
  last_seen?: string;
  last_error?: string;
  last_fingerprint?: string;
}

/// The secret-free view returned to the UI and to MCP tool callers.
export interface PublicHost {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  has_secret: boolean;
  known_host: string | null;
  fingerprint: string | null;
  tags: string[];
  last_status: string;
  last_seen: string | null;
  last_error: string | null;
}

function trimStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/// Best-effort ISO timestamp. The sandbox may lack a wall clock; when it does
/// this returns undefined and the field is simply omitted.
export function nowIso(): string | undefined {
  try {
    return new Date().toISOString();
  } catch (_e) {
    return undefined;
  }
}

/// Strip all secrets, exposing only what the dashboard / an agent may see.
export function redact(rec: HostRecord): PublicHost {
  return {
    id: rec.id,
    label: rec.label,
    hostname: rec.hostname,
    port: rec.port,
    username: rec.username,
    auth_kind: rec.auth_kind,
    has_secret: rec.auth_kind === "password" ? !!rec.password : !!rec.private_key,
    known_host: rec.known_host ?? null,
    fingerprint: rec.last_fingerprint ?? rec.known_host ?? null,
    tags: rec.tags ?? [],
    last_status: rec.last_status ?? "unknown",
    last_seen: rec.last_seen ?? null,
    last_error: rec.last_error ?? null,
  };
}

/// Build a connection (with secrets) for the ssh host functions.
export function toConn(rec: HostRecord, connectTimeoutSecs?: number): SshConn {
  const auth: SshAuth =
    rec.auth_kind === "password"
      ? { password: rec.password ?? "" }
      : { private_key: rec.private_key ?? "", passphrase: rec.passphrase };
  const conn: SshConn = { host: rec.hostname, port: rec.port, username: rec.username, auth };
  if (rec.known_host) conn.known_host = rec.known_host;
  if (typeof connectTimeoutSecs === "number") conn.connect_timeout_secs = connectTimeoutSecs;
  return conn;
}

/// Validate + construct a record from tool/UI input, merging onto `existing`
/// for updates. Pure (no store access) so it is unit-testable. `idFactory`
/// mints an id for a brand-new host.
export function buildRecord(
  input: any,
  existing: HostRecord | null,
  idFactory: () => string,
): HostRecord {
  if (input === null || typeof input !== "object") {
    throw new Error("host must be an object");
  }
  const hostname = trimStr(input.hostname) ?? existing?.hostname;
  if (!hostname) throw new Error("hostname is required");
  const username = trimStr(input.username) ?? existing?.username;
  if (!username) throw new Error("username is required");

  let port = existing?.port ?? 22;
  if (input.port !== undefined && input.port !== null && input.port !== "") {
    const p = Number(input.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error("port must be an integer between 1 and 65535");
    }
    port = p;
  }

  const label = trimStr(input.label) ?? existing?.label ?? hostname;

  // Credentials: a provided secret wins and sets the auth kind; otherwise keep
  // whatever the existing record had. A brand-new host must supply one.
  const newPassword = typeof input.password === "string" && input.password !== "" ? input.password : undefined;
  const newKey = typeof input.private_key === "string" && input.private_key !== "" ? input.private_key : undefined;

  let auth_kind: AuthKind;
  let password: string | undefined;
  let private_key: string | undefined;
  let passphrase: string | undefined;
  if (newPassword) {
    auth_kind = "password";
    password = newPassword;
  } else if (newKey) {
    auth_kind = "key";
    private_key = newKey;
    passphrase = typeof input.passphrase === "string" && input.passphrase !== "" ? input.passphrase : undefined;
  } else if (existing) {
    auth_kind = existing.auth_kind;
    password = existing.password;
    private_key = existing.private_key;
    // allow updating just the passphrase of an existing key
    passphrase =
      typeof input.passphrase === "string" && input.passphrase !== "" ? input.passphrase : existing.passphrase;
  } else {
    throw new Error("provide either a password or a private_key");
  }

  let tags: string[] | undefined = existing?.tags;
  if (Array.isArray(input.tags)) {
    tags = input.tags.map((t: unknown) => String(t)).filter((t: string) => t.trim() !== "");
  }

  let known_host = existing?.known_host;
  if (typeof input.known_host === "string") known_host = input.known_host.trim() || undefined;
  else if (input.known_host === null) known_host = undefined;

  const rec: HostRecord = {
    id: existing?.id ?? trimStr(input.id) ?? idFactory(),
    label,
    hostname,
    port,
    username,
    auth_kind,
    password,
    private_key,
    passphrase,
    known_host,
    tags,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    last_status: existing?.last_status ?? "unknown",
    last_seen: existing?.last_seen,
    last_error: existing?.last_error,
    last_fingerprint: existing?.last_fingerprint,
  };
  return rec;
}

// ── store-backed operations ──────────────────────────────────────────────────

export function listHosts(): HostRecord[] {
  return storeList(COLLECTION)
    .map((i) => i.value as HostRecord)
    .filter((h) => h && typeof h.id === "string")
    .sort((a, b) => (a.label || a.hostname).localeCompare(b.label || b.hostname));
}

export function getHost(id: string): HostRecord | null {
  return (storeGet(COLLECTION, id) as HostRecord) ?? null;
}

export function putHost(rec: HostRecord): void {
  storePut(COLLECTION, rec.id, rec);
}

export function deleteHost(id: string): boolean {
  if (!getHost(id)) return false;
  storeDelete(COLLECTION, id);
  return true;
}

function mintId(): string {
  return "h" + nextSeq("host_seq");
}

/// Create or update a host from input, returning the redacted view.
export function saveHostFromInput(input: any): PublicHost {
  const id = trimStr(input?.id);
  const existing = id ? getHost(id) : null;
  const rec = buildRecord(input, existing, mintId);
  putHost(rec);
  return redact(rec);
}

/// Resolve a host by id, then label, then hostname (case-insensitive).
export function resolveHost(ref: unknown): HostRecord {
  const r = (typeof ref === "string" ? ref : "").trim().toLowerCase();
  if (!r) throw new Error("host is required (id, label, or hostname)");
  const hosts = listHosts();
  let m = hosts.find((h) => h.id.toLowerCase() === r);
  if (!m) m = hosts.find((h) => (h.label || "").toLowerCase() === r);
  if (!m) m = hosts.find((h) => h.hostname.toLowerCase() === r);
  if (!m) throw new Error(`no host matches '${String(ref)}' — call ssh_host_list to see known hosts`);
  return m;
}

/// Record the outcome of an operation against a host (best-effort; never throws).
export function updateHostStatus(
  id: string,
  patch: { ok: boolean; fingerprint?: string; error?: string; at?: string },
): void {
  try {
    const rec = getHost(id);
    if (!rec) return;
    rec.last_status = patch.ok ? "ok" : "error";
    rec.last_seen = patch.at ?? nowIso();
    if (patch.fingerprint) rec.last_fingerprint = patch.fingerprint;
    rec.last_error = patch.ok ? undefined : patch.error;
    putHost(rec);
  } catch (_e) {
    // status is advisory; ignore persistence hiccups
  }
}
