import type {
  AgentAdapter,
  AgentId,
  DetectResult,
  SessionInfo,
} from "../types/index.js";
import { ClaudeCodeAdapter } from "./claude-code/adapter.js";
import { CursorAdapter } from "./cursor/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";

/**
 * Registry of all available adapters.
 */
const adapters: Record<AgentId, AgentAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  cursor: new CursorAdapter(),
  codex: new CodexAdapter(),
};

/**
 * Get an adapter by agent ID.
 */
export function getAdapter(agentId: AgentId): AgentAdapter {
  return adapters[agentId];
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}

/**
 * Detect which agents are installed on this machine.
 */
export async function detectAgents(): Promise<DetectResult[]> {
  const results: DetectResult[] = [];
  for (const adapter of Object.values(adapters)) {
    let detected = false;
    try {
      detected = await adapter.detect();
    } catch {
      detected = false;
    }
    const meta = await import("../core/registry.js").then(
      (m) => m.AGENT_REGISTRY[adapter.agentId]
    );
    const platform = process.platform as string;
    const storagePath = meta.storagePaths[platform] || "unknown";
    results.push({
      agentId: adapter.agentId,
      detected,
      path: storagePath,
    });
  }
  return results;
}

/**
 * Auto-detect the most recently active agent for the given project path.
 * Falls back to the first detected adapter when no session metadata is available.
 */
export async function autoDetectSource(projectPath?: string): Promise<AgentAdapter | null> {
  let firstDetected: AgentAdapter | null = null;
  let mostRecentAdapter: AgentAdapter | null = null;
  let mostRecentTs = Number.NEGATIVE_INFINITY;

  for (const adapter of Object.values(adapters)) {
    try {
      const detected = await adapter.detect();
      if (!detected) {
        continue;
      }

      if (!firstDetected) {
        firstDetected = adapter;
      }

      const sessions = await adapter.listSessions(projectPath);
      if (sessions.length === 0) {
        continue;
      }

      const latestTs = getSessionRecency(sessions[0]);
      if (!mostRecentAdapter || latestTs > mostRecentTs) {
        mostRecentAdapter = adapter;
        mostRecentTs = latestTs;
      }
    } catch {
      // skip this adapter
    }
  }

  return mostRecentAdapter ?? firstDetected;
}

function getSessionRecency(session: SessionInfo | undefined): number {
  if (!session) {
    return Number.NEGATIVE_INFINITY;
  }

  const lastActiveAt = toTimestamp(session.lastActiveAt);
  if (Number.isFinite(lastActiveAt)) {
    return lastActiveAt;
  }

  const startedAt = toTimestamp(session.startedAt);
  if (Number.isFinite(startedAt)) {
    return startedAt;
  }

  return Number.NEGATIVE_INFINITY;
}

function toTimestamp(value: string | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? Number.NaN : ts;
}
