import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

export function looksWindowsAbsolute(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

export function assertNoReservedPathSegments(candidatePath, reportedPath = candidatePath) {
  const normalizedPath = normalizeRelativePath(candidatePath);

  if (!normalizedPath || normalizedPath === ".") {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  if (isAbsolute(normalizedPath) || looksWindowsAbsolute(normalizedPath)) {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  for (const segment of normalizedPath.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid declared runtime path: ${reportedPath}`);
    }
  }

  return normalizedPath;
}

export function assertSafeOutputPath(candidatePath, reportedPath = candidatePath) {
  const normalizedPath = normalizeRelativePath(candidatePath);

  if (!normalizedPath || normalizedPath === ".") {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  if (isAbsolute(normalizedPath) || looksWindowsAbsolute(normalizedPath)) {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  return normalizedPath;
}

export function assertPathWithinCategoryRoot(candidatePath, categoryRoot, reportedPath = candidatePath) {
  const normalizedPath = assertSafeOutputPath(candidatePath, reportedPath);
  const normalizedCategoryRoot = assertNoReservedPathSegments(categoryRoot, reportedPath);
  const categoryRelativePath = normalizeRelativePath(
    relative(normalizedCategoryRoot, normalizedPath),
  );

  if (
    normalizedPath !== normalizedCategoryRoot &&
    (categoryRelativePath.startsWith("../") || categoryRelativePath === "..")
  ) {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  return normalizedPath;
}

export function assertTopLevelMarkdownFile(candidatePath, categoryRoot, reportedPath = candidatePath) {
  const normalizedPath = assertPathWithinCategoryRoot(candidatePath, categoryRoot, reportedPath);
  const normalizedCategoryRoot = assertNoReservedPathSegments(categoryRoot, reportedPath);
  const categoryRelativePath = normalizeRelativePath(
    relative(normalizedCategoryRoot, normalizedPath),
  );

  if (
    !categoryRelativePath ||
    categoryRelativePath.includes("/") ||
    !categoryRelativePath.endsWith(".md")
  ) {
    throw new Error(`Invalid declared runtime path: ${reportedPath}`);
  }

  return normalizedPath;
}

export function listDeclaredFiles(runtimeManifest) {
  const declaredFiles = [];

  for (const [skillName, skillFiles] of Object.entries(runtimeManifest.skills ?? {})) {
    for (const skillFile of skillFiles) {
      const normalizedSkillName = normalizeRelativePath(skillName);
      const normalizedSkillFile = normalizeRelativePath(skillFile);
      const declaredPath = `skills/${normalizedSkillName}/${normalizedSkillFile}`;

      assertNoReservedPathSegments(normalizedSkillName, declaredPath);
      assertNoReservedPathSegments(normalizedSkillFile, declaredPath);
      assertSafeOutputPath(declaredPath);

      declaredFiles.push({
        declaredPath,
        validationRoot: `skills/${normalizedSkillName}`,
      });
    }
  }

  for (const agentFile of runtimeManifest.agents ?? []) {
    const declaredPath = assertTopLevelMarkdownFile(
      assertNoReservedPathSegments(normalizeRelativePath(agentFile)),
      "agents",
      agentFile,
    );

    declaredFiles.push({
      declaredPath,
      validationRoot: "agents",
    });
  }

  for (const pluginFile of runtimeManifest.plugin ?? []) {
    const declaredPath = assertPathWithinCategoryRoot(
      assertNoReservedPathSegments(normalizeRelativePath(pluginFile)),
      ".opencode/plugins",
      pluginFile,
    );

    declaredFiles.push({
      declaredPath,
      validationRoot: ".opencode/plugins",
    });
  }

  return declaredFiles;
}

export function listSourceSkillNames(sourceRoot) {
  // DEPRECATED: source-root mirroring removed. The repo bundle directory is
  // the source of truth. This export is retained as a no-op for any external
  // consumer (e.g. ad-hoc scripts) and can be deleted once no callers remain.
  void sourceRoot;
  return [];
}

export function listSourceAgentPaths(sourceRoot) {
  // DEPRECATED: see listSourceSkillNames.
  void sourceRoot;
  return [];
}

export function assertSourceParity(runtimeManifest, sourceRoot, arcsNativeSkillNames) {
  // DEPRECATED: source-root mirroring removed. The repo bundle directory is
  // the source of truth — there is no external mirror to assert parity with.
  // Retained as a no-op so any external caller continues to import cleanly.
  void runtimeManifest;
  void sourceRoot;
  void arcsNativeSkillNames;
}

export function validateDeclaredPath(relativePath, outputRoot, validationRoot) {
  const normalizedPath = assertSafeOutputPath(relativePath);
  const normalizedValidationRoot = assertSafeOutputPath(validationRoot, relativePath);

  const outputPath = resolve(outputRoot, normalizedPath);
  const outputRelativePath = normalizeRelativePath(relative(outputRoot, outputPath));

  if (outputRelativePath.startsWith("../") || outputRelativePath === "..") {
    throw new Error(`Invalid declared runtime path: ${relativePath}`);
  }

  const validationRelativePath = normalizeRelativePath(
    relative(normalizedValidationRoot, outputRelativePath),
  );

  if (validationRelativePath.startsWith("../") || validationRelativePath === "..") {
    throw new Error(`Invalid declared runtime path: ${relativePath}`);
  }

  return normalizedPath;
}

export function wireCodegraphMcp(target) {
  // Best-effort: wire the codegraph MCP server for this host. Non-fatal.
  // Skipped silently if the codegraph binary is absent, or when
  // ARCS_SKIP_CODEGRAPH=1 (set by the test suite so deploy-script runs never
  // mutate the developer's real host config).
  if (process.env.ARCS_SKIP_CODEGRAPH === "1") return false;
  try {
    const r = spawnSync("codegraph", ["install", `--target=${target}`, "--yes"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (r.error || r.status !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

export function wireRtk(target) {
  // Best-effort: wire RTK (token-optimized command proxy) for this host.
  // `rtk init -g` always covers Claude Code; `--opencode` additionally
  // installs the OpenCode plugin. Non-fatal. Skipped silently if the rtk
  // binary is absent, or when ARCS_SKIP_RTK=1 (set by the test suite so
  // deploy-script runs never mutate the developer's real host config).
  if (process.env.ARCS_SKIP_RTK === "1") return false;
  try {
    const args = ["init", "-g"];
    if (target === "opencode") args.push("--opencode");
    args.push("--auto-patch");
    const r = spawnSync("rtk", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (r.error || r.status !== 0) return false;
    return true;
  } catch {
    return false;
  }
}
