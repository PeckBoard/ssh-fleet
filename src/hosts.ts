// The SSH host registry: structured host records (identity + credentials)
// persisted in the plugin document store, plus the pure helpers that validate
// input, redact secrets for the wire, and build a connection for the ssh host
// functions.
//
// SECURITY: inline passwords / private keys / passphrases live only in these
// records (the plugin's private data_store, never surfaced in the Settings UI)
// and are fed straight to the ssh host functions. They are NEVER returned over
// the wire or to an MCP tool caller — every outward view goes through `redact`.
//
// The preferred credential is a `key_ref` host: it stores only a `key_id`
// pointing at core's SSH key vault, so the plugin holds no key material at all
// and core resolves the key at connect time. Hosts still carrying an inline
// `private_key` are legacy — the dashboard flags them so users can re-point
// them at a vault key by hand. The plugin deliberately cannot write to the
// vault, so there is no automatic migration.

import { storeList, storeGet, storePut, storeDelete, sshKeyList, SshConn, SshAuth } from "./host";
import { nextSeq } from "./counter";

const COLLECTION = "hosts";

export type AuthKind = "password" | "key" | "key_ref";

export interface HostRecord {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  password?: string;
  private_key?: string;
  key_id?: string; // id of a key in core's vault (auth_kind === "key_ref")
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
  key_id: string | null;
  key_name: string | null;
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

/// Whether a record actually carries the credential its `auth_kind` implies.
function hasSecret(rec: HostRecord): boolean {
  if (rec.auth_kind === "password") return !!rec.password;
  if (rec.auth_kind === "key_ref") return !!rec.key_id;
  return !!rec.private_key;
}

/// Strip all secrets, exposing only what the dashboard / an agent may see.
/// `keyNames` (from `keyNameMap`) optionally resolves a `key_ref` host's
/// vault-key id to its display name; the id alone is not a secret, and the
/// name never is.
export function redact(rec: HostRecord, keyNames?: Record<string, string>): PublicHost {
  return {
    id: rec.id,
    label: rec.label,
    hostname: rec.hostname,
    port: rec.port,
    username: rec.username,
    auth_kind: rec.auth_kind,
    has_secret: hasSecret(rec),
    key_id: rec.key_id ?? null,
    key_name: (rec.key_id && keyNames ? keyNames[rec.key_id] : undefined) ?? null,
    known_host: rec.known_host ?? null,
    fingerprint: rec.last_fingerprint ?? rec.known_host ?? null,
    tags: rec.tags ?? [],
    last_status: rec.last_status ?? "unknown",
    last_seen: rec.last_seen ?? null,
    last_error: rec.last_error ?? null,
  };
}

/// Vault-key id → name, for labelling `key_ref` hosts. Costs one host call, so
/// it is skipped entirely when no host references the vault, and never throws:
/// a missing `ssh_keys` grant just means hosts show their id instead.
export function keyNameMap(hosts: HostRecord[]): Record<string, string> {
  const map: Record<string, string> = {};
  if (!hosts.some((h) => h.auth_kind === "key_ref" && !!h.key_id)) return map;
  try {
    for (const k of sshKeyList()) {
      if (k && typeof k.id === "string") map[k.id] = k.name;
    }
  } catch (_e) {
    // advisory only — fall back to showing the raw id
  }
  return map;
}

/// Build a connection (with secrets) for the ssh host functions. A `key_ref`
/// host emits only its `key_id`: core resolves the vault key, so no key
/// material ever passes through the plugin.
export function toConn(rec: HostRecord, connectTimeoutSecs?: number): SshConn {
  const auth: SshAuth =
    rec.auth_kind === "password"
      ? { password: rec.password ?? "" }
      : rec.auth_kind === "key_ref"
        ? { key_id: rec.key_id ?? "" }
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

  // Credentials: a provided credential wins and sets the auth kind; otherwise
  // keep whatever the existing record had. A brand-new host must supply
  // exactly one of the three forms. A `key_id` stores no key material at all
  // — it points at core's vault, which resolves it at connect time.
  const newPassword = typeof input.password === "string" && input.password !== "" ? input.password : undefined;
  const newKey = typeof input.private_key === "string" && input.private_key !== "" ? input.private_key : undefined;
  const newKeyId = trimStr(input.key_id);

  let auth_kind: AuthKind;
  let password: string | undefined;
  let private_key: string | undefined;
  let passphrase: string | undefined;
  let key_id: string | undefined;
  if (newPassword) {
    auth_kind = "password";
    password = newPassword;
  } else if (newKey) {
    auth_kind = "key";
    private_key = newKey;
    passphrase = typeof input.passphrase === "string" && input.passphrase !== "" ? input.passphrase : undefined;
  } else if (newKeyId) {
    auth_kind = "key_ref";
    key_id = newKeyId;
  } else if (existing) {
    auth_kind = existing.auth_kind;
    password = existing.password;
    private_key = existing.private_key;
    key_id = existing.key_id;
    // allow updating just the passphrase of an existing key
    passphrase =
      typeof input.passphrase === "string" && input.passphrase !== "" ? input.passphrase : existing.passphrase;
  } else {
    throw new Error("provide either a password, a private_key, or a key_id");
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
    key_id,
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
  return redact(rec, keyNameMap([rec]));
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
