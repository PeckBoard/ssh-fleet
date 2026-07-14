// The plugin manifest JSON body — identity, hooks, permissions, the MCP tools
// the plugin contributes, the dashboard page + authenticated data routes, the
// sidebar entry, and the settings schema.

const DESCRIPTION =
  "SSH Fleet: hold connection details for many SSH hosts (user + password or " +
  "user + private key) and drive them over MCP tools — run commands on one host " +
  "or across the whole fleet, read/write/edit remote files — all through native " +
  "SSH in Peckboard core (keys stay in memory). Ships a live activity dashboard " +
  "showing every command per-host and across all hosts.";
const VERSION = "0.1.1";
const REPOSITORY = "https://github.com/PeckBoard/ssh-fleet";

// Inline SVG (lucide "server") for the sidebar entry; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/>' +
  '<line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>';

const HOST_REF =
  "Host reference: its id, label, or hostname (case-insensitive). Call ssh_host_list to see them.";

export function manifestJson(): string {
  const manifest = {
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,

    // SSH work is slow by nature: connect (up to the 120s connect_timeout
    // ceiling) plus a command that may legitimately run for ssh_run's 600s
    // cap. Without this, the extism default 2s budget traps the instance on
    // the first real call. Core clamps to its MAX_CALL_TIMEOUT (610s).
    call_timeout_secs: 610,

    hooks: ["mcp.tool.invoke", "http.request.before", "http.request.authed"],

    permissions: [
      "provide_mcp_tools", // the ssh_* MCP tools
      "ssh", // peckboard_ssh_probe / _exec / _read_file / _write_file
      "data_store", // host registry + activity log
      "user_authority", // serve the authenticated dashboard data routes
      "contribute_sidebar", // the SSH Fleet sidebar page
    ],

    // Global sidebar entry → the live activity dashboard.
    sidebar_items: [
      { id: "ssh-fleet", label: "SSH Fleet", icon: ICON, path: "/plugin-api/v1/ssh-fleet" },
    ],

    http_routes: ["GET /plugin-api/v1/ssh-fleet"],

    ui_routes: [
      "GET /api/plugin-ui/ssh-fleet/hosts",
      "POST /api/plugin-ui/ssh-fleet/hosts",
      "POST /api/plugin-ui/ssh-fleet/host-remove",
      "GET /api/plugin-ui/ssh-fleet/activity",
      "POST /api/plugin-ui/ssh-fleet/probe",
      "POST /api/plugin-ui/ssh-fleet/run",
    ],

    settings: [
      {
        key: "connect_timeout_secs",
        title: "Connect timeout (seconds)",
        type: "integer",
        default: 15,
        min: 1,
        max: 120,
        description: "How long to wait for the TCP connect + auth handshake before giving up.",
      },
    ],

    mcp_tools: [
      {
        name: "ssh_host_add",
        description:
          "Register a new SSH host in the fleet. Provide a hostname and username plus EITHER a " +
          "password OR a private_key (OpenSSH/PEM text, with an optional passphrase). Returns the " +
          "stored host (credentials are never echoed back). Give it a friendly label and tags to " +
          "make it easy to target later.",
        input_schema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Friendly name shown in the UI (defaults to the hostname)." },
            hostname: { type: "string", description: "Host to connect to (DNS name or IP)." },
            port: { type: "integer", description: "SSH port. Defaults to 22." },
            username: { type: "string", description: "SSH username." },
            password: { type: "string", description: "Password for password auth (omit if using a key)." },
            private_key: {
              type: "string",
              description: "Private key text (OpenSSH or PEM) for key auth (omit if using a password).",
            },
            passphrase: { type: "string", description: "Passphrase protecting the private key, if any." },
            known_host: {
              type: "string",
              description: "Optional pinned server-key fingerprint (SHA256:…). If set, a mismatch aborts the connection.",
            },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags for grouping/targeting." },
          },
          required: ["hostname", "username"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_host_update",
        description:
          "Update an existing host by id. Only the fields you pass change; omit a credential to keep " +
          "the current one. Use ssh_host_list to find the id.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id of the host to update." },
            label: { type: "string", description: "New label." },
            hostname: { type: "string", description: "New hostname." },
            port: { type: "integer", description: "New port." },
            username: { type: "string", description: "New username." },
            password: { type: "string", description: "Replace with password auth." },
            private_key: { type: "string", description: "Replace with key auth (private key text)." },
            passphrase: { type: "string", description: "New key passphrase." },
            known_host: { type: "string", description: "Pin/replace the server-key fingerprint." },
            tags: { type: "array", items: { type: "string" }, description: "Replace the tag list." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_host_remove",
        description: "Remove a host from the fleet. " + HOST_REF,
        input_schema: {
          type: "object",
          properties: { host: { type: "string", description: HOST_REF } },
          required: ["host"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_host_list",
        description:
          "List the registered hosts (credentials redacted) with their last-seen status. Optionally " +
          "filter by tag.",
        input_schema: {
          type: "object",
          properties: { tag: { type: "string", description: "Only list hosts carrying this tag." } },
          additionalProperties: false,
        },
      },
      {
        name: "ssh_probe",
        description:
          "Connect and authenticate to a host without running anything, to verify reachability and " +
          "credentials. Returns the server-key fingerprint (use it as known_host to pin) and latency. " +
          HOST_REF,
        input_schema: {
          type: "object",
          properties: { host: { type: "string", description: HOST_REF } },
          required: ["host"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_run",
        description:
          "Run a shell command on one host and return its stdout, stderr, and exit code. The command " +
          "is interpreted by the remote shell, so pipes/redirection work. Output is capped at 1 MiB per " +
          "stream. " + HOST_REF,
        input_schema: {
          type: "object",
          properties: {
            host: { type: "string", description: HOST_REF },
            command: { type: "string", description: "The command line to run on the remote shell." },
            timeout_secs: { type: "integer", description: "Command timeout in seconds (default 30, max 600)." },
          },
          required: ["host", "command"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_run_many",
        description:
          "Run the same command across multiple hosts and return a per-host result array. Target the " +
          "hosts by an explicit list, by tag, or set all:true for the whole fleet. Failures on one host " +
          "don't stop the others.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command line to run on each host." },
            hosts: { type: "array", items: { type: "string" }, description: "Explicit host references (id/label/hostname)." },
            tag: { type: "string", description: "Target every host carrying this tag." },
            all: { type: "boolean", description: "Target every registered host." },
            timeout_secs: { type: "integer", description: "Per-host command timeout in seconds." },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_read_file",
        description:
          "Read a remote file over SFTP and return its text content (also base64 for binary). Capped at " +
          "1 MiB. " + HOST_REF,
        input_schema: {
          type: "object",
          properties: {
            host: { type: "string", description: HOST_REF },
            path: { type: "string", description: "Absolute or remote-home-relative path to read." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_write_file",
        description:
          "Write (create/overwrite) a remote file over SFTP. Provide `content` for text or " +
          "`content_base64` for binary. " + HOST_REF,
        input_schema: {
          type: "object",
          properties: {
            host: { type: "string", description: HOST_REF },
            path: { type: "string", description: "Remote path to write." },
            content: { type: "string", description: "UTF-8 text content." },
            content_base64: { type: "string", description: "Base64 content, for binary files." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
      },
      {
        name: "ssh_edit_file",
        description:
          "Edit a remote file: either replace its whole content (`content`), or do a literal find/replace " +
          "(`find` + optional `replace`, replacing every occurrence; set expect_count to assert how many). " +
          "Reads the file, applies the change, writes it back. " + HOST_REF,
        input_schema: {
          type: "object",
          properties: {
            host: { type: "string", description: HOST_REF },
            path: { type: "string", description: "Remote path to edit." },
            content: { type: "string", description: "Full replacement content (also creates a new file)." },
            find: { type: "string", description: "Literal substring to replace." },
            replace: { type: "string", description: "Replacement for `find` (default: empty = delete it)." },
            expect_count: { type: "integer", description: "If set, fail unless exactly this many occurrences are replaced." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
      },
    ],
  };
  return JSON.stringify(manifest);
}
