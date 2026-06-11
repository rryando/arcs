/**
 * ARCS plugin for OpenCode.ai
 *
 * Injects ARCS bootstrap context via system prompt transform.
 * Drives loop continuation via CLI delegation (no direct file I/O on DAG).
 * Skills are discovered via OpenCode's native skill tool from symlinked directory.
 */

import path from "path";
import os from "os";
import { execFile } from "child_process";

// Normalize a path: trim whitespace, expand ~, resolve to absolute
const normalizePath = (p, homeDir) => {
  if (!p || typeof p !== "string") return null;
  let normalized = p.trim();
  if (!normalized) return null;
  if (normalized.startsWith("~/")) {
    normalized = path.join(homeDir, normalized.slice(2));
  } else if (normalized === "~") {
    normalized = homeDir;
  }
  return path.resolve(normalized);
};

// ---------------------------------------------------------------------------
// CLI delegation — single writer pattern (no direct DAG file I/O)
// ---------------------------------------------------------------------------

const arcsExec = (args) =>
  new Promise((resolve) => {
    execFile("arcs", args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const result = JSON.parse(stdout);
        return resolve(result?.ok ? result.data : null);
      } catch {
        return resolve(null);
      }
    });
  });

const loopStatus = () => arcsExec(["loop", "status", "--json"]);
const loopTick = (slug, session) =>
  arcsExec(["loop", "tick", slug, `--session=${session}`, "--json"]);
const loopCancel = (slug, session) =>
  arcsExec(["loop", "cancel", slug, `--session=${session}`, "--json"]);

// ---------------------------------------------------------------------------
// Continuation prompt builder
// ---------------------------------------------------------------------------

const buildContinuationPrompt = (state) => {
  const maxLabel =
    typeof state.maxIterations === "number" ? String(state.maxIterations) : "unbounded";

  if (state.strategy === "reset") {
    return `[SYSTEM DIRECTIVE - ARCS LOOP ITERATION ${state.iteration}/${maxLabel}]

Start fresh on the following task. Previous attempts did not complete successfully.

IMPORTANT:
- Do NOT rely on previous context or partial work
- Approach the task from scratch with a clean perspective
- When FULLY complete, output: <promise>${state.completionPromise}</promise>
- Do not stop until the task is truly done

Task:
${state.prompt}`;
  }

  return `[SYSTEM DIRECTIVE - ARCS LOOP ITERATION ${state.iteration}/${maxLabel}]

Your previous attempt did not output the completion promise. Continue working on the task.

IMPORTANT:
- Review your progress so far
- Continue from where you left off
- When FULLY complete, output: <promise>${state.completionPromise}</promise>
- Do not stop until the task is truly done

Original task:
${state.prompt}`;
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const ArcsPlugin = async ({ client, directory }) => {
  const inFlightSessions = new Set();
  const homeDir = os.homedir();
  const envConfigDir = normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir);
  const configDir = envConfigDir || path.join(homeDir, ".config/opencode");

  // Cache bootstrap content at plugin load (static for the session)
  const cachedBootstrap = (() => {
    const toolMapping = `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`todowrite\`
- \`Task\` tool with subagents → Use OpenCode's subagent system (@mention)
- \`Skill\` tool → OpenCode's native \`skill\` tool
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills location:**
ARCS skills are in \`${configDir}/skills/arcs/\`
Use OpenCode's native \`skill\` tool to list and load skills.`;

    return `<EXTREMELY_IMPORTANT>
You have ARCS skills loaded.

${toolMapping}
</EXTREMELY_IMPORTANT>`;
  })();

  // Cache T0 brief at plugin load — gives every session the operating context
  // without requiring agents to run `arcs brief` manually.
  // NOTE: Stale after long sessions (hours). Agents can call `arcs brief --lean --json`
  // for fresh data when needed. Stale T0 > no T0 for session start orientation.
  const cachedBrief = await (async () => {
    const data = await arcsExec(["brief", "--lean", "--json"]);
    if (!data) return null;
    return `<arcs_context>\n${JSON.stringify(data, null, 2)}\n</arcs_context>`;
  })();

  return {
    // Use system prompt transform to inject bootstrap (fixes #226 agent reset bug)
    "experimental.chat.system.transform": async (_input, output) => {
      if (cachedBootstrap) {
        (output.system ||= []).push(cachedBootstrap);
      }

      // Inject T0 operating context so agents start with current focus + next action
      if (cachedBrief) {
        (output.system ||= []).push(cachedBrief);
      }

      // Inject the workspace directory so ARCS and other agents always know
      // which project directory OpenCode was opened in. This is the reliable
      // source of truth — process.cwd() of MCP servers may differ.
      if (directory) {
        (output.system ||= []).push(`<env>\n  Working directory: ${directory}\n</env>`);
      }
    },

    event: async ({ event, client }) => {
      const props = event.properties;

      if (event.type === "session.idle") {
        const sessionID = props?.sessionID;
        if (!sessionID) return;
        if (inFlightSessions.has(sessionID)) return;

        inFlightSessions.add(sessionID);
        try {
          const status = await loopStatus();
          if (!status?.state?.active) return;

          const { state } = status;
          const slug = status.slug;

          // Only handle the loop's session
          if (state.sessionId && state.sessionId !== sessionID) return;

          // Detect completion in session messages
          let completionDetected = false;
          try {
            const response = await client.session.messages({
              path: { id: sessionID },
              query: { directory },
            });

            const messages = Array.isArray(response)
              ? response
              : response?.data && Array.isArray(response.data)
                ? response.data
                : [];

            const scopedMessages =
              typeof state.messageCountAtStart === "number"
                ? messages.slice(state.messageCountAtStart)
                : messages;

            const assistantMsgs = scopedMessages.filter((m) => m.info?.role === "assistant");
            const pattern = new RegExp(
              `<promise>\\s*${state.completionPromise.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</promise>`,
              "is",
            );

            for (let i = assistantMsgs.length - 1; i >= 0; i--) {
              const parts = assistantMsgs[i].parts || [];
              for (const part of parts) {
                if (part.type === "text" && part.text && pattern.test(part.text)) {
                  completionDetected = true;
                  break;
                }
              }
              if (completionDetected) break;
            }
          } catch {}

          if (completionDetected) {
            await loopCancel(slug, sessionID);
            await client.tui
              ?.showToast?.({
                body: {
                  title: "ARCS Loop Complete!",
                  message: `Task completed after ${state.iteration} iteration(s)`,
                  variant: "success",
                  duration: 5000,
                },
              })
              .catch(() => {});
            return;
          }

          // Tick — CLI handles max-iteration check and state mutation atomically
          const tickResult = await loopTick(slug, sessionID);
          if (!tickResult) return; // CLI unreachable or session mismatch

          if (tickResult.maxReached) {
            await client.tui
              ?.showToast?.({
                body: {
                  title: "ARCS Loop Stopped",
                  message: `Max iterations (${state.maxIterations}) reached without completion`,
                  variant: "warning",
                  duration: 5000,
                },
              })
              .catch(() => {});
            return;
          }

          const updatedState = tickResult.state;

          // Show toast
          await client.tui
            ?.showToast?.({
              body: {
                title: "ARCS Loop",
                message: `Iteration ${updatedState.iteration}/${typeof updatedState.maxIterations === "number" ? updatedState.maxIterations : "unbounded"}`,
                variant: "info",
                duration: 2000,
              },
            })
            .catch(() => {});

          // Inject continuation prompt
          const continuationPrompt = buildContinuationPrompt(updatedState);

          // Inherit agent/model from last message
          let agent, model, tools;
          try {
            const msgs = await client.session.messages({ path: { id: sessionID } });
            const messageList = Array.isArray(msgs) ? msgs : msgs?.data || [];
            for (let i = messageList.length - 1; i >= 0; i--) {
              const info = messageList[i]?.info;
              if (info?.agent || info?.model || (info?.modelID && info?.providerID)) {
                agent = info.agent;
                model =
                  info.model ??
                  (info.providerID && info.modelID
                    ? { providerID: info.providerID, modelID: info.modelID }
                    : undefined);
                tools = info.tools;
                break;
              }
            }
          } catch {}

          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              ...(agent !== undefined ? { agent } : {}),
              ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
              ...(model?.variant ? { variant: model.variant } : {}),
              ...(tools ? { tools } : {}),
              parts: [{ type: "text", text: continuationPrompt }],
            },
            query: { directory },
          });
        } finally {
          inFlightSessions.delete(sessionID);
        }
      }

      // Handle session deletion — clear loop if it's the loop session
      if (event.type === "session.deleted") {
        const sessionID = props?.sessionID;
        if (!sessionID) return;
        const status = await loopStatus();
        if (status?.state?.active && status.state.sessionId === sessionID) {
          await loopCancel(status.slug, sessionID);
        }
      }

      // Handle session error — clear loop
      if (event.type === "session.error") {
        const sessionID = props?.sessionID;
        if (!sessionID) return;
        const status = await loopStatus();
        if (status?.state?.active && status.state.sessionId === sessionID) {
          await loopCancel(status.slug, sessionID);
        }
      }
    },
  };
};
