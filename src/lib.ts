// Hook + tool dispatch. Parses the `{ hook, payload }` envelope and routes each
// call to its handler. The wasm export functions live in `index.ts`.
//
// Slow SSH tools use the DEFER protocol (see `verdict.ts` and the Rust
// `Verdict::Defer` loop): a phase-1 handler returns a `deferReq` sentinel, core
// runs the op with the plugin instance free, then re-enters `handle` with
// `{resume, op_result}` so the matching FINALIZER can finish.

import { skip, allow, cancel, defer, isDeferReq, errMsg } from "./verdict";
import { serveHttp, serveAuthed } from "./http";
import { terminalHosts, resolveTerminalHost } from "./terminals";
import { Actor, actorFrom, checkReason } from "./activity";
import {
  sshHostAdd,
  sshHostUpdate,
  sshHostRemove,
  sshHostList,
  sshProbeTool,
  sshProbeFinalize,
  sshRun,
  sshRunFinalize,
  sshRunMany,
  sshRunManyFinalize,
  sshReadFileTool,
  sshReadFileFinalize,
  sshWriteFileTool,
  sshWriteFileFinalize,
  sshEditFileTool,
  sshEditFileFinalize,
  REASON_REQUIRED_TOOLS,
} from "./tools";

/// Phase-1 tool handlers. A slow tool returns a `deferReq` sentinel (core runs
/// the op, then re-enters via FINALIZERS); a synchronous tool returns its result.
const TOOLS: Record<string, (args: any, actor: Actor) => any> = {
  ssh_host_add: sshHostAdd,
  ssh_host_update: sshHostUpdate,
  ssh_host_remove: sshHostRemove,
  ssh_host_list: sshHostList,
  ssh_probe: sshProbeTool,
  ssh_run: sshRun,
  ssh_run_many: sshRunMany,
  ssh_read_file: sshReadFileTool,
  ssh_write_file: sshWriteFileTool,
  ssh_edit_file: sshEditFileTool,
};

/// Finalize handlers, keyed by tool: core calls these on the defer re-entry with
/// `(args, resume, op_result)`. A finalizer may itself return a `deferReq`
/// (e.g. ssh_edit_file: read, then write).
const FINALIZERS: Record<string, (args: any, resume: any, opResult: any, actor: Actor) => any> = {
  ssh_probe: sshProbeFinalize,
  ssh_run: sshRunFinalize,
  ssh_run_many: sshRunManyFinalize,
  ssh_read_file: sshReadFileFinalize,
  ssh_write_file: sshWriteFileFinalize,
  ssh_edit_file: sshEditFileFinalize,
};

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    // Core's interactive terminals ask us for hosts / a host's connection.
    case "terminal.hosts.list":
      return allow(terminalHosts());
    case "terminal.host.resolve":
      try {
        return allow(resolveTerminalHost(payload));
      } catch (e) {
        return cancel(errMsg(e));
      }
    default:
      return skip();
  }
}

/// Turn a handler result into a verdict: a `deferReq` sentinel becomes a
/// `defer` verdict; anything else is an `allow` payload.
function verdictFor(r: unknown): string {
  return isDeferReq(r) ? defer(r.__defer__.op, r.__defer__.resume) : allow(r);
}

function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const args = payload.arguments ?? {};

  // Defer re-entry: core ran the op and handed back its result. Route to the
  // finalizer, which returns a result or defers again (ssh_edit_file). The
  // reason was validated in phase 1; core re-sends the same arguments.
  if ("op_result" in payload) {
    const fin = FINALIZERS[tool];
    if (!fin) {
      return cancel(`ssh-fleet has no finalizer for tool '${tool}'`);
    }
    try {
      const actor = actorFrom(payload, checkReason(args.reason, false));
      return verdictFor(fin(args, payload.resume, payload.op_result, actor));
    } catch (e) {
      return allow({ error: errMsg(e) });
    }
  }

  // Phase 1.
  const fn = TOOLS[tool];
  if (!fn) {
    return cancel(`ssh-fleet does not provide tool '${tool}'`);
  }
  try {
    // Validate the reason before touching any host.
    const actor = actorFrom(payload, checkReason(args.reason, REASON_REQUIRED_TOOLS[tool] === true));
    return verdictFor(fn(args, actor));
  } catch (e) {
    // A handler error is a normal tool result (the agent sees the message),
    // not a plugin cancel.
    return allow({ error: errMsg(e) });
  }
}
