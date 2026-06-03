import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ZodType } from "zod";

/**
 * Strip single-line (//) and multi-line (/* *\/) comments from a JSON string,
 * preserving string literals intact. Enables reading JSONC files with standard
 * JSON.parse().
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          result += text[i] + (text[i + 1] ?? "");
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
    } else if (text[i] === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

/**
 * Async: read & parse a JSON/JSONC file. Returns undefined on missing/parse-error.
 */
export async function readJsonSafe<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(stripJsonComments(await readFile(filePath, "utf-8"))) as T;
  } catch {
    return undefined;
  }
}

/**
 * Sync: read & parse a JSON/JSONC file. Returns undefined on missing/parse-error.
 */
export function readJsonSafeSync<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8"))) as T;
  } catch {
    return undefined;
  }
}

/**
 * Validate a parsed value against a Zod schema.
 * Returns the typed value on success; throws with file path context on failure.
 */
export function validateJson<T>(data: unknown, schema: ZodType<T>, filePath: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid JSON in ${filePath}:\n${issues}`);
  }
  return result.data;
}
