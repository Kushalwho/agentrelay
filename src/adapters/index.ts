import type { AgentAdapter, AgentId, DetectResult } from "../types/index.js";
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
 * Returns the first adapter that is detected, or null if none found.
 */
export async function autoDetectSource(projectPath?: string): Promise<AgentAdapter | null> {
  for (const adapter of Object.values(adapters)) {
    try {
      const detected = await adapter.detect();
      if (detected) return adapter;
    } catch {
      // skip this adapter
    }
  }
  return null;
}
