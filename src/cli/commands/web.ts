// ---------------------------------------------------------------------------
// web — Start the ARCS web UI (knowledge base visualizer and manager)
// ---------------------------------------------------------------------------

import pc from "picocolors";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

/** Loopback only: `arcs web` refuses to bind anything else. */
const DEFAULT_WEB_HOST = "127.0.0.1";

/** Default `arcs web` port. */
const DEFAULT_WEB_PORT = 4173;

const webParams = {
  port: {
    type: "number",
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

    return success({ url: handle.url, port: handle.port, host: handle.host });
  } catch (err) {
    return failure("web_start_error", err instanceof Error ? err.message : String(err));
  }
}
