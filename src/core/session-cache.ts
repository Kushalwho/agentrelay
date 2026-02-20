import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentId, SessionInfo } from "../types/index.js";

const CACHE_DIR = join(homedir(), ".braindump");
const CACHE_FILE = join(CACHE_DIR, "sessions.jsonl");
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface CachedSessionEntry extends SessionInfo {
  agentId: AgentId;
}

/**
 * Get the cached session index. Returns null if stale or missing.
 */
export function getCachedIndex(): CachedSessionEntry[] | null {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const stat = statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > TTL_MS) {
      return null; // stale
    }

    const content = readFileSync(CACHE_FILE, "utf-8");
    const entries: CachedSessionEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as CachedSessionEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * Write the session index cache.
 */
export function writeCachedIndex(entries: CachedSessionEntry[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(CACHE_FILE, content);
}

/**
 * Invalidate (delete) the cache.
 */
export function invalidateCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
    }
  } catch {
    // ignore
  }
}
