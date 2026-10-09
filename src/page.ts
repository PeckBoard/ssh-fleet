// The SSH Fleet dashboard: a self-contained HTML page (served under
// /plugin-api/*, framed in a sandboxed iframe). It talks to the authenticated
// data routes through the parent-proxied fetch bridge.
//
// Layout (the approved wireframe): a header with the fleet summary and
// "+ Add host"; a HOSTS column (search, tag chips, sort; compact rows with a
// status dot, auth kind, tags, last seen, a Terminal button and a ⋯ menu) and
// an ACTIVITY column — the audit trail of every agent SSH call: time, host,
// tool, exit status, duration, the command or path, the agent's reason, a link
// to the session that made it, and collapsible output / diff. Below 760px the
// columns become tabs. The page deliberately has NO way to run a command.
//
// The inline script uses only string concatenation (no backticks, no dollar-
// brace, no backslashes) so it nests cleanly inside this template literal.
// Data is rendered with textContent (never innerHTML); innerHTML is used only
// for the static icon constants.

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
  /* Palette mirrors Peckboard's own tokens (web/src/index.css) so the page
     reads as part of the app. Light is the default; dark applies via the
     host's ?theme=dark stamp or prefers-color-scheme, the stamp winning. */
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --surface2: #f3f4f6; --surface3: #e9ebef; --hover: #f0f1f4;
    --text: #1a1d23; --text2: #4b5563; --text3: #6b7280;
    --accent: hsl(220, 72%, 50%); --accent-hover: hsl(220, 72%, 44%);
    --accent-subtle: hsl(220, 60%, 95%);
    --danger: #dc2626; --danger-bg: #fef2f2; --danger-border: #fecaca;
    --success: #059669; --success-bg: #ecfdf5; --success-border: #a7f3d0;
    --warn: #b45309; --warn-bg: #fffbeb; --warn-border: #fde68a;
    --border: #e5e7eb; --border-strong: #d1d5db;
    --code-bg: #f6f7f9;
    --shadow: 0 1px 2px rgba(16,24,40,.05); --shadow-lg: 0 12px 32px rgba(16,24,40,.18);
    --overlay: rgba(17,24,39,.45);
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #22252f; --surface3: #2a2d38; --hover: #252833;
    --text: #e5e7eb; --text2: #9ca3af; --text3: #8f97a5;
    --accent: hsl(220, 65%, 62%); --accent-hover: hsl(220, 65%, 56%);
    --accent-subtle: hsl(220, 30%, 16%);
    --danger: #f87171; --danger-bg: rgba(239,68,68,.1); --danger-border: rgba(239,68,68,.3);
    --success: #34d399; --success-bg: rgba(16,185,129,.1); --success-border: rgba(16,185,129,.3);
    --warn: #fbbf24; --warn-bg: rgba(245,158,11,.1); --warn-border: rgba(245,158,11,.3);
    --border: #2a2d38; --border-strong: #3a3d48;
    --code-bg: #14161d;
    --shadow: 0 1px 2px rgba(0,0,0,.3); --shadow-lg: 0 12px 32px rgba(0,0,0,.55);
    --overlay: rgba(0,0,0,.6);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f1117; --surface: #1a1d27; --surface2: #22252f; --surface3: #2a2d38; --hover: #252833;
      --text: #e5e7eb; --text2: #9ca3af; --text3: #8f97a5;
      --accent: hsl(220, 65%, 62%); --accent-hover: hsl(220, 65%, 56%);
      --accent-subtle: hsl(220, 30%, 16%);
      --danger: #f87171; --danger-bg: rgba(239,68,68,.1); --danger-border: rgba(239,68,68,.3);
      --success: #34d399; --success-bg: rgba(16,185,129,.1); --success-border: rgba(16,185,129,.3);
      --warn: #fbbf24; --warn-bg: rgba(245,158,11,.1); --warn-border: rgba(245,158,11,.3);
      --border: #2a2d38; --border-strong: #3a3d48;
      --code-bg: #14161d;
      --shadow: 0 1px 2px rgba(0,0,0,.3); --shadow-lg: 0 12px 32px rgba(0,0,0,.55);
      --overlay: rgba(0,0,0,.6);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.5 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh; -webkit-font-smoothing: antialiased;
  }
  .mono, code, pre { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace; }
  svg.i { width: 14px; height: 14px; flex: 0 0 auto; vertical-align: -2px; }
  .spacer { flex: 1; }

  /* ── header ── */
  .top { display: flex; align-items: center; gap: 12px; padding: 12px 18px; background: var(--surface); border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .top h1 { font-size: 15px; margin: 0; font-weight: 650; white-space: nowrap; }
  .summary { color: var(--text2); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; display: flex; gap: 12px; }
  .summary b { color: var(--text); font-weight: 600; }
  .summary .on b { color: var(--success); }

  /* ── controls ── */
  .btn {
    display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
    border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  }
  .btn:hover { background: var(--hover); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn.sm { height: 26px; padding: 0 8px; font-size: 12px; }
  .btn[disabled] { opacity: .6; cursor: default; }
  .btn:focus-visible, .ibtn:focus-visible, a:focus-visible, .chip:focus-visible, .seg button:focus-visible, .host:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .ibtn { width: 26px; height: 26px; display: inline-grid; place-items: center; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--text2); cursor: pointer; padding: 0; }
  .ibtn:hover, .ibtn.open { background: var(--surface3); color: var(--text); }
  input, select, textarea {
    background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 0 10px; height: 30px; font: inherit; font-size: 12.5px; width: 100%;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
  .search { position: relative; }
  .search svg { position: absolute; left: 9px; top: 8px; color: var(--text3); pointer-events: none; }
  .search input { padding-left: 30px; }
  .combo { position: relative; }
  .combo input { padding-right: 26px; }
  .combo .caret { position: absolute; right: 8px; top: 8px; color: var(--text3); pointer-events: none; }
  .seg { display: inline-flex; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 2px; min-width: 0; }
  .seg button { border: none; background: transparent; color: var(--text2); border-radius: 6px; height: 24px; padding: 0 10px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
  .seg button.on { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
  .seg button[disabled] { opacity: .5; cursor: default; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text2); white-space: nowrap; cursor: pointer; user-select: none; }
  .check input { width: 14px; height: 14px; accent-color: var(--accent); margin: 0; }

  /* ── layout ── */
  .tabs { display: none; }
  .layout { flex: 1; display: grid; grid-template-columns: 360px minmax(0, 1fr); min-height: 0; }
  .panel { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  #hostsPanel { background: var(--surface); border-right: 1px solid var(--border); }
  #activityPanel { background: var(--bg); }
  .panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
  .panel-head h2 { margin: 0; font-size: 11.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--text2); }
  .count { color: var(--text3); font-weight: 500; margin-left: 6px; font-variant-numeric: tabular-nums; letter-spacing: 0; }
  .panel-head select { width: auto; height: 26px; font-size: 12px; padding: 0 6px; }
  .bar { padding: 0 14px 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .bar > .search { flex: 1 1 180px; }
  .bar > .combo { flex: 1 1 150px; min-width: 130px; }
  .chips { display: flex; gap: 6px; padding: 0 14px 10px; flex-wrap: wrap; }
  .chips:empty { display: none; }
  .chip { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text2); border-radius: 999px; padding: 0 10px; font: inherit; font-size: 11.5px; cursor: pointer; line-height: 22px; white-space: nowrap; }
  .chip:hover { background: var(--hover); }
  .chip.on { background: var(--accent-subtle); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .scroll { overflow: auto; flex: 1; border-top: 1px solid var(--border); }
  #feed { padding: 12px 20px 24px; display: flex; flex-direction: column; gap: 10px; }
  .day { font-size: 11px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: .08em; margin: 6px 0 0; }
  .day:first-child { margin-top: 0; }

  /* ── host rows ── */
  .host { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .host:hover { background: var(--hover); }
  .host.active { background: var(--accent-subtle); box-shadow: inset 3px 0 0 var(--accent); }
  .host .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .host .acts { grid-column: 3; grid-row: 1 / span 3; display: flex; align-items: center; gap: 4px; }
  .host .seen { color: var(--text3); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .host .l2 { grid-column: 2; display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; row-gap: 3px; }
  .host .addr { grid-column: 2; color: var(--text2); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .host .err { grid-column: 2; color: var(--danger); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; box-sizing: border-box; }
  .dot.on { background: var(--success); box-shadow: 0 0 0 3px var(--success-bg); }
  .dot.off { border: 1.5px solid var(--text3); background: transparent; }
  .dot.off.bad { border-color: var(--danger); }
  .tag { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 0 6px; font-size: 10.5px; color: var(--text2); white-space: nowrap; line-height: 17px; }
  .badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 5px; padding: 0 6px; font-size: 10.5px; white-space: nowrap; line-height: 17px; border: 1px solid; }
  .badge svg { width: 11px; height: 11px; }
  .badge.vault { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
  .badge.legacy { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }

  /* ── activity ── */
  .act { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); }
  .act.bad { border-color: var(--danger); box-shadow: inset 3px 0 0 var(--danger); }
  .act-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text2); }
  .act-top time { font-variant-numeric: tabular-nums; color: var(--text3); }
  .act-top .hostname { color: var(--text); font-weight: 600; background: none; border: none; padding: 0; font: inherit; font-weight: 600; cursor: pointer; }
  .act-top .hostname:hover { text-decoration: underline; }
  .tool { font-size: 11px; color: var(--text2); background: var(--surface3); border-radius: 4px; padding: 0 6px; line-height: 18px; white-space: nowrap; }
  .res { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; margin-left: auto; }
  .res.ok { color: var(--success); } .res.bad { color: var(--danger); }
  .dur { color: var(--text3); font-variant-numeric: tabular-nums; }
  .what { display: block; margin-top: 6px; padding: 5px 9px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: var(--text); }
  .what .p { color: var(--text3); user-select: none; }
  .kv { margin-top: 5px; display: flex; gap: 6px; align-items: baseline; font-size: 12.5px; min-width: 0; }
  .kv .k { color: var(--text3); flex: 0 0 56px; font-size: 12px; }
  .kv .v { min-width: 0; overflow-wrap: anywhere; }
  .kv.reason .v { color: var(--text); font-weight: 500; }
  .kv.none .v { color: var(--text3); font-style: italic; font-weight: 400; }
  .sess { color: var(--accent); text-decoration: none; font-weight: 500; display: inline-flex; align-items: center; gap: 3px; max-width: 100%; }
  .sess span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess:hover { text-decoration: underline; }
  .fold { margin-top: 6px; background: none; border: none; padding: 0; color: var(--text2); font: inherit; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .fold:hover { color: var(--accent); }
  .fold svg { transition: transform .15s; }
  .act.open .fold svg { transform: rotate(90deg); }
  .body { display: none; margin-top: 6px; }
  .act.open .body { display: block; }
  .body pre { margin: 0 0 6px; padding: 8px 10px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
  .body pre.stderr, .body pre.error { border-color: var(--danger-border); color: var(--danger); }
  .body .lbl { font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text3); margin-bottom: 3px; }
  .diff .add { color: var(--success); display: block; }
  .diff .del { color: var(--danger); display: block; }
  .diff .ctx { color: var(--text3); display: block; }
  .more { display: flex; justify-content: center; padding: 4px 0 0; }

  /* ── empty states ── */
  .empty { padding: 40px 24px; text-align: center; color: var(--text2); }
  .empty .ico { width: 40px; height: 40px; border-radius: 10px; display: inline-grid; place-items: center; background: var(--surface2); color: var(--text3); margin-bottom: 10px; }
  .empty .ico svg { width: 20px; height: 20px; }
  .empty h3 { margin: 0 0 4px; font-size: 13.5px; color: var(--text); font-weight: 600; }
  .empty p { margin: 0 auto 12px; max-width: 360px; font-size: 12.5px; }

  /* ── floating menus (row ⋯ menu + combobox lists) ── */
  .pop { position: fixed; z-index: 80; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: var(--shadow-lg); padding: 4px; display: none; max-height: 280px; overflow: auto; min-width: 180px; }
  .pop.open { display: block; }
  .pop .mi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: none; background: none; color: var(--text); font: inherit; font-size: 12.5px; border-radius: 5px; cursor: pointer; text-align: left; }
  .pop .mi:hover, .pop .mi.hi { background: var(--hover); }
  .pop .mi.danger { color: var(--danger); }
  .pop .mi .sub { color: var(--text3); font-size: 11px; margin-left: auto; padding-left: 10px; white-space: nowrap; }
  .pop .mi.sel { font-weight: 600; }
  .pop .sep { height: 1px; background: var(--border); margin: 4px 2px; }
  .pop .none { padding: 6px 10px; color: var(--text3); font-size: 12px; }

  /* ── modal ── */
  .backdrop { position: fixed; inset: 0; background: var(--overlay); display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
  .backdrop.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; width: 460px; max-width: 100%; max-height: 92vh; overflow: auto; box-shadow: var(--shadow-lg); }
  .modal.small { width: 400px; }
  .modal h2 { margin: 0; padding: 16px 20px; font-size: 15px; font-weight: 650; border-bottom: 1px solid var(--border); }
  .modal.small h2 { border-bottom: none; padding-bottom: 4px; }
  .modal .desc { padding: 4px 20px 0; color: var(--text2); font-size: 12.5px; }
  /* Label column + control column, as in the approved mockup. A .field is
     transparent to the grid: its label lands in column 1, everything else in
     column 2 (label-less fields — key picker, password — sit under Auth). */
  .form { padding: 16px 20px 8px; display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; align-items: center; }
  .field { display: contents; }
  .field > label, .field > .flabel { grid-column: 1; font-size: 12.5px; color: var(--text2); }
  .field > :not(label):not(.flabel) { grid-column: 2; min-width: 0; }
  .field > .hint { margin-top: -6px; }
  .two { display: flex; gap: 8px; align-items: center; }
  .two input:first-child { flex: 1; min-width: 0; }
  .two label { font-size: 12.5px; color: var(--text2); }
  .two .port { width: 72px; flex: 0 0 auto; }
  .radios { display: flex; flex-direction: column; gap: 8px; }
  .radios label { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }
  .radios input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
  .tagbox { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tagbox .tag { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; line-height: 20px; }
  .tagbox .tag button { border: none; background: none; color: var(--text3); cursor: pointer; padding: 0; font: inherit; line-height: 1; }
  .tagbox .tag button:hover { color: var(--danger); }
  .tagbox .combo { flex: 1 1 140px; }
  .hint { font-size: 11.5px; color: var(--text3); }
  .hint.warn { color: var(--warn); }
  .testres { grid-column: 1 / -1; font-size: 12px; min-height: 18px; }
  .testres:empty { display: none; }
  .testres.ok { color: var(--success); } .testres.bad { color: var(--danger); }
  .foot { padding: 12px 20px; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); }
  .modal.small .foot { border-top: none; padding-bottom: 16px; }
  .formerr { grid-column: 1 / -1; color: var(--danger); font-size: 12px; }
  .formerr:empty { display: none; }
  .formerr { color: var(--danger); font-size: 12px; min-height: 16px; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--text); color: var(--bg); border-radius: 8px; padding: 10px 14px; z-index: 90; max-width: 420px; display: none; box-shadow: var(--shadow-lg); font-size: 12.5px; }
  .toast.open { display: block; }
  .toast.err { background: var(--danger); color: #fff; }

  /* ── narrow (phones; iframe ≤ 760px) ── */
  @media (hover: none), (pointer: coarse) { .ibtn { width: 32px; height: 32px; } }
  @media (max-width: 760px) {
    .top { padding: 10px 12px; gap: 10px; }
    .add-word { display: none; }
    .tabs { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 8px; }
    .tabs button { flex: 1; background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 4px 8px; font: inherit; font-weight: 600; color: var(--text2); cursor: pointer; }
    .tabs button.on { color: var(--accent); border-bottom-color: var(--accent); }
    .layout { display: flex; flex-direction: column; }
    .panel { flex: 1; }
    #hostsPanel { border-right: none; }
    #feed { padding: 10px 10px 20px; }
    .host .term-word { display: none; }
    body[data-tab="hosts"] #activityPanel, body[data-tab="activity"] #hostsPanel { display: none; }
    input, select, textarea { font-size: 16px; } /* keep iOS from zooming on focus */
    .row2 { flex-wrap: wrap; }
    .summary { display: none; }
  }
</style>
</head>
<body data-tab="hosts">
<header class="top">
  <h1>SSH Fleet</h1>
  <span class="summary" id="summary" data-testid="fleet-summary"></span>
  <span class="spacer"></span>
  <button id="addBtn" class="btn primary" data-testid="add-host"><span id="addIco"></span><span>Add<span class="add-word"> host</span></span></button>
</header>
<nav class="tabs">
  <button id="tabHosts" class="on">Hosts</button>
  <button id="tabActivity">Activity</button>
</nav>
<div class="layout">
  <section class="panel" id="hostsPanel">
    <div class="panel-head">
      <h2>Hosts<span class="count" id="hostCount"></span></h2>
      <span class="spacer"></span>
      <select id="hostSort" data-testid="host-sort" aria-label="Sort hosts">
        <option value="name">Sort: Name</option>
        <option value="seen">Sort: Last seen</option>
        <option value="status">Sort: Status</option>
      </select>
    </div>
    <div class="bar">
      <div class="search" id="hostSearchWrap"><input id="hostSearch" type="search" placeholder="Search hosts…" autocomplete="off" data-testid="host-search" aria-label="Search hosts" /></div>
    </div>
    <div class="chips" id="tagChips"></div>
    <div class="scroll" id="hostList"></div>
  </section>
  <section class="panel" id="activityPanel">
    <div class="panel-head">
      <h2>Activity<span class="count" id="feedCount"></span></h2>
      <span class="spacer"></span>
      <div class="seg" id="scopeSeg" data-testid="feed-scope">
        <button id="scopeAll" class="on">All hosts</button>
        <button id="scopeHost" disabled>Selected host</button>
      </div>
    </div>
    <div class="bar">
      <div class="search" id="feedSearchWrap"><input id="feedSearch" type="search" placeholder="Search command, path, reason…" autocomplete="off" data-testid="feed-search" aria-label="Search activity" /></div>
      <div class="combo" id="sessCombo"><input id="sessFilter" placeholder="All sessions" autocomplete="off" data-testid="feed-session-filter" aria-label="Filter by session" /></div>
      <div class="combo" id="toolCombo"><input id="toolFilter" placeholder="All tools" autocomplete="off" data-testid="feed-tool-filter" aria-label="Filter by tool" /></div>
      <label class="check"><input type="checkbox" id="failOnly" data-testid="feed-fail-only" />Failures only</label>
    </div>
    <div class="scroll" id="feed" data-testid="activity-feed"></div>
  </section>
</div>

<div class="backdrop" id="backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" data-testid="host-modal">
    <h2 id="modalTitle">Add host</h2>
    <div class="form">
      <div class="field"><label for="f_label">Label</label><input id="f_label" placeholder="web-1" /></div>
      <div class="field"><label for="f_hostname">Host</label>
        <div class="two"><input id="f_hostname" placeholder="10.0.0.5 or host.example.com" /><label for="f_port">Port</label><input id="f_port" class="port" value="22" inputmode="numeric" /></div>
      </div>
      <div class="field"><label for="f_username">User</label><input id="f_username" placeholder="root" /></div>
      <div class="field">
        <span class="flabel">Auth</span>
        <div class="radios" role="radiogroup">
          <label><input type="radio" name="auth" value="key_ref" id="auth_ref" checked />Vault key</label>
          <label><input type="radio" name="auth" value="password" id="auth_pw" />Password (legacy)</label>
          <label id="auth_key_wrap" style="display:none"><input type="radio" name="auth" value="key" id="auth_key" />Inline key (legacy, kept)</label>
        </div>
      </div>
      <div class="field" id="refField">
        <div class="combo" id="keyCombo"><input id="f_key" placeholder="Pick a vault key…" autocomplete="off" aria-label="Vault key" data-testid="vault-key-picker" /></div>
        <span class="hint" id="refHint">The private key stays in Peckboard's vault — this plugin only stores a reference to it.</span>
      </div>
      <div class="field" id="pwField" style="display:none">
        <input id="f_password" type="password" placeholder="Password" aria-label="Password" />
        <span class="hint warn">Passwords are stored in this plugin's data store. Prefer a vault key.</span>
      </div>
      <div class="field" id="keyNote" style="display:none"><span class="hint warn">This host keeps its legacy inline private key. Pick a vault key to move it off the plugin.</span></div>
      <div class="field">
        <span class="flabel">Tags</span>
        <div class="tagbox" id="tagBox"><div class="combo" id="tagCombo"><input id="f_tag" placeholder="Add tag…" autocomplete="off" aria-label="Add tag" data-testid="tag-picker" /></div></div>
      </div>
      <div class="testres" id="testRes" role="status"></div>
      <div class="formerr" id="formErr"></div>
    </div>
    <div class="foot">
      <button id="testBtn" class="btn" data-testid="host-modal-test">Test connection</button>
      <span class="spacer"></span>
      <button id="cancelBtn" class="btn">Cancel</button>
      <button id="saveBtn" class="btn primary">Save</button>
    </div>
  </div>
</div>

<div class="backdrop" id="confirmBackdrop">
  <div class="modal small" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" data-testid="confirm-remove">
    <h2 id="confirmTitle">Remove host?</h2>
    <div class="desc" id="confirmText"></div>
    <div class="foot">
      <span class="spacer"></span>
      <button id="confirmCancel" class="btn">Cancel</button>
      <button id="confirmOk" class="btn danger" data-testid="confirm-remove-ok">Remove</button>
    </div>
  </div>
</div>
<div class="pop" id="rowMenu" role="menu"></div>
<div class="toast" id="toast" role="status"></div>

<script>
(function () {
  "use strict";

  // ── icons (static lucide paths; the only innerHTML on this page) ──
  function svg(p) { return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var IC = {
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    term: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    plug: svg('<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>'),
    warn: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    ext: svg('<path d="M7 17 17 7M8 7h9v9"/>'),
    chev: svg('<polyline points="9 18 15 12 9 6"/>'),
    down: svg('<polyline points="6 9 12 15 18 9"/>'),
    dots: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    server: svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>'),
    list: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
    filter: svg('<polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/>')
  };

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
  var PAGE_SIZE = 100;
  var RECENT_MS = 24 * 3600 * 1000;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function icon(name) { var s = el("span"); s.innerHTML = IC[name]; return s.firstChild; }
  function txt(s) { return document.createTextNode(s); }

  var state = {
    hosts: [], byId: {}, keys: [], keysLoaded: false,
    items: [], cursor: 0, oldest: 0, hasMore: false, loaded: false, open: {},
    hostQ: "", tag: "", sort: "name",
    sel: "", scopeHost: false, fSession: "", fTool: "", fFail: false, fQ: "",
    editing: null, authKind: "key_ref", keyId: "", formTags: [], pendingRemove: null
  };

  // ── formatting ─────────────────────────────────────────────────────
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Rows sit under a day heading, so the row itself shows just the clock time
  // (the full timestamp is the tooltip).
  function fmtTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return p2(d.getHours()) + ":" + p2(d.getMinutes());
  }
  function ago(ts) {
    if (!ts) return "never seen";
    var t = new Date(ts).getTime();
    if (isNaN(t)) return "never seen";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function fmtDur(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
    return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
  }
  function online(h) {
    if (h.last_status !== "ok" || !h.last_seen) return false;
    var t = new Date(h.last_seen).getTime();
    return !isNaN(t) && Date.now() - t < RECENT_MS;
  }

  // ── floating popups: one shared positioning helper ─────────────────
  function place(pop, anchor, alignRight) {
    var r = anchor.getBoundingClientRect();
    pop.style.minWidth = Math.max(180, alignRight ? 0 : r.width) + "px";
    pop.classList.add("open");
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = alignRight ? r.right - w : r.left;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 6 && r.top - h - 4 > 6) top = r.top - h - 4;
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }

  // Searchable combobox over a fixed option set (sessions, tools, vault keys,
  // tags) — never free text, except a tag picker's explicit "Create" option.
  // The list is a body-level fixed popup so it is never clipped by a scroller.
  function combo(input, cfg) {
    var pop = el("div", "pop"); pop.setAttribute("role", "listbox"); document.body.appendChild(pop);
    input.parentNode.appendChild(icon("down")).classList.add("caret");
    var shown = [], hi = -1;
    function render() {
      clear(pop); hi = -1;
      var q = (input.dataset.typing === "1" ? input.value : "").trim().toLowerCase();
      shown = cfg.items().filter(function (o) { return !q || o.text.toLowerCase().indexOf(q) >= 0 || (o.sub || "").toLowerCase().indexOf(q) >= 0; }).slice(0, 200);
      if (cfg.create && q && !cfg.items().some(function (o) { return o.text.toLowerCase() === q; })) shown.push({ value: input.value.trim(), text: "Create tag “" + input.value.trim() + "”", create: true });
      shown.forEach(function (o, i) {
        var b = el("button", "mi" + (o.value === cfg.current() ? " sel" : "")); b.type = "button"; b.setAttribute("role", "option");
        b.appendChild(el("span", null, o.text));
        if (o.sub) b.appendChild(el("span", "sub", o.sub));
        b.onmousedown = function (ev) { ev.preventDefault(); pick(i); };
        pop.appendChild(b);
      });
      if (!shown.length) pop.appendChild(el("div", "none", cfg.empty || "No match"));
      place(pop, input, false);
    }
    function hl(n) {
      var nodes = pop.querySelectorAll(".mi"); if (!nodes.length) return;
      hi = (n + nodes.length) % nodes.length;
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("hi", i === hi);
      nodes[hi].scrollIntoView({ block: "nearest" });
    }
    function pick(i) { var o = shown[i]; close(); input.blur(); if (o) cfg.onPick(o); }
    function close() { pop.classList.remove("open"); input.dataset.typing = ""; sync(); }
    function sync() { if (cfg.display && document.activeElement !== input) input.value = cfg.display(); }
    input.addEventListener("focus", function () { input.dataset.typing = ""; input.select(); render(); });
    input.addEventListener("input", function () { input.dataset.typing = "1"; render(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); hl(hi + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hl(hi - 1); }
      else if (e.key === "Enter") { e.preventDefault(); if (shown.length) pick(hi < 0 ? 0 : hi); }
      else if (e.key === "Escape") { e.stopPropagation(); close(); input.blur(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 120); });
    return { sync: sync, close: close };
  }

  // ── hosts ──────────────────────────────────────────────────────────
  function loadHosts() {
    return getJSON(API + "/hosts").then(function (d) {
      state.hosts = d.hosts || [];
      state.byId = {};
      state.hosts.forEach(function (h) { state.byId[h.id] = h; });
      if (state.sel && !state.byId[state.sel]) { state.sel = ""; state.scopeHost = false; }
      renderHosts(); renderSummary(); renderScope();
    }).catch(function (e) { toast("Failed to load hosts: " + e.message, true); });
  }

  function isToday(ts) { return !!ts && new Date(ts).toDateString() === new Date().toDateString(); }
  function renderSummary() {
    var n = state.hosts.length, on = state.hosts.filter(online).length;
    var today = state.items.filter(function (a) { return isToday(a.ts); }).length;
    // Only the loaded pages are counted: if older pages exist and the oldest
    // loaded call is still from today, the true count is higher.
    var more = state.hasMore && state.items.length && isToday(state.items[0].ts) ? "+" : "";
    var s = $("summary"); clear(s);
    function stat(num, label, cls) {
      var sp = el("span", cls || null); sp.appendChild(el("b", null, num)); sp.appendChild(txt(" " + label)); s.appendChild(sp);
    }
    stat(String(n), n === 1 ? "host" : "hosts");
    if (n) stat(String(on), "online", "on");
    if (state.loaded) stat(today + more, today === 1 && !more ? "call today" : "calls today");
    $("tabHosts").textContent = "Hosts (" + n + ")";
  }

  function authBadge(h) {
    var b;
    if (h.auth_kind === "key_ref") {
      b = el("span", "badge vault"); b.appendChild(icon("key")); b.appendChild(txt("vault key"));
      b.title = "Vault key: " + (h.key_name || h.key_id || "(missing)");
    } else {
      // Legacy hosts hold the credential inside this plugin's own store; there
      // is deliberately no automatic migration (plugins can't write the vault).
      b = el("span", "badge legacy"); b.appendChild(icon("warn"));
      b.appendChild(txt(h.auth_kind === "key" ? "inline key (legacy)" : "inline password (legacy)"));
      b.title = "Stored in this plugin, not the vault. Edit the host and pick a vault key.";
    }
    return b;
  }

  var STATUS_RANK = { error: 0, unknown: 1, ok: 2 };
  function sortedHosts(list) {
    return list.slice().sort(function (a, b) {
      if (state.sort === "seen") {
        var ta = a.last_seen ? new Date(a.last_seen).getTime() : 0, tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
        if (ta !== tb) return tb - ta;
      } else if (state.sort === "status") {
        var ra = online(a) ? 2 : (STATUS_RANK[a.last_status] == null ? 1 : STATUS_RANK[a.last_status]);
        var rb = online(b) ? 2 : (STATUS_RANK[b.last_status] == null ? 1 : STATUS_RANK[b.last_status]);
        if (ra !== rb) return ra - rb;
      }
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function allTags() {
    var t = {};
    state.hosts.forEach(function (h) { (h.tags || []).forEach(function (x) { t[x] = (t[x] || 0) + 1; }); });
    return t;
  }

  function renderTagChips() {
    var tags = allTags(), names = Object.keys(tags).sort();
    if (state.tag && !tags[state.tag]) state.tag = "";
    var wrap = $("tagChips"); clear(wrap);
    function chip(label, value, testid) {
      var c = el("button", "chip" + (value === null ? (!state.sel ? " on" : "") : (state.tag === value ? " on" : "")), label);
      c.type = "button"; c.dataset.testid = testid;
      if (value !== null) c.dataset.tag = value;
      c.onclick = function () {
        if (value === null) selectHost("");
        else { state.tag = state.tag === value ? "" : value; renderHosts(); }
      };
      wrap.appendChild(c);
    }
    if (!state.hosts.length) return;
    // "All hosts" clears the host selection (and so the activity scope).
    chip("All hosts", null, "hosts-all");
    names.forEach(function (t) { chip("#" + t, t, "tag-chip"); });
  }

  function renderHosts() {
    renderTagChips();
    var q = state.hostQ.trim().toLowerCase();
    var list = $("hostList"); clear(list);
    var hosts = sortedHosts(state.hosts.filter(function (h) {
      if (state.tag && (h.tags || []).indexOf(state.tag) < 0) return false;
      if (!q) return true;
      var hay = (h.label + " " + h.hostname + " " + h.username + " " + (h.tags || []).join(" ") + " " + (h.key_name || "")).toLowerCase();
      return hay.indexOf(q) >= 0;
    }));
    $("hostCount").textContent = state.hosts.length ? (hosts.length === state.hosts.length ? String(hosts.length) : hosts.length + " of " + state.hosts.length) : "";
    if (!state.hosts.length) {
      var add = el("button", "btn primary"); add.appendChild(icon("plus")); add.appendChild(txt("Add host")); add.onclick = openAdd;
      list.appendChild(emptyState("server", "No hosts yet", "Add the machines your agents may reach over SSH. Use a key from Peckboard's SSH key vault.", add));
      return;
    }
    if (!hosts.length) {
      var reset = el("button", "btn", "Clear search"); reset.onclick = function () { state.hostQ = ""; state.tag = ""; $("hostSearch").value = ""; renderHosts(); };
      list.appendChild(emptyState("search", "No hosts match", "Nothing matches that search or tag.", reset));
      return;
    }
    hosts.forEach(function (h) { list.appendChild(hostRow(h)); });
  }

  function hostRow(h) {
    var on = online(h);
    var row = el("div", "host" + (state.sel === h.id ? " active" : ""));
    row.dataset.testid = "host-row"; row.dataset.host = h.id; row.tabIndex = 0;
    row.title = state.sel === h.id ? "Showing this host's activity — click to show all" : "Show this host's activity";
    var d = el("span", "dot " + (on ? "on" : "off") + (h.last_status === "error" ? " bad" : ""));
    d.title = on ? "Reachable" : h.last_status === "error" ? "Last connection failed" : "Not seen recently";
    d.setAttribute("aria-label", d.title);
    row.appendChild(d);
    row.appendChild(el("span", "name", h.label));
    var acts = el("div", "acts");
    var term = el("button", "btn sm"); term.type = "button"; term.dataset.testid = "open-terminal";
    term.appendChild(icon("term")); term.appendChild(el("span", "term-word", "Terminal")); term.title = "Open an interactive shell on this host";
    term.setAttribute("aria-label", "Open terminal on " + h.label);
    term.onclick = function (ev) { ev.stopPropagation(); openTerminal(h); };
    acts.appendChild(term);
    var more = el("button", "ibtn"); more.type = "button"; more.appendChild(icon("dots"));
    more.title = "More actions"; more.setAttribute("aria-label", "More actions for " + h.label);
    more.setAttribute("aria-haspopup", "menu"); more.dataset.testid = "host-menu";
    more.onclick = function (ev) { ev.stopPropagation(); openRowMenu(h, more); };
    acts.appendChild(more);
    row.appendChild(acts);
    var addr = el("span", "addr mono", h.username + "@" + h.hostname + ":" + h.port); addr.title = addr.textContent;
    row.appendChild(addr);
    var l2 = el("div", "l2");
    l2.appendChild(authBadge(h));
    (h.tags || []).forEach(function (t) { l2.appendChild(el("span", "tag", t)); });
    var seen = el("span", "seen", "· " + ago(h.last_seen)); seen.title = h.last_seen ? "Last seen " + h.last_seen : "Never connected";
    l2.appendChild(seen);
    row.appendChild(l2);
    if (h.last_status === "error" && h.last_error) { var er = el("div", "err", h.last_error); er.title = h.last_error; row.appendChild(er); }
    function pick() { selectHost(state.sel === h.id ? "" : h.id); if (state.sel) showTab("activity"); }
    row.onclick = pick;
    row.onkeydown = function (e) { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(); } };
    return row;
  }

  // ── row ⋯ menu ─────────────────────────────────────────────────────
  var menuFor = null;
  function openRowMenu(h, btn) {
    var m = $("rowMenu");
    if (menuFor === h.id && m.classList.contains("open")) { closeRowMenu(); return; }
    closeRowMenu();
    clear(m); menuFor = h.id; btn.classList.add("open");
    function item(ic, label, testid, fn, danger) {
      var b = el("button", "mi" + (danger ? " danger" : "")); b.type = "button"; b.setAttribute("role", "menuitem");
      b.dataset.testid = testid; b.appendChild(icon(ic)); b.appendChild(txt(label));
      b.onclick = function () { closeRowMenu(); fn(); };
      m.appendChild(b);
    }
    item("term", "Open terminal", "menu-terminal", function () { openTerminal(h); });
    item("plug", "Test connection", "menu-test", function () { testHost(h); });
    item("edit", "Edit", "menu-edit", function () { openEdit(h); });
    m.appendChild(el("div", "sep"));
    item("trash", "Remove", "menu-remove", function () { askRemove(h); }, true);
    m._btn = btn;
    place(m, btn, true);
    var first = m.querySelector(".mi"); if (first) first.focus();
  }
  function closeRowMenu() {
    var m = $("rowMenu"); m.classList.remove("open");
    if (m._btn) m._btn.classList.remove("open");
    m._btn = null; menuFor = null;
  }
  document.addEventListener("mousedown", function (e) {
    var m = $("rowMenu");
    if (m.classList.contains("open") && !m.contains(e.target) && e.target !== m._btn && !(m._btn && m._btn.contains(e.target))) closeRowMenu();
  });
  window.addEventListener("resize", closeRowMenu);
  document.addEventListener("scroll", function (e) { if (!$("rowMenu").contains(e.target)) closeRowMenu(); }, true);

  function testHost(h) {
    toast("Testing " + h.label + "…");
    postJSON(API + "/probe", { host: h.id }).then(function (r) {
      toast(h.label + ": connected in " + r.latency_ms + " ms");
    }).catch(function (e) { toast(h.label + ": " + e.message, true); })
      .then(function () { loadHosts(); poll(); });
  }

  // ── remove (in-page confirm: sandboxed iframes have no window.confirm) ─
  function askRemove(h) {
    state.pendingRemove = h;
    $("confirmTitle").textContent = "Remove " + h.label + "?";
    $("confirmText").textContent = "This deletes the saved connection details for " + h.username + "@" + h.hostname + ". Its activity history is kept.";
    $("confirmBackdrop").classList.add("open");
    $("confirmOk").focus();
  }
  function closeConfirm() { $("confirmBackdrop").classList.remove("open"); state.pendingRemove = null; }
  function doRemove() {
    var h = state.pendingRemove; if (!h) return;
    closeConfirm();
    postJSON(API + "/host-remove", { id: h.id }).then(function () {
      if (state.sel === h.id) selectHost("");
      toast("Removed " + h.label); loadHosts();
    }).catch(function (e) { toast("Remove failed: " + e.message, true); });
  }

  // ── host selection ↔ activity scope ────────────────────────────────
  function selectHost(id) {
    state.sel = id; state.scopeHost = !!id;
    renderHosts(); renderScope(); renderFeed();
  }
  function renderScope() {
    var h = state.byId[state.sel];
    var b = $("scopeHost");
    b.disabled = !h; b.textContent = h ? h.label : "Selected host"; b.title = h ? h.label : "Click a host to scope the activity to it";
    b.classList.toggle("on", !!h && state.scopeHost);
    $("scopeAll").classList.toggle("on", !h || !state.scopeHost);
  }

  // ── activity feed ──────────────────────────────────────────────────
  function addItems(items, older) {
    if (!items.length) return;
    state.items = older ? items.concat(state.items) : state.items.concat(items);
    state.oldest = state.items[0].id;
  }
  function loadFirst() {
    return getJSON(API + "/activity?host=all&since=0&limit=" + PAGE_SIZE).then(function (d) {
      state.cursor = d.cursor || 0; state.hasMore = !!d.has_more; state.loaded = true;
      addItems(d.items || [], false);
      renderFeed();
    }).catch(function (e) { state.loaded = true; renderFeed(); toast("Failed to load activity: " + e.message, true); });
  }
  var polling = false;
  function poll() {
    if (polling || !state.loaded) return;
    polling = true;
    getJSON(API + "/activity?host=all&since=" + state.cursor)
      .then(function (d) {
        state.cursor = d.cursor || state.cursor;
        if ((d.items || []).length) { addItems(d.items, false); renderFeed(); }
      })
      .catch(function () { /* transient; keep polling */ })
      .then(function () { polling = false; });
  }
  function loadOlder(btn) {
    btn.disabled = true; btn.textContent = "Loading…";
    getJSON(API + "/activity?host=all&before=" + state.oldest + "&limit=" + PAGE_SIZE).then(function (d) {
      state.hasMore = !!d.has_more;
      addItems(d.items || [], true);
      renderFeed();
    }).catch(function (e) { toast("Load failed: " + e.message, true); btn.disabled = false; btn.textContent = "Load older"; });
  }

  function sessKey(a) { return a.session_id ? "s:" + a.session_id : a.source === "dashboard" ? "dash" : "none"; }
  function sessLabel(a) { return a.session_name || ("Session " + String(a.session_id).slice(0, 8)); }
  function sessionOptions() {
    var seen = {}, out = [{ value: "", text: "All sessions" }];
    for (var i = state.items.length - 1; i >= 0; i--) {
      var a = state.items[i], k = sessKey(a);
      if (seen[k]) continue; seen[k] = true;
      out.push({ value: k, text: k === "dash" ? "This page (connection tests)" : k === "none" ? "Unattributed (before 0.6.0)" : sessLabel(a), sub: a.session_id ? String(a.session_id).slice(0, 8) : "" });
    }
    return out;
  }
  function toolOptions() {
    var seen = {}, out = [{ value: "", text: "All tools" }];
    state.items.forEach(function (a) { seen[a.tool] = (seen[a.tool] || 0) + 1; });
    Object.keys(seen).sort().forEach(function (t) { out.push({ value: t, text: t, sub: String(seen[t]) }); });
    return out;
  }

  function failed(a) { return !a.ok || !!a.error; }
  function matches(a, q) {
    if (state.scopeHost && state.sel && a.host_id !== state.sel) return false;
    if (state.fSession && sessKey(a) !== state.fSession) return false;
    if (state.fTool && a.tool !== state.fTool) return false;
    if (state.fFail && !failed(a)) return false;
    if (q) {
      var hay = [a.summary, a.reason, a.host_label, a.tool, a.session_name, a.error].join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function renderFeed() {
    var feed = $("feed"), q = state.fQ.trim().toLowerCase();
    renderSummary();
    var shown = [];
    for (var i = state.items.length - 1; i >= 0; i--) if (matches(state.items[i], q)) shown.push(state.items[i]);
    var filtered = (state.scopeHost && state.sel) || state.fSession || state.fTool || state.fFail || q;
    $("feedCount").textContent = state.items.length ? (filtered ? shown.length + " of " + state.items.length : String(state.items.length)) + (state.hasMore ? "+" : "") : "";
    var scroll = feed.scrollTop;
    clear(feed);
    if (!state.loaded) { feed.appendChild(el("div", "empty", "Loading…")); return; }
    if (!state.items.length) {
      feed.appendChild(emptyState("list", "No activity yet", "Agents' SSH calls show up here with their reason and session."));
      return;
    }
    var frag = document.createDocumentFragment();
    if (!shown.length) {
      var reset = el("button", "btn", "Clear filters"); reset.onclick = clearFilters;
      frag.appendChild(emptyState("filter", "Nothing matches these filters", state.hasMore ? "Try other filters, or load older activity." : "Try another host, session, or tool.", reset));
    }
    var lastDay = null;
    shown.forEach(function (a) {
      var day = dayLabel(a.ts);
      if (day !== lastDay) { frag.appendChild(el("div", "day", day)); lastDay = day; }
      frag.appendChild(feedRow(a));
    });
    if (state.hasMore) {
      var more = el("div", "more"); var b = el("button", "btn", "Load older"); b.dataset.testid = "feed-load-older";
      b.onclick = function () { loadOlder(b); }; more.appendChild(b); frag.appendChild(more);
    }
    feed.appendChild(frag);
    feed.scrollTop = scroll;
  }
  function dayLabel(ts) {
    var d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) return "Earlier";
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (d.toDateString() === new Date().toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return MONTHS[d.getMonth()] + " " + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? ", " + d.getFullYear() : "");
  }

  var RUN_TOOLS = { ssh_run: true, ssh_run_many: true };
  function feedRow(a) {
    var bad = failed(a);
    // Failures open by default; the user's own toggle wins either way.
    var isOpen = state.open[a.id] == null ? bad : state.open[a.id];
    var row = el("article", "act" + (bad ? " bad" : "") + (isOpen ? " open" : ""));
    row.dataset.testid = "activity-row"; row.dataset.id = a.id;

    var top = el("div", "act-top");
    var t = el("time", null, fmtTime(a.ts)); if (a.ts) { t.title = a.ts; t.setAttribute("datetime", a.ts); }
    top.appendChild(t);
    var host = el("button", "hostname", a.host_label || "—"); host.type = "button"; host.title = "Show only this host";
    host.onclick = function () { if (a.host_id && state.byId[a.host_id]) selectHost(a.host_id); };
    top.appendChild(host);
    top.appendChild(el("span", "tool mono", a.tool));
    var r = el("span", "res " + (bad ? "bad" : "ok"), statusText(a, bad)); r.dataset.testid = "activity-status"; top.appendChild(r);
    if (a.duration_ms != null) top.appendChild(el("span", "dur", fmtDur(a.duration_ms)));
    row.appendChild(top);

    if (a.summary) {
      var w = el("code", "what");
      if (RUN_TOOLS[a.tool]) w.appendChild(el("span", "p", "$ "));
      w.appendChild(txt(a.summary));
      row.appendChild(w);
    }

    var why = el("div", "kv reason" + (a.reason ? "" : " none")); why.dataset.testid = "activity-reason";
    why.appendChild(el("span", "k", "Reason"));
    why.appendChild(el("span", "v", a.reason || (a.source === "dashboard" ? "Connection test from this page" : "—")));
    row.appendChild(why);

    var who = el("div", "kv"); who.appendChild(el("span", "k", "Session"));
    var wv = el("span", "v");
    if (a.session_id) {
      var link = el("a", "sess"); link.href = "#"; link.dataset.testid = "activity-session"; link.dataset.session = a.session_id;
      link.appendChild(icon("ext")); link.appendChild(el("span", null, sessLabel(a)));
      link.title = "Open this session in Peckboard";
      link.onclick = function (e) { e.preventDefault(); openSession(a.session_id); };
      wv.appendChild(link);
    } else {
      wv.textContent = a.source === "dashboard" ? "this page" : "—";
      if (!a.source) wv.title = "Recorded before sessions were tracked";
    }
    who.appendChild(wv); row.appendChild(who);

    var hasDiff = !!a.diff_preview, hasOut = !!(a.stdout_preview || a.stderr_preview || a.error);
    if (hasDiff || hasOut) {
      var tg = el("button", "fold"); tg.type = "button"; tg.dataset.testid = "activity-output-toggle";
      tg.appendChild(icon("chev")); tg.appendChild(txt(foldLabel(a, hasDiff)));
      tg.setAttribute("aria-expanded", isOpen ? "true" : "false");
      tg.onclick = function () {
        var now = !row.classList.contains("open");
        state.open[a.id] = now; row.classList.toggle("open", now); tg.setAttribute("aria-expanded", now ? "true" : "false");
      };
      row.appendChild(tg);
      var body = el("div", "body");
      if (a.error) { body.appendChild(el("div", "lbl", "error")); body.appendChild(el("pre", "error", a.error)); }
      if (hasDiff) {
        var pre = el("pre", "diff");
        a.diff_preview.split(String.fromCharCode(10)).forEach(function (ln) {
          var c = ln.charAt(0) === "+" ? "add" : ln.charAt(0) === "-" ? "del" : "ctx";
          pre.appendChild(el("span", c, ln || " "));
        });
        body.appendChild(pre);
      }
      if (a.stdout_preview) { body.appendChild(el("div", "lbl", a.tool === "ssh_read_file" ? "content" : "stdout")); body.appendChild(el("pre", null, a.stdout_preview)); }
      if (a.stderr_preview) { body.appendChild(el("div", "lbl", "stderr")); body.appendChild(el("pre", "stderr", a.stderr_preview)); }
      row.appendChild(body);
    }
    return row;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  // The one-word outcome in the row header: exit code for commands, what
  // happened for file ops.
  function statusText(a, bad) {
    if (RUN_TOOLS[a.tool] && !a.error) return (a.exit_code === 0 ? "✓" : "✗") + " exit " + (a.exit_code == null ? "?" : a.exit_code);
    if (bad) return "✗ failed";
    if (a.tool === "ssh_read_file") return "✓ " + (a.bytes != null ? fmtBytes(a.bytes) : "read");
    if (a.tool === "ssh_write_file") return "✓ written" + (a.bytes != null ? " · " + fmtBytes(a.bytes) : "");
    if (a.tool === "ssh_edit_file") return "✓ edited";
    if (a.tool === "ssh_probe") return "✓ connected";
    return "✓ ok";
  }
  function lineCount(s) {
    if (!s) return 0;
    var lines = s.split(String.fromCharCode(10));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  }
  function foldLabel(a, hasDiff) {
    if (hasDiff && !a.error) {
      var add = 0, del = 0;
      a.diff_preview.split(String.fromCharCode(10)).forEach(function (ln) { if (ln.charAt(0) === "+") add++; else if (ln.charAt(0) === "-") del++; });
      return "Diff · +" + add + " −" + del;
    }
    if (a.tool === "ssh_read_file" && !a.error) return "Content";
    var n = lineCount(a.stdout_preview) + lineCount(a.stderr_preview);
    return n ? "Output · " + n + (n === 1 ? " line" : " lines") : "Output";
  }

  function emptyState(ic, title, text, action) {
    var e = el("div", "empty");
    var i = el("div", "ico"); i.appendChild(icon(ic)); e.appendChild(i);
    e.appendChild(el("h3", null, title));
    e.appendChild(el("p", null, text));
    if (action) e.appendChild(action);
    return e;
  }

  function clearFilters() {
    state.fSession = ""; state.fTool = ""; state.fFail = false; state.fQ = ""; state.scopeHost = false;
    $("failOnly").checked = false; $("feedSearch").value = "";
    sessCombo.sync(); toolCombo.sync(); renderScope(); renderFeed();
  }

  var sessCombo = combo($("sessFilter"), {
    items: sessionOptions, current: function () { return state.fSession; },
    display: function () { if (!state.fSession) return ""; var o = sessionOptions().filter(function (x) { return x.value === state.fSession; })[0]; return o ? o.text : ""; },
    onPick: function (o) { state.fSession = o.value; renderFeed(); }
  });
  var toolCombo = combo($("toolFilter"), {
    items: toolOptions, current: function () { return state.fTool; },
    display: function () { return state.fTool; },
    onPick: function (o) { state.fTool = o.value; renderFeed(); }
  });

  // ── add / edit host modal ──────────────────────────────────────────
  function loadKeys() {
    if (state.keysLoaded) return Promise.resolve(state.keys);
    return getJSON(API + "/ssh-keys").then(function (d) {
      state.keys = d.keys || []; state.keysLoaded = true; return state.keys;
    }).catch(function (e) {
      state.keys = [];
      $("refHint").textContent = "Could not load the SSH key vault: " + e.message;
      return state.keys;
    });
  }
  function keyLabel(id) {
    var k = state.keys.filter(function (x) { return x.id === id; })[0];
    return k ? k.name : (id ? "(key no longer in the vault)" : "");
  }
  var keyCombo = combo($("f_key"), {
    items: function () { return state.keys.map(function (k) { return { value: k.id, text: k.name, sub: k.key_type }; }); },
    current: function () { return state.keyId; },
    display: function () { return keyLabel(state.keyId); },
    empty: "No keys in the vault — add one in Settings → SSH keys",
    onPick: function (o) { state.keyId = o.value; }
  });
  var tagCombo = combo($("f_tag"), {
    items: function () {
      var t = allTags();
      return Object.keys(t).sort().filter(function (x) { return state.formTags.indexOf(x) < 0; }).map(function (x) { return { value: x, text: x, sub: t[x] + (t[x] === 1 ? " host" : " hosts") }; });
    },
    create: true, current: function () { return ""; }, display: function () { return ""; },
    onPick: function (o) {
      var v = String(o.value || "").trim();
      if (v && state.formTags.indexOf(v) < 0) state.formTags.push(v);
      renderFormTags();
    }
  });
  function renderFormTags() {
    var box = $("tagBox"), keep = $("tagCombo");
    while (box.firstChild && box.firstChild !== keep) box.removeChild(box.firstChild);
    state.formTags.forEach(function (t) {
      var c = el("span", "tag"); c.appendChild(txt(t));
      var x = el("button", null, "×"); x.type = "button"; x.setAttribute("aria-label", "Remove tag " + t);
      x.onclick = function () { state.formTags = state.formTags.filter(function (y) { return y !== t; }); renderFormTags(); };
      c.appendChild(x); box.insertBefore(c, keep);
    });
  }

  function setAuth(kind) {
    state.authKind = kind;
    $("auth_ref").checked = kind === "key_ref"; $("auth_pw").checked = kind === "password"; $("auth_key").checked = kind === "key";
    $("refField").style.display = kind === "key_ref" ? "" : "none";
    $("pwField").style.display = kind === "password" ? "" : "none";
    $("keyNote").style.display = kind === "key" ? "" : "none";
  }
  function resetForm() {
    ["f_label", "f_hostname", "f_username", "f_password", "f_tag"].forEach(function (i) { $(i).value = ""; });
    $("f_port").value = "22"; $("formErr").textContent = ""; $("testRes").textContent = ""; $("testRes").className = "testres";
  }
  function openAdd() {
    state.editing = null; resetForm();
    $("modalTitle").textContent = "Add host"; $("auth_key_wrap").style.display = "none";
    state.keyId = ""; state.formTags = []; renderFormTags();
    $("f_password").placeholder = "Password";
    setAuth("key_ref");
    $("backdrop").classList.add("open"); $("f_label").focus();
    loadKeys().then(function (keys) {
      if (!state.editing && keys.length && !state.keyId) state.keyId = keys[0].id;
      keyCombo.sync();
      if (!keys.length) $("refHint").textContent = "No keys in the vault yet — add one in Settings → SSH keys, or use a password.";
    });
  }
  function openEdit(h) {
    state.editing = h.id; resetForm();
    $("modalTitle").textContent = "Edit " + h.label;
    $("f_label").value = h.label; $("f_hostname").value = h.hostname; $("f_port").value = h.port; $("f_username").value = h.username;
    $("f_password").placeholder = h.auth_kind === "password" ? "(unchanged)" : "Password";
    $("auth_key_wrap").style.display = h.auth_kind === "key" ? "" : "none";
    state.keyId = h.key_id || ""; state.formTags = (h.tags || []).slice(); renderFormTags();
    setAuth(h.auth_kind === "key_ref" ? "key_ref" : h.auth_kind === "key" ? "key" : "password");
    $("backdrop").classList.add("open");
    loadKeys().then(function () { keyCombo.sync(); });
  }
  function closeModal() { $("backdrop").classList.remove("open"); keyCombo.close(); tagCombo.close(); }
  function formBody() {
    var body = {
      label: $("f_label").value, hostname: $("f_hostname").value, port: $("f_port").value,
      username: $("f_username").value, tags: state.formTags.slice()
    };
    if (state.authKind === "key_ref" && state.keyId) body.key_id = state.keyId;
    if (state.authKind === "password" && $("f_password").value) body.password = $("f_password").value;
    if (state.editing) body.id = state.editing;
    return body;
  }
  function formProblem(body) {
    if (!body.hostname.trim()) return "Enter the host.";
    if (!body.username.trim()) return "Enter the user.";
    var cur = state.editing ? state.byId[state.editing] : null;
    if (state.authKind === "key_ref" && !body.key_id) return "Pick a vault key.";
    if (state.authKind === "password" && !body.password && (!cur || cur.auth_kind !== "password")) return "Enter the password.";
    return "";
  }
  function saveHost() {
    var body = formBody(), p = formProblem(body);
    if (p) { $("formErr").textContent = p; return; }
    var btn = $("saveBtn"); btn.disabled = true;
    postJSON(API + "/hosts", body).then(function () { closeModal(); toast("Saved " + (body.label || body.hostname)); loadHosts(); })
      .catch(function (e) { $("formErr").textContent = e.message; })
      .then(function () { btn.disabled = false; });
  }
  function testDraft() {
    var body = formBody(), p = formProblem(body), res = $("testRes");
    $("formErr").textContent = "";
    if (p) { $("formErr").textContent = p; return; }
    var btn = $("testBtn"); btn.disabled = true;
    res.className = "testres"; res.textContent = "Connecting…";
    postJSON(API + "/probe-draft", body).then(function (r) {
      res.className = "testres ok"; res.textContent = "✓ Connected in " + r.latency_ms + " ms · " + r.server_fingerprint;
    }).catch(function (e) { res.className = "testres bad"; res.textContent = "✗ " + e.message; })
      .then(function () { btn.disabled = false; });
  }

  // ── toast ──────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $("toast"); t.textContent = msg; t.classList.add("open"); t.classList.toggle("err", !!isErr);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("open"); }, 5000);
  }

  // ── app navigation (the parent app does the routing) ───────────────
  // Shells are a Peckboard core feature: a full-size, tmux-persistent tab in
  // the app. This page only asks the app to open one (the app resolves the
  // host through this plugin's terminal.host.resolve hook) or to open a session.
  function openTerminal(h) { window.parent.postMessage({ type: "plugin-ui-open-terminal", hostId: h.id }, "*"); }
  function openSession(id) { window.parent.postMessage({ type: "plugin-ui-open-session", sessionId: id }, "*"); }

  function showTab(tab) {
    document.body.dataset.tab = tab;
    $("tabHosts").classList.toggle("on", tab === "hosts");
    $("tabActivity").classList.toggle("on", tab === "activity");
  }

  // ── wire up ────────────────────────────────────────────────────────
  $("addIco").outerHTML = IC.plus;
  $("hostSearchWrap").insertBefore(icon("search"), $("hostSearch"));
  $("feedSearchWrap").insertBefore(icon("search"), $("feedSearch"));
  $("addBtn").onclick = openAdd;
  $("cancelBtn").onclick = closeModal;
  $("saveBtn").onclick = saveHost;
  $("testBtn").onclick = testDraft;
  ["auth_ref", "auth_pw", "auth_key"].forEach(function (id) { $(id).onchange = function () { setAuth($(id).value); }; });
  $("confirmCancel").onclick = closeConfirm;
  $("confirmOk").onclick = doRemove;
  $("tabHosts").onclick = function () { showTab("hosts"); };
  $("tabActivity").onclick = function () { showTab("activity"); };
  $("scopeAll").onclick = function () { state.scopeHost = false; renderScope(); renderFeed(); };
  $("scopeHost").onclick = function () { if (state.sel) { state.scopeHost = true; renderScope(); renderFeed(); } };
  $("hostSearch").addEventListener("input", function () { state.hostQ = $("hostSearch").value; renderHosts(); });
  $("hostSort").addEventListener("change", function () { state.sort = $("hostSort").value; renderHosts(); });
  $("failOnly").addEventListener("change", function () { state.fFail = $("failOnly").checked; renderFeed(); });
  $("feedSearch").addEventListener("input", function () { state.fQ = $("feedSearch").value; renderFeed(); });
  $("backdrop").addEventListener("mousedown", function (e) { if (e.target === $("backdrop")) closeModal(); });
  $("confirmBackdrop").addEventListener("mousedown", function (e) { if (e.target === $("confirmBackdrop")) closeConfirm(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("rowMenu").classList.contains("open")) closeRowMenu();
    else if ($("confirmBackdrop").classList.contains("open")) closeConfirm();
    else if ($("backdrop").classList.contains("open")) closeModal();
  });
  // Wide screens show both columns; start narrow screens on Activity once
  // there are hosts (the audit trail is what people come back for).
  if (window.matchMedia("(max-width: 760px)").matches) showTab("activity");

  renderFeed();
  loadHosts().then(function () { if (!state.hosts.length) showTab("hosts"); return loadFirst(); });
  setInterval(poll, 2000);
  setInterval(loadHosts, 15000); // refresh statuses + "last seen"
})();
</script>
</body>
</html>`;
