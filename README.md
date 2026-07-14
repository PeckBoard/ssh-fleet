# Peckboard SSH Fleet plugin

A Peckboard WASM plugin that holds connection details for **many** SSH hosts
and drives them over MCP tools, with a **live activity dashboard**.

- **Host registry** — store as many hosts as you like, each with a username and
  **either** a password **or** a private key (with optional passphrase), plus a
  friendly label and tags for grouping.
- **MCP tools** — agents can register hosts, run commands on one host or across
  the whole fleet, and read / write / edit remote files.
- **Live dashboard** — a sidebar page ("SSH Fleet") that shows every command as
  it happens, filterable to one host or all hosts, with a searchable host picker
  built for large fleets.

SSH itself runs through **native host functions in Peckboard core** (a pure-Rust
`russh` client), so credentials stay in memory and are never written to disk.
This plugin requires a core build that provides the `peckboard_ssh_*` host
functions and the `ssh` permission.

## MCP tools

| Tool | What it does |
| --- | --- |
| `ssh_host_add` | Register a host: `hostname` + `username` + (`password` \| `private_key` [+ `passphrase`]), plus optional `label`, `port`, `tags`, `known_host`. |
| `ssh_host_update` | Update a host by `id`; omit a credential to keep the current one. |
| `ssh_host_remove` | Remove a host (by id, label, or hostname). |
| `ssh_host_list` | List hosts (credentials redacted) with last-seen status. |
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

- a **searchable combobox** to filter activity to any host (type to narrow a
  large fleet), plus an all-hosts view;
- a **host panel** with per-host status dots (ok / error / unknown), auth kind,
  and tags, searchable by name/host/tag, with inline add / edit / remove;
- a **live activity feed** (tool, command, exit code / bytes, duration, stderr on
  failure) that updates by polling `/api/plugin-ui/ssh-fleet/activity` every ~2s;
- an inline **run** box to execute a command against the selected host.

It reads its data from the authenticated `/api/plugin-ui/ssh-fleet/*` routes via
the standard parent-proxied fetch bridge (the iframe has no same-origin access).

## Security

- Passwords, private keys, and passphrases live only in the plugin's private
  document store and are handed straight to the core `ssh` host functions. They
  are **never returned over the wire** or to a tool caller — every outward view
  (the dashboard list and `ssh_host_list`) is redacted.
- Core holds the key material in memory for the duration of a connection; it is
  never written to disk.
- Optional **host-key pinning** (TOFU): `ssh_probe` returns the server-key
  fingerprint; store it as a host's `known_host` and a later mismatch aborts the
  connection.
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
the `provide_mcp_tools`, `ssh`, `data_store`, `user_authority`, and
`contribute_sidebar` permissions.
