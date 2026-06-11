import { execSync } from "node:child_process";

export interface RtkInfo {
  available: boolean;
  version?: string;
  path?: string;
}

export function detectRtk(): RtkInfo {
  try {
    const version = execSync("rtk --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    const resolvedPath = execSync("which rtk", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    // Extract semver from output (e.g. "rtk 0.9.9" or just "0.9.9")
    const match = version.match(/(\d+\.\d+\.\d+)/);

    return {
      available: true,
      version: match ? match[1] : version,
      path: resolvedPath || undefined,
    };
  } catch {
    return { available: false };
  }
}
