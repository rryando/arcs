// ---------------------------------------------------------------------------
// remember — zero-ceremony knowledge capture
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { getProjectDir } from "../../utils/paths.js";
import { createKnowledgeEntry, type KnowledgeKind } from "../../utils/project-memory.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

function classifyKind(text: string): KnowledgeKind {
  const lower = text.toLowerCase();
  if (/don't|never|careful|watch out|gotcha/.test(lower)) return "gotcha";
  if (/learned|lesson|realized|mistake/.test(lower)) return "lesson";
  if (/pattern|always|convention|rule/.test(lower)) return "pattern";
  if (/decided|decision|chose|picked/.test(lower)) return "decision";
  return "lesson";
}

function autoTitle(text: string): string {
  if (text.length <= 50) return text;
  return `${text.slice(0, 50)}...`;
}

const rememberParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  text: { type: "string", required: true, positional: 1, description: "The insight to remember" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "remember",
  description: "Capture a knowledge insight with zero ceremony",
  mutation: true,
  params: rememberParams,
  handler: handleRemember,
});

async function handleRemember(
  params: ParsedParams<typeof rememberParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const { slug, text } = params;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const title = autoTitle(text);
  const kind = classifyKind(text);
  const id = normalizeIdentifier(title);

  try {
    const entry = await createKnowledgeEntry(projectDir, {
      id,
      title,
      kind,
      keywords: [],
      summary: text,
    });
    if (flags.json) {
      return success({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        summary: text,
      });
    }
    return success(`✓ Remembered [${entry.kind}]: ${entry.title}`);
  } catch (err) {
    return failure("remember_error", err instanceof Error ? err.message : String(err));
  }
}
