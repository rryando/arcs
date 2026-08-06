// ---------------------------------------------------------------------------
// web — Start the ARCS web UI (knowledge base visualizer and manager)
// ---------------------------------------------------------------------------

import pc from "picocolors";
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from "../../utils/hook-contract.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

const webParams = {
  port: {
    type: "number",
    // Shared with the hook contract: an installed hook posts to this port, so
    // the two defaults must move together or every hook silently misses.
    default: DEFAULT_WEB_PORT,
    description: `Port to listen on (default ${DEFAULT_WEB_PORT})`,
  },
  host: {
    type: "string",
    default: DEFAULT_WEB_HOST,
    description: `Interface to bind (default ${DEFAULT_WEB_HOST})`,
  },
  "no-open": {
    type: "boolean",
    default: false,
    description: "Do not auto-open the browser",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "web",
  description: "Start the ARCS web UI (knowledge base visualizer and manager)",
  params: webParams,
  handler: handleWeb,
});

async function handleWeb(
  params: ParsedParams<typeof webParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  try {
    const { startWebServer } = await import("../../web-server/index.js");
    const { getDataDir } = await import("../../utils/paths.js");

    const handle = await startWebServer({
      port: params.port,
      host: params.host,
      open: !params["no-open"],
    });

    const banner = [
      "",
      `  ${pc.green("▸")} ${pc.bold("ARCS web UI")} ${pc.dim("// kb visualizer + manager")}`,
      `  ${pc.dim("url:")}       ${pc.cyan(handle.url)}`,
      `  ${pc.dim("data:")}      ${getDataDir()}`,
      `  ${pc.dim("shortcuts:")} ${pc.green("/")} palette · ${pc.green("g")}+key goto · ${pc.green("j/k")} move · ${pc.green("?")} help`,
      `  ${pc.dim("Ctrl+C to stop")}`,
      "",
    ];
    // Banner on stderr keeps --json stdout clean.
    console.error(banner.join("\n"));

    // Checked against the address actually bound, not `params.port`: the two
    // differ whenever port 0 was requested. Runs after listen, so it can only
    // add output — it never delays or fails the server coming up.
    const { hookUrlMismatchWarning } = await import("./hooks.js");
    const mismatch = await hookUrlMismatchWarning({ host: handle.host, port: handle.port });
    if (mismatch) console.error(`${pc.yellow(mismatch)}\n`);

    return success({ url: handle.url, port: handle.port, host: handle.host });
  } catch (err) {
    return failure("web_start_error", err instanceof Error ? err.message : String(err));
  }
}
