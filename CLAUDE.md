# CLAUDE.md — Developer Guide for ARCS

This guide provides instructions and standards for developers working on the ARCS repository using Claude Code.

---

## Build, Test, Lint, and Format Commands

Use the following npm commands for building, validating, and checking code quality:

- **Build Code:** `npm run build` (compiles TypeScript to the `dist/` directory)
- **Build Opencode Bundle:** `npm run build:opencode-bundle` (compiles and packages the opencode skill tree bundle)
- **Typecheck:** `npm run typecheck` (runs `tsc --noEmit` to verify type safety)
- **Run Tests:** `npm run test` (runs Vitest in run mode for the entire test suite)
- **Lint Code:** `npm run lint` (uses Biome to check file formatting and code correctness across `src/` and `test/`)
- **Lint and Auto-Fix:** `npm run lint:fix` (runs Biome check with the `--fix` option to automatically correct issues)
- **Format Code:** `npm run format` (runs Biome formatter to rewrite files with correct formatting)

---

## Coding Discipline and Tech Stack

The ARCS codebase is a pure TypeScript CLI-only utility. There is no Model Context Protocol (MCP) server framework or preview server.

### Technical Parameters
- **Runtime:** Node.js version 18 or higher.
- **Language target:** TypeScript 5.8.3, targeted to ES2022, strict mode.
- **Core Dependencies:** `zod` for schema validation, `@clack/prompts` for interactive setups, and `picocolors` for terminal coloring.
- **Development Tooling:** Biome 2.4.8 for linting and formatting; Vitest 3.2.4 for running tests.

### Code and File Conventions
- **Indistinguishability:** Any new or modified code must match the existing codebase patterns, style, and structure perfectly.
- **File Naming:**
  - Use kebab-case for TypeScript files (e.g., `storage-utils.ts`, `plan-store.ts`, `toposort.ts`).
  - Use camelCase for variables, function names, properties, and parameters.
  - Skills must be placed in kebab-case directories (under `opencode/arcs/` or `skills/`) and must contain a main `SKILL.md` file.
  - Runtime and deployment scripts must use the `.mjs` extension (e.g., `arcs-cli.mjs`, `manage-diagram.mjs`, `lint-bundle.mjs`).

---

## ES Module and Import Style

The ARCS project is configured as a native Node.js ES module (`"type": "module"` in `package.json`).

- All local, relative imports within TypeScript files **must** include the explicit `.js` file extension.
  - **Correct:** `import { getProjectDir } from "../../utils/paths.js";`
  - **Incorrect:** `import { getProjectDir } from "../../utils/paths";`
- Use modern ES import and export syntax throughout. CommonJS modules (such as `require()` or `module.exports`) are not permitted.

---

## Testing Isolation Guidelines

The test suite contains extensive unit and integration tests located under the `test/` directory (matching `test/**/*.test.ts`).

### Avoiding State Contamination
Because ARCS writes local files, settings, and indices to the file system (defaulting to the `$ARCS_DATA` directory), running tests without proper isolation will corrupt or pollute local state and cause test failures.

- **Mandatory Rule:** All tests that read or write project DAG data (tasks, knowledge, plans, overview) must execute within isolated temporary data directories.
- **Usage of the Helper:** Use the `withTempDataDir()` helper exported from `test/helpers/temp-data-dir.js`. It generates a unique temporal directory, seeds the basic `meta.json` file, binds the environment variables to the isolated directory, and automatically cleans up after completion.

#### Example Implementation:
```typescript
import { describe, it, expect } from "vitest";
import { withTempDataDir } from "./helpers/temp-data-dir.js";
import { runCommand } from "./helpers/cli-runner.js";

describe("Example CLI Command Test", () => {
  it("executes the command in isolation", async () => {
    await withTempDataDir(async (tempDir) => {
      // Execute command or use storage utils within this isolated scope
      const result = await runCommand("brief", ["my-project", "--json"]);
      expect(result.ok).toBe(true);
    });
  });
});
```
