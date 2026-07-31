/** Lock-safe, atomic filesystem mutations used by the web server. */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { type RootMeta, readRootMeta } from "../utils/dag.js";
import { withLock } from "../utils/file-lock.js";
import { writeTextAtomic } from "../utils/storage-utils.js";

export { writeTextAtomic } from "../utils/storage-utils.js";

/** Atomically replace a text file while holding its advisory lock. */
export async function writeTextLocked(filePath: string, content: string): Promise<void> {
  await withLock(filePath, () => writeTextAtomic(filePath, content));
}

/** Remove a file while holding the same advisory lock writers use. */
export async function removeFileLocked(filePath: string): Promise<void> {
  await withLock(filePath, () => unlink(filePath).catch(() => {}));
}

/**
 * Acquire several file locks in deterministic lexical order to avoid deadlock.
 */
export async function withFileLocks<T>(filePaths: string[], fn: () => T | Promise<T>): Promise<T> {
  const ordered = [...new Set(filePaths)].sort();

  const acquire = async (index: number): Promise<T> => {
    const filePath = ordered[index];
    if (filePath === undefined) return fn();
    return withLock(filePath, () => acquire(index + 1));
  };

  return acquire(0);
}

/**
 * Read-modify-write root meta.json while holding one lock for the whole
 * validation and mutation transaction.
 */
export async function mutateRootMetaLocked<T>(
  dataDir: string,
  mutate: (rootMeta: RootMeta) => T | Promise<T>,
): Promise<T> {
  const rootMetaPath = resolve(dataDir, "meta.json");
  return withLock(rootMetaPath, async () => {
    const rootMeta = await readRootMeta(dataDir);
    const result = await mutate(rootMeta);
    await writeTextAtomic(rootMetaPath, `${JSON.stringify(rootMeta, null, 2)}\n`);
    return result;
  });
}
