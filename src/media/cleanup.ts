import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Delete download folders older than `maxAgeMs` (left behind if the bot restarted mid-upload). */
export async function removeStaleMedia(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(root, name);
    try {
      if (now - (await stat(path)).mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Raced with another cleanup; ignore.
    }
  }
  return removed;
}

/** Delete files (not folders) older than `maxAgeMs` anywhere under `root`, e.g. the local Bot API server's downloads. */
export async function removeOldFiles(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    try {
      if (entry.isDirectory()) removed += await removeOldFiles(path, maxAgeMs, now);
      else if (entry.isFile() && now - (await stat(path)).mtimeMs > maxAgeMs) {
        await unlink(path);
        removed++;
      }
    } catch {
      // Gone already; ignore.
    }
  }
  return removed;
}
