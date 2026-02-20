import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Stub adapter for OpenCode sessions.
 * Storage: ~/.local/share/opencode/opencode.db (SQLite) or ~/.local/share/opencode/storage/ (JSON fallback)
 */
export class OpenCodeAdapter extends BaseAdapter {
  agentId: AgentId = "opencode";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(_projectPath?: string): Promise<SessionInfo[]> {
    return [];
  }

  async capture(_sessionId: string): Promise<CapturedSession> {
    throw new Error("OpenCode adapter not yet implemented");
  }

  async captureLatest(_projectPath?: string): Promise<CapturedSession> {
    throw new Error("OpenCode adapter not yet implemented");
  }
}
