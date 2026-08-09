# Peckboard SSH Fleet plugin

A Peckboard WASM plugin that holds connection details for **many** SSH hosts
and drives them over MCP tools, with a **live activity dashboard**.

- **Host registry** — store as many hosts as you like, each with a username and
  a credential: **a key from Peckboard's SSH key vault** (recommended), a
  password, or an inline private key (with optional passphrase) — plus a
  friendly label and tags for grouping.
- **MCP tools** — agents can register hosts, run commands on one host or across
  the whole fleet, and read / write / edit remote files.
- **Live dashboard** — a sidebar page ("SSH Fleet") that shows every command as
  it happens, filterable to one host or all hosts, with a searchable host picker
  built for large fleets.

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

## MCP tools

| Tool | What it does |
| --- | --- |
| `ssh_host_add` | Register a host: `hostname` + `username` + one credential (`key_id` \| `password` \| `private_key` [+ `passphrase`]), plus optional `label`, `port`, `tags`, `known_host`. |
| `ssh_host_update` | Update a host by `id`; omit a credential to keep the current one, or pass `key_id` / `password` / `private_key` to switch auth kind. |
| `ssh_host_remove` | Remove a host (by id, label, or hostname). |
| `ssh_host_list` | List hosts (credentials redacted) with last-seen status; vault-key hosts report `auth_kind: "key_ref"` with `key_id` + `key_name`. |
| `ssh_probe` | Connect + authenticate without running anything; returns the server-key fingerprint (for pinning) and latency. |
| `ssh_run` | Run a command on one host → `{exit_code, stdout, stderr, …}` (1 MiB/stream). |
| `ssh_run_many` | Run a command across `hosts` / a `tag` / `all` hosts → per-host results. |
| `ssh_read_file` | Read a remote file over SFTP (returns text + base64). |
| `ssh_write_file` | Write/overwrite a remote file (`content` text or `content_base64` binary). |
| `ssh_edit_file` | Edit a remote file: full-content replace, or literal `find`/`replace`. |

Every tool call is appended to the activity log the dashboard shows.

Hosts are referenced by their **id, label, or hostname** (case-insensitive) —
call `ssh_host_list` to see them.

## Dashboard

The manifest contributes a global **sidebar** entry, `SSH Fleet`, that opens the
dashboard (served at `/plugin-api/v1/ssh-fleet`, framed in a sandboxed iframe):
- a **host panel** with per-host status dots (ok / error / unknown), the
  credential in use (vault key name, password, or a *legacy inline key* badge),
  and tags, searchable by name/host/tag, with inline add / edit / remove;
  large fleet), plus an all-hosts view;
- a **host panel** with per-host status dots (ok / error / unknown), auth kind,
  and tags, searchable by name/host/tag, with inline add / edit / remove;
- a **live activity feed** (tool, command, exit code / bytes, duration, stderr on
  failure) that updates by polling `/api/plugin-ui/ssh-fleet/activity` every ~2s;
- an inline **run** box to execute a command against the selected host.

It reads its data from the authenticated `/api/plugin-ui/ssh-fleet/*` routes via
the standard parent-proxied fetch bridge (the iframe has no same-origin access).
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
- Credentials are stored **unencrypted at rest** in the plugin's `plugin_data`
  rows (the same posture as other plugins' secrets). Protect the Peckboard data
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
