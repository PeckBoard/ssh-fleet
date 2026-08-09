// The SSH Fleet dashboard: a self-contained HTML page (served under
// /plugin-api/*, framed in a sandboxed iframe). It talks to the authenticated
// data routes through the parent-proxied fetch bridge, shows the host registry
// with a searchable combobox (built for large fleets), and polls the activity
// feed every 2s for a live per-host / all-hosts view.
//
// The inline script uses only string concatenation (no backticks / ${}) so it
// nests cleanly inside this template literal. Data is rendered with textContent
// (never innerHTML) to avoid injection.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SSH Fleet</title>
<script>
  (function () {
    var t = new URLSearchParams(location.search).get("theme");
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  })();
</script>
<style>
  /* Light is the default; dark applies via an explicit <html data-theme="dark">
     stamp (?theme=dark|light in the iframe URL) or prefers-color-scheme, with
     the stamp winning both ways. */
  :root {
    --bg: #f6f8fa; --panel: #ffffff; --panel2: #eef1f5; --line: #d0d7de;
    --fg: #1f2328; --muted: #57606a; --accent: #0969da; --accent2: #0550ae;
    --ok: #1a7f37; --err: #cf222e; --warn: #9a6700; --idle: #6e7781;
    --sel: #dbe9f8; --badge-bg: #ddf4ff; --badge-line: #99c9ef;
    --shadow: 0 8px 24px rgba(140,149,159,.3); --overlay: rgba(27,31,36,.5);
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #0f1419; --panel: #171d26; --panel2: #1e2631; --line: #2a333f;
    --fg: #e6edf3; --muted: #8b98a5; --accent: #4c9be8; --accent2: #2d7dd2;
    --ok: #3fb950; --err: #f85149; --warn: #d29922; --idle: #6e7681;
    --sel: #1b2b3d; --badge-bg: #12283f; --badge-line: #1d3a58;
    --shadow: 0 8px 24px rgba(0,0,0,.4); --overlay: rgba(0,0,0,.55);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f1419; --panel: #171d26; --panel2: #1e2631; --line: #2a333f;
      --fg: #e6edf3; --muted: #8b98a5; --accent: #4c9be8; --accent2: #2d7dd2;
      --ok: #3fb950; --err: #f85149; --warn: #d29922; --idle: #6e7681;
      --sel: #1b2b3d; --badge-bg: #12283f; --badge-line: #1d3a58;
      --shadow: 0 8px 24px rgba(0,0,0,.4); --overlay: rgba(0,0,0,.55);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg); font: 13px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--line); background: var(--panel); flex: 0 0 auto;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .spacer { flex: 1; }
  .summary { display: flex; gap: 10px; color: var(--muted); font-size: 12px; }
  .summary b { color: var(--fg); font-weight: 600; }
  button {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent2); border-color: var(--accent2); color: #fff; }
  button.primary:hover { background: var(--accent); }
  .layout { flex: 1; display: flex; min-height: 0; }
  aside {
    width: 320px; flex: 0 0 320px; border-right: 1px solid var(--line);
    background: var(--panel); display: flex; flex-direction: column; min-height: 0;
  }
  aside .head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; }
  aside .head input { flex: 1; }
  input, select, textarea {
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; font: inherit; width: 100%;
  }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
  .hosts { overflow: auto; flex: 1; }
  .host {
    padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; display: flex; gap: 8px; align-items: flex-start;
  }
  .host:hover { background: var(--panel2); }
  .host.active { background: var(--sel); }
  .host .dot { margin-top: 4px; }
  .host .body { flex: 1; min-width: 0; }
  .host .label { font-weight: 600; }
  .host .sub { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .host .tags { margin-top: 3px; display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 0 6px; font-size: 10px; color: var(--muted); }
  .host .acts { display: flex; gap: 4px; opacity: 0; }
  .host:hover .acts { opacity: 1; }
  .host .acts button { padding: 2px 6px; font-size: 11px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--idle); flex: 0 0 auto; }
  .dot.ok { background: var(--ok); } .dot.error { background: var(--err); } .dot.unknown { background: var(--idle); }
  main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .runbar { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); align-items: center; }
  .runbar .combo { width: 220px; flex: 0 0 220px; }
  .runbar input.cmd { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .feedwrap { flex: 1; overflow: auto; }
  table.feed { width: 100%; border-collapse: collapse; }
  table.feed th { position: sticky; top: 0; background: var(--panel); text-align: left; color: var(--muted); font-weight: 500;
    font-size: 11px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  table.feed td { padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr.row:hover { background: var(--panel2); }
  .time { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .toolbadge { font-size: 10px; color: var(--accent); background: var(--badge-bg); border: 1px solid var(--badge-line); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
  .cmdcell { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .cmdcell .err { color: var(--err); display: block; margin-top: 2px; white-space: pre-wrap; }
  .cmdcell .out { color: var(--muted); display: block; margin-top: 2px; white-space: pre-wrap; }
  .status { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .status.ok { color: var(--ok); } .status.bad { color: var(--err); } .status.warn { color: var(--warn); }
  .empty { padding: 24px; color: var(--muted); text-align: center; }
  /* combobox */
  .combo { position: relative; }
  .combo .menu {
    position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 2px); max-height: 260px; overflow: auto;
    background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--shadow); display: none;
  }
  .combo .menu.open { display: block; }
  .combo .opt { padding: 6px 10px; cursor: pointer; }
  .combo .opt:hover, .combo .opt.hi { background: var(--sel); }
  .combo .opt .sub { color: var(--muted); font-size: 11px; }
  /* modal */
  .backdrop { position: fixed; inset: 0; background: var(--overlay); display: none; align-items: center; justify-content: center; z-index: 50; }
  .backdrop.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; width: 460px; max-width: 92vw; max-height: 90vh; overflow: auto; }
  .modal h2 { margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--line); font-size: 14px; }
  .modal .form { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: var(--muted); }
  .row2 { display: flex; gap: 10px; }
  .row2 > * { flex: 1; }
  .seg { display: flex; gap: 0; }
  .seg { display: flex; gap: 0; }
  .seg button { border-radius: 0; flex: 1; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; }
  .seg button + button { border-left: none; }
  .seg button.on { background: var(--accent2); border-color: var(--accent2); color: #fff; }
  .hint { font-size: 11px; color: var(--muted); }
  .legacy { background: var(--badge-bg); border: 1px solid var(--warn); color: var(--warn); border-radius: 10px; padding: 0 6px; font-size: 10px; }
  .modal .foot { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; }
  .formerr { color: var(--err); font-size: 12px; min-height: 16px; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; z-index: 60; max-width: 420px; display: none; }
  .toast.open { display: block; }

  /* ── mobile (iframe ≤760px wide, e.g. phones) ── */
  @media (hover: none), (pointer: coarse) {
    .host .acts { opacity: 1; }
  }
  @media (max-width: 760px) {
    header { flex-wrap: wrap; gap: 8px; padding: 10px 12px; }
    header h1 { order: 0; }
    header .spacer { order: 1; }
    #liveBtn { order: 2; }
    #addBtn { order: 3; }
    #filterCombo { order: 4; width: auto !important; flex: 1 1 100%; }
    .summary { order: 5; flex: 1 1 100%; }
    .layout { flex-direction: column; }
    aside { width: auto; flex: 0 0 auto; max-height: 36vh; border-right: none; border-bottom: 1px solid var(--line); }
    .runbar { flex-wrap: wrap; padding: 8px 12px; }
    .runbar .combo { width: auto; flex: 1 1 100%; }
    input, select, textarea { font-size: 16px; } /* keep iOS from zooming on focus */
    /* feed table → stacked cards */
    table.feed, table.feed tbody { display: block; width: 100%; }
    table.feed thead { display: none; }
    table.feed tr.row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
    table.feed td { display: block; width: auto; padding: 0; border-bottom: none; }
    table.feed tr.row td:nth-child(2) { font-weight: 600; }
    table.feed td.status { margin-left: auto; }
    table.feed td.cmdcell { flex: 1 1 100%; order: 10; margin-top: 2px; }
    .status .time { display: inline; margin-left: 6px; }
    .row2 { flex-wrap: wrap; }
    .row2 > * { flex: 1 1 140px; }
    .toast { left: 12px; right: 12px; bottom: 12px; max-width: none; }
  }
</style>
</head>
<body>
<header>
  <h1>SSH Fleet</h1>
  <div class="combo" id="filterCombo" style="width:240px">
    <input id="filterInput" placeholder="All hosts" autocomplete="off" />
    <div class="menu" id="filterMenu"></div>
  </div>
  <div class="summary" id="summary"></div>
  <div class="spacer"></div>
  <button id="liveBtn">⏸ Pause</button>
  <button id="addBtn" class="primary">+ Add host</button>
</header>
<div class="layout">
  <aside>
    <div class="head">
      <input id="hostSearch" placeholder="Filter hosts…" autocomplete="off" />
    </div>
    <div class="hosts" id="hostList"><div class="empty">Loading…</div></div>
  </aside>
  <main>
    <div class="runbar">
      <div class="combo runcombo" id="runCombo">
        <input id="runInput" placeholder="Pick a host…" autocomplete="off" />
        <div class="menu" id="runMenu"></div>
      </div>
      <input class="cmd" id="cmdInput" placeholder="Command to run on the selected host…" />
      <button id="runBtn" class="primary">Run</button>
    </div>
    <div class="feedwrap" id="feedWrap">
      <table class="feed">
        <thead><tr><th style="width:90px">Time</th><th style="width:150px">Host</th><th style="width:110px">Tool</th><th>Command / detail</th><th style="width:90px">Result</th></tr></thead>
        <tbody id="feed"></tbody>
      </table>
      <div class="empty" id="feedEmpty">No activity yet. Run a command to see it here, live.</div>
    </div>
  </main>
</div>

<div class="backdrop" id="backdrop">
  <div class="modal">
    <h2 id="modalTitle">Add host</h2>
    <div class="form">
      <div class="row2">
        <div class="field"><label>Label</label><input id="f_label" placeholder="web-1" /></div>
        <div class="field"><label>Tags (comma-separated)</label><input id="f_tags" placeholder="prod, web" /></div>
      </div>
      <div class="row2">
        <div class="field" style="flex:2"><label>Hostname / IP *</label><input id="f_hostname" placeholder="10.0.0.5" /></div>
        <div class="field"><label>Port</label><input id="f_port" value="22" /></div>
      </div>
      <div class="field"><label>Username *</label><input id="f_username" placeholder="root" /></div>
      <div class="field">
        <label>Auth</label>
        <div class="seg">
          <button type="button" id="auth_ref" class="on">Vault key</button>
          <button type="button" id="auth_pw">Password</button>
          <button type="button" id="auth_key">Private key</button>
        </div>
      </div>
      <div class="field" id="refField">
        <label>Key from the SSH key vault (recommended)</label>
        <select id="f_key_id"></select>
        <span class="hint" id="refHint">The private key stays in Peckboard's vault — this plugin only stores a reference to it.</span>
      </div>
      <div class="field" id="pwField" style="display:none"><label>Password</label><input id="f_password" type="password" placeholder="••••••••" /></div>
      <div class="field" id="keyField" style="display:none"><label>Private key (OpenSSH/PEM)</label><textarea id="f_key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea><span class="hint">Stored in this plugin's own data store. Prefer a vault key instead.</span></div>
      <div class="field" id="passField" style="display:none"><label>Key passphrase (optional)</label><input id="f_passphrase" type="password" /></div>
      <div class="field"><label>Pinned host key fingerprint (optional)</label><input id="f_known" placeholder="SHA256:…" /></div>
      <div class="formerr" id="formErr"></div>
    </div>
    <div class="foot">
      <button id="cancelBtn">Cancel</button>
      <button id="saveBtn" class="primary">Save host</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function () {
  "use strict";

  // ── Parent-proxied fetch bridge (sandboxed iframe, no same-origin). ──
  var _pending = {}, _seq = 0;
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && m.type === "plugin-ui-fetch-result" && _pending[m.requestId]) {
      _pending[m.requestId]({ status: m.status, body: m.body });
      delete _pending[m.requestId];
    }
  });
  function apiFetch(path, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var id = ++_seq;
      _pending[id] = resolve;
      window.parent.postMessage(
        { type: "plugin-ui-fetch", requestId: id, method: opts.method || "GET", path: path, body: opts.body },
        "*"
      );
    });
  }
  function getJSON(path) { return apiFetch(path).then(parseRes); }
  function postJSON(path, obj) { return apiFetch(path, { method: "POST", body: JSON.stringify(obj) }).then(parseRes); }
  function parseRes(res) {
    var body = {};
    try { body = res.body ? JSON.parse(res.body) : {}; } catch (_e) { body = { error: "bad response" }; }
    if (res.status >= 400 || (body && body.error)) { throw new Error(body && body.error ? body.error : "request failed (" + res.status + ")"); }
    return body;
  }

  var API = "/api/plugin-ui/ssh-fleet";
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  var state = { hosts: [], byId: {}, keys: [], keysLoaded: false, filter: "all", cursor: 0, live: true, editing: null, authKind: "key_ref", runHost: null };

  // Human label for a host's credential kind, incl. the vault key's name.
  function authText(h) {
    if (h.auth_kind === "key_ref") return "vault key: " + (h.key_name || h.key_id || "(missing)");
    if (h.auth_kind === "key") return "inline private key";
    return "password";
  }

  // ── hosts ──────────────────────────────────────────────────────────
  function loadHosts() {
    return getJSON(API + "/hosts").then(function (d) {
      state.hosts = (d.hosts || []);
      state.byId = {};
      state.hosts.forEach(function (h) { state.byId[h.id] = h; });
      renderHosts();
      renderSummary();
      refreshCombos();
    }).catch(function (e) { toast("Failed to load hosts: " + e.message); });
  }

  function renderSummary() {
    var ok = 0, err = 0, unk = 0;
    state.hosts.forEach(function (h) { if (h.last_status === "ok") ok++; else if (h.last_status === "error") err++; else unk++; });
    var s = $("summary"); clear(s);
    s.appendChild(mk("b", null, String(state.hosts.length))); s.appendChild(document.createTextNode(" hosts"));
    var span = el("span"); span.appendChild(dot("ok")); span.appendChild(document.createTextNode(" " + ok));
    span.appendChild(dot("error")); span.appendChild(document.createTextNode(" " + err));
    span.appendChild(dot("unknown")); span.appendChild(document.createTextNode(" " + unk));
    s.appendChild(span);
  }
  function mk(tag, cls, text) { return el(tag, cls, text); }
  function dot(kind) { var d = el("span", "dot " + kind); d.style.marginLeft = "8px"; d.style.marginRight = "3px"; return d; }

  function renderHosts() {
    var q = ($("hostSearch").value || "").trim().toLowerCase();
    var list = $("hostList"); clear(list);
    var hosts = state.hosts.filter(function (h) {
      if (!q) return true;
      var hay = (h.label + " " + h.hostname + " " + h.username + " " + (h.tags || []).join(" ")).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (!hosts.length) { list.appendChild(el("div", "empty", state.hosts.length ? "No hosts match." : "No hosts yet. Add one.")); return; }
    hosts.forEach(function (h) {
      var row = el("div", "host" + (state.filter === h.id ? " active" : ""));
      row.appendChild(el("span", "dot " + (h.last_status || "unknown")));
      var body = el("div", "body");
      body.appendChild(el("div", "label", h.label));
      body.appendChild(el("div", "sub", h.username + "@" + h.hostname + ":" + h.port + "  ·  " + authText(h)));
      var tg = el("div", "tags");
      // Legacy hosts still hold a private key inside this plugin's own store;
      // flag them so users re-point them at a vault key (there is deliberately
      // no automatic migration — plugins cannot write to the vault).
      if (h.auth_kind === "key") {
        var lg = el("span", "legacy", "legacy inline key");
        lg.title = "This host stores its private key in the plugin. Edit it and pick a vault key instead.";
        tg.appendChild(lg);
      }
      (h.tags || []).forEach(function (t) { tg.appendChild(el("span", "tag", t)); });
      if (tg.childNodes.length) body.appendChild(tg);
      row.appendChild(body);
      var acts = el("div", "acts");
      var edit = el("button", null, "Edit"); edit.onclick = function (ev) { ev.stopPropagation(); openEdit(h); };
      var del = el("button", null, "✕"); del.title = "Remove"; del.onclick = function (ev) { ev.stopPropagation(); removeHost(h); };
      acts.appendChild(edit); acts.appendChild(del); row.appendChild(acts);
      row.onclick = function () { setFilter(state.filter === h.id ? "all" : h.id); };
      list.appendChild(row);
    });
  }

  function removeHost(h) {
    if (!confirm("Remove host '" + h.label + "'?")) return;
    postJSON(API + "/host-remove", { id: h.id }).then(function () {
      if (state.filter === h.id) setFilter("all");
      toast("Removed " + h.label); loadHosts();
    }).catch(function (e) { toast("Remove failed: " + e.message); });
  }

  // ── activity feed (live) ───────────────────────────────────────────
  function setFilter(f) {
    state.filter = f; state.cursor = 0;
    clear($("feed")); $("feedEmpty").style.display = "block";
    var h = state.byId[f];
    $("filterInput").value = f === "all" ? "" : (h ? h.label : "");
    renderHosts();
    poll();
  }

  var polling = false;
  function poll() {
    if (polling) return;
    polling = true;
    getJSON(API + "/activity?host=" + encodeURIComponent(state.filter) + "&since=" + state.cursor)
      .then(function (d) {
        state.cursor = d.cursor || state.cursor;
        (d.items || []).forEach(appendRow);
      })
      .catch(function () { /* transient; keep polling */ })
      .then(function () { polling = false; });
  }

  function appendRow(a) {
    $("feedEmpty").style.display = "none";
    var feed = $("feed");
    var wrap = $("feedWrap");
    var atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 40;
    var tr = el("tr", "row");
    tr.appendChild(el("td", "time", fmtTime(a.ts)));
    tr.appendChild(el("td", null, a.host_label || "—"));
    var td = el("td"); td.appendChild(el("span", "toolbadge", a.tool)); tr.appendChild(td);
    var cmd = el("td", "cmdcell"); cmd.appendChild(document.createTextNode(a.summary || ""));
    if (a.error) cmd.appendChild(el("span", "err", a.error));
    else if (a.stderr_preview) cmd.appendChild(el("span", "err", a.stderr_preview));
    else if (a.stdout_preview) cmd.appendChild(el("span", "out", a.stdout_preview));
    tr.appendChild(cmd);
    tr.appendChild(resultCell(a));
    feed.appendChild(tr);
    // cap DOM rows
    while (feed.childNodes.length > 600) feed.removeChild(feed.firstChild);
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function resultCell(a) {
    var td = el("td", "status");
    if (a.error) { td.className = "status bad"; td.textContent = "error"; return td; }
    if (a.tool === "ssh_run" || a.tool === "ssh_run_many") {
      if (a.exit_code === 0) { td.className = "status ok"; td.textContent = "exit 0"; }
      else { td.className = "status bad"; td.textContent = "exit " + (a.exit_code == null ? "?" : a.exit_code); }
      if (a.duration_ms != null) { var s = el("div", "time", a.duration_ms + " ms"); td.appendChild(s); }
    } else if (a.bytes != null) { td.className = "status ok"; td.textContent = a.bytes + " B"; }
    else if (a.ok) { td.className = "status ok"; td.textContent = "ok"; }
    else { td.className = "status warn"; td.textContent = "—"; }
    return td;
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // ── run bar ────────────────────────────────────────────────────────
  function runCommand() {
    var host = state.runHost || (state.filter !== "all" ? state.filter : null);
    var cmd = $("cmdInput").value;
    if (!host) { toast("Pick a host to run on."); return; }
    if (!cmd.trim()) { toast("Enter a command."); return; }
    var btn = $("runBtn"); btn.disabled = true; btn.textContent = "Running…";
    postJSON(API + "/run", { host: host, command: cmd }).then(function (r) {
      toast((r.host || host) + " → exit " + r.exit_code + (r.stdout ? "\\n" + r.stdout.slice(0, 300) : ""));
      poll(); loadHosts();
    }).catch(function (e) { toast("Run failed: " + e.message); poll(); })
      .then(function () { btn.disabled = false; btn.textContent = "Run"; });
  }

  // ── searchable comboboxes ──────────────────────────────────────────
  function setupCombo(comboId, inputId, menuId, options, onPick) {
    var input = $(inputId), menu = $(menuId), hi = -1, opts = options;
    function render(filter) {
      clear(menu); hi = -1;
      var f = (filter || "").toLowerCase();
      var shown = opts().filter(function (o) { return !f || o.text.toLowerCase().indexOf(f) >= 0 || (o.sub || "").toLowerCase().indexOf(f) >= 0; });
      shown.slice(0, 200).forEach(function (o) {
        var d = el("div", "opt"); d.appendChild(document.createTextNode(o.text));
        if (o.sub) d.appendChild(el("span", "sub", "  " + o.sub));
        d.onmousedown = function (ev) { ev.preventDefault(); pick(o); };
        menu.appendChild(d);
      });
      if (!shown.length) menu.appendChild(el("div", "opt", "No match"));
    }
    function open() { render(""); menu.classList.add("open"); }
    function close() { menu.classList.remove("open"); }
    function pick(o) { input.value = o.value === "all" ? "" : o.text; close(); onPick(o); }
    input.addEventListener("focus", open);
    input.addEventListener("input", function () { render(input.value); menu.classList.add("open"); });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    return { refresh: function () { if (menu.classList.contains("open")) render(input.value); } };
  }

  function hostOptions(withAll) {
    var opts = state.hosts.map(function (h) { return { value: h.id, text: h.label, sub: h.username + "@" + h.hostname }; });
    if (withAll) opts.unshift({ value: "all", text: "All hosts", sub: "" });
    return opts;
  }
  var filterCombo = setupCombo("filterCombo", "filterInput", "filterMenu", function () { return hostOptions(true); }, function (o) { setFilter(o.value); });
  var runCombo = setupCombo("runCombo", "runInput", "runMenu", function () { return hostOptions(false); }, function (o) { state.runHost = o.value; });
  function refreshCombos() { filterCombo.refresh(); runCombo.refresh(); }

  // ── add / edit host modal ──────────────────────────────────────────

  // The vault keys are a fixed option set from core, so the picker is a plain
  // <select> — never free text. Metadata only; core keeps the key material.
  function loadKeys() {
    if (state.keysLoaded) return Promise.resolve(state.keys);
    return getJSON(API + "/ssh-keys").then(function (d) {
      state.keys = d.keys || []; state.keysLoaded = true; return state.keys;
    }).catch(function (e) {
      state.keys = []; state.keysLoaded = false;
      $("refHint").textContent = "Could not load the SSH key vault: " + e.message;
      return state.keys;
    });
  }
  function fillKeySelect(selectedId) {
    var sel = $("f_key_id"); clear(sel);
    if (!state.keys.length) {
      var none = el("option", null, "No keys in the vault"); none.value = "";
      sel.appendChild(none); sel.disabled = true;
      return;
    }
    sel.disabled = false;
    state.keys.forEach(function (k) {
      var o = el("option", null, k.name + "  (" + k.key_type + ")");
      o.value = k.id;
      sel.appendChild(o);
    });
    // A host may point at a key that has since been deleted from the vault:
    // keep it selectable so saving doesn't silently re-point the host.
    if (selectedId && !state.keys.some(function (k) { return k.id === selectedId; })) {
      var missing = el("option", null, "(key no longer in the vault: " + selectedId + ")");
      missing.value = selectedId; sel.appendChild(missing);
    }
    sel.value = selectedId || state.keys[0].id;
  }

  function setAuth(kind) {
    state.authKind = kind;
    $("auth_ref").classList.toggle("on", kind === "key_ref");
    $("auth_pw").classList.toggle("on", kind === "password");
    $("auth_key").classList.toggle("on", kind === "key");
    $("refField").style.display = kind === "key_ref" ? "" : "none";
    $("pwField").style.display = kind === "password" ? "" : "none";
    $("keyField").style.display = kind === "key" ? "" : "none";
    $("passField").style.display = kind === "key" ? "" : "none";
  }
  function openAdd() {
    state.editing = null; $("modalTitle").textContent = "Add host";
    ["f_label", "f_tags", "f_hostname", "f_username", "f_password", "f_key", "f_passphrase", "f_known"].forEach(function (i) { $(i).value = ""; });
    $("f_port").value = "22"; $("formErr").textContent = ""; setAuth("key_ref");
    $("f_password").placeholder = "••••••••"; $("f_key").placeholder = "-----BEGIN OPENSSH PRIVATE KEY-----";
    $("backdrop").classList.add("open"); $("f_hostname").focus();
    loadKeys().then(function (keys) {
      fillKeySelect(null);
      // Nothing to pick yet — don't strand the user on an empty dropdown.
      if (!keys.length && !state.editing && state.authKind === "key_ref") setAuth("password");
    });
  }
  function openEdit(h) {
    state.editing = h.id; $("modalTitle").textContent = "Edit host";
    $("f_label").value = h.label; $("f_tags").value = (h.tags || []).join(", ");
    $("f_hostname").value = h.hostname; $("f_port").value = h.port; $("f_username").value = h.username;
    $("f_password").value = ""; $("f_key").value = ""; $("f_passphrase").value = ""; $("f_known").value = h.known_host || "";
    $("formErr").textContent = "";
    setAuth(h.auth_kind === "key" ? "key" : h.auth_kind === "key_ref" ? "key_ref" : "password");
    $("f_password").placeholder = "(unchanged)"; $("f_key").placeholder = "(unchanged)";
    $("backdrop").classList.add("open");
    loadKeys().then(function () { fillKeySelect(h.key_id || null); });
  }
  function closeModal() { $("backdrop").classList.remove("open"); }
  function saveHost() {
    var body = {
      label: $("f_label").value, hostname: $("f_hostname").value, port: $("f_port").value,
      username: $("f_username").value, known_host: $("f_known").value,
      tags: $("f_tags").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (state.authKind === "key_ref") { if ($("f_key_id").value) body.key_id = $("f_key_id").value; }
    else if (state.authKind === "password") { if ($("f_password").value) body.password = $("f_password").value; }
    else { if ($("f_key").value) body.private_key = $("f_key").value; if ($("f_passphrase").value) body.passphrase = $("f_passphrase").value; }
    // Omitting a credential means "keep the current one", so switching auth
    // kind without entering one would silently leave the old kind in place.
    var cur = state.editing ? state.byId[state.editing] : null;
    if (cur && cur.auth_kind !== state.authKind && !body.key_id && !body.password && !body.private_key) {
      $("formErr").textContent = state.authKind === "key_ref"
        ? "Pick a vault key to switch this host over to it."
        : "Enter the new credential to switch the auth kind.";
      return;
    }
    if (state.editing) body.id = state.editing;
    var btn = $("saveBtn"); btn.disabled = true;
    postJSON(API + "/hosts", body).then(function () { closeModal(); toast("Saved"); loadHosts(); })
      .catch(function (e) { $("formErr").textContent = e.message; })
      .then(function () { btn.disabled = false; });
  }

  // ── toast ──────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("open");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("open"); }, 5000);
  }

  // ── wire up ────────────────────────────────────────────────────────
  $("addBtn").onclick = openAdd;
  $("cancelBtn").onclick = closeModal;
  $("saveBtn").onclick = saveHost;
  $("auth_pw").onclick = function () { setAuth("password"); };
  $("auth_key").onclick = function () { setAuth("key"); };
  $("hostSearch").addEventListener("input", renderHosts);
  $("runBtn").onclick = runCommand;
  $("auth_ref").onclick = function () { setAuth("key_ref"); };
  $("auth_pw").onclick = function () { setAuth("password"); };
  $("liveBtn").onclick = function () {
    state.live = !state.live;
    $("liveBtn").textContent = state.live ? "⏸ Pause" : "▶ Live";
  };
  $("backdrop").addEventListener("mousedown", function (e) { if (e.target === $("backdrop")) closeModal(); });

  loadHosts().then(function () { setFilter("all"); });
  setInterval(function () { if (state.live) poll(); }, 2000);
  setInterval(function () { loadHosts(); }, 15000); // refresh host statuses periodically
})();
</script>
</body>
</html>`;
