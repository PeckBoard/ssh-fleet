// Hook + tool dispatch. Parses the `{ hook, payload }` envelope and routes each
// call to its handler. The wasm export functions live in `index.ts`.

import { skip, allow, cancel, errMsg } from "./verdict";
import { serveHttp, serveAuthed } from "./http";
import {
  sshHostAdd,
  sshHostUpdate,
  sshHostRemove,
  sshHostList,
  sshProbeTool,
  sshRun,
  sshRunMany,
  sshReadFileTool,
  sshWriteFileTool,
  sshEditFileTool,
} from "./tools";

const TOOLS: Record<string, (args: any) => any> = {
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

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    default:
      return skip();
  }
}

function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const args = payload.arguments ?? {};
  const fn = TOOLS[tool];
  if (!fn) {
    return cancel(`ssh-fleet does not provide tool '${tool}'`);
  }
  try {
    return allow(fn(args));
  } catch (e) {
    // A handler error is a normal tool result (the agent sees the message),
    // not a plugin cancel.
    return allow({ error: errMsg(e) });
  }
}
