# Peckboard SSH Fleet plugin

A Peckboard WASM plugin that holds connection details for **many** SSH hosts
and drives them over MCP tools, with a **live activity dashboard**.

- **Host registry** — store as many hosts as you like, each with a username and
  a credential: **a key from Peckboard's SSH key vault** (recommended), a
  password, or an inline private key (with optional passphrase) — plus a
  friendly label and tags for grouping.
- **MCP tools** — agents can register hosts, run commands on one host or across
  the whole fleet, and read / write / edit remote files. Every command or write
  must carry a short `reason`, and is recorded with the session that made it.
- **Audit dashboard** — a sidebar page ("SSH Fleet") listing the hosts and a
  live feed of every agent SSH call: who (a link to the session), why (the
  reason), what (command / path), and how it went. The page manages hosts but
  deliberately **cannot run commands**.
- **Interactive terminals** — every host is available to Peckboard's built-in
  terminals (Terminals page, `t` shortcut, or the host's **Terminal** button
  here): a real shell in a full-size app tab, run inside tmux on the host so it
  survives Peckboard restarts and network drops. The plugin only answers the
  `terminal.hosts.list` / `terminal.host.resolve` hooks; credentials go to core
  in memory at each connect and never reach the browser.

SSH itself runs through **native host functions in Peckboard core** (a pure-Rust
`russh` client), so credentials stay in memory and are never written to disk.
This plugin requires a core build that provides the `peckboard_ssh_*` host
functions and the `ssh` / `ssh_keys` permissions.

## Vault keys (recommended)

A host can authenticate with a key held in **Peckboard's own SSH key vault**
(Settings → SSH keys), referenced by its `key_id`. The plugin then stores *no
key material at all* — only the id. Core resolves the id, decrypts the key from
the vault, and uses it for that one connection.

- In the dashboard, the add/edit host form's **Auth** choice offers *Vault key*
  (the default), *Password*, and *Private key*; the vault key is picked from a
  dropdown of the keys core reports.
- Over MCP, pass `key_id` to `ssh_host_add` / `ssh_host_update`. Such a host
  reports `auth_kind: "key_ref"` with its `key_id` and `key_name` in
  `ssh_host_list`.
- The plugin can only **read key metadata** (`peckboard_ssh_key_list`: id, name,
  type, fingerprint) — never the private key, its ciphertext, or its passphrase.
  It cannot write to the vault.

### Existing hosts keep working

Hosts created with a password or an inline `private_key` are untouched and
continue to work exactly as before. There is deliberately **no automatic
migration** of inline keys into the vault: plugins have no vault write access,
and granting it would let any plugin inject keys other plugins could then use.
The dashboard flags inline-key hosts with a **legacy inline key** badge; re-point
them by editing the host and choosing a vault key.

> **Upgrading from 0.2.x re-triggers the approval prompt.** This release adds the
> `ssh_keys` permission, and Peckboard's approval is bound to the exact
> permission set, so you must re-approve the plugin in Settings → Plugins after
> updating.

## MCP Tools

| Tool | What it does |
| --- | --- |
| `ssh_host_add` | Register a host: `hostname` + `username` + one credential (`key_id` \| `password` \| `private_key` [+ `passphrase`]), plus optional `label`, `port`, `tags`, `known_host`. |
| `ssh_host_update` | Update a host by `id`; omit a credential to keep the current one, or pass `key_id` / `password` / `private_key` to switch auth kind. |
| `ssh_host_remove` | Remove a host (by id, label, or hostname). |
| `ssh_host_list` | List hosts (credentials redacted) with last-seen status; vault-key hosts report `auth_kind: "key_ref"` with `key_id` + `key_name`. |
| `ssh_probe` | Connect + authenticate without running anything; returns the server-key fingerprint (for pinning) and latency. Optional `reason`. |
| `ssh_run` | Run a command on one host → `{exit_code, stdout, stderr, …}` (1 MiB/stream). **Requires `reason`.** |
| `ssh_run_many` | Run a command across `hosts` / a `tag` / `all` hosts → per-host results. **Requires `reason`.** |
| `ssh_read_file` | Read a remote file over SFTP (returns text + base64). Optional `reason`. |
| `ssh_write_file` | Write/overwrite a remote file (`content` text or `content_base64` binary). **Requires `reason`.** |
| `ssh_edit_file` | Edit a remote file: full-content replace, or literal `find`/`replace`. **Requires `reason`.** |

`reason` is one short sentence (trimmed, 1–300 chars) saying why the agent is
doing it; a missing, blank, or over-long reason is rejected before anything
touches a host. Every tool call is appended to the activity log with the
calling session's id and name — taken from core's verified invoke context
(`context.sessionId` / `context.sessionName`), never from tool arguments.

Hosts are referenced by their **id, label, or hostname** (case-insensitive) —
call `ssh_host_list` to see them.

## Dashboard

The manifest contributes a global **sidebar** entry, `SSH Fleet`, that opens the
dashboard (served at `/plugin-api/v1/ssh-fleet`, framed in a sandboxed iframe).
It follows the app's light/dark theme and palette, and below ~760px wide the
two panels become tabs.

- **Hosts** — compact rows built for large fleets: status dot, label, last seen,
  `user@host:port`, auth kind (vault key name, password, or a *legacy inline
  key* badge), tags, and quick actions: **Terminal**, **Test** (connect +
  authenticate only — runs nothing), **Edit**, **Remove** (with confirm).
  Searchable, filterable by tag chips, sortable by name / last seen / status.
  Clicking a host filters the activity feed to it.
- **Activity** — every call, newest first: status (exit code / ok / failed),
  tool, host, the **session that made it** (a link that opens the session in
  the app), time, duration, the **reason**, the command or path, and the output
  (expandable). Filter by host, session, failures only, or free text. Polls
  `/api/plugin-ui/ssh-fleet/activity` every ~2s (pausable). Entries written
  before 0.6.0 show `—` for the session.

It reads its data from the authenticated `/api/plugin-ui/ssh-fleet/*` routes via
the standard parent-proxied fetch bridge (the iframe has no same-origin access).
There is no command-execution route: running commands is the agents' job, under
an attributed, stated reason.

## Security

- A **vault key** host stores only a `key_id`. The private key never enters the
  plugin — core decrypts it from the vault for the connection. This is the
  recommended setup.
- Inline passwords, private keys, and passphrases live only in the plugin's
  private document store and are handed straight to the core `ssh` host
  functions. They are **never returned over the wire** or to a tool caller —
  every outward view (the dashboard list and `ssh_host_list`) is redacted.
- Core holds the key material in memory for the duration of a connection; it is
  never written to disk.
- Optional **host-key pinning** (TOFU): `ssh_probe` returns the server-key
  fingerprint; store it as a host's `known_host` and a later mismatch aborts the
  connection.
- Inline credentials are stored **unencrypted at rest** in the plugin's
  `plugin_data` rows (the same posture as other plugins' secrets). Vault keys
  are not — core encrypts them under its vault key. Protect the Peckboard data
  directory accordingly.

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `connect_timeout_secs` | integer | 15 | TCP connect + auth handshake timeout. |

## Build

Targets the Extism js-pdk. Requires `extism-js` on `PATH` and Node/npm.

```bash
./build.sh
# or:
npm install && npm run build
# → dist/plugin.wasm
```

Run the unit tests with `npm test`.

## Install

Copy the built module into Peckboard's plugins directory, named to match its
config key (the file stem is the plugin id):

```bash
cp dist/plugin.wasm <dataDir>/plugins/ssh-fleet.wasm
```

Restart Peckboard, then approve the plugin (Settings → Plugins) — it declares
the `provide_mcp_tools`, `ssh`, `ssh_keys`, `data_store`, `user_authority`, and
`contribute_sidebar` permissions. Upgrading from 0.2.x adds `ssh_keys`, so the
approval prompt reappears once.
