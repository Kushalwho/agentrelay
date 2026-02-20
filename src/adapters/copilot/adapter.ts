import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Stub adapter for GitHub Copilot CLI sessions.
 * Storage: ~/.copilot/session-state/<session-id>/workspace.yaml + events.jsonl
 */
export class CopilotAdapter extends BaseAdapter {
  agentId: AgentId = "copilot";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(_projectPath?: string): Promise<SessionInfo[]> {
    return [];
  }

  async capture(_sessionId: string): Promise<CapturedSession> {
    throw new Error("Copilot adapter not yet implemented");
  }

  async captureLatest(_projectPath?: string): Promise<CapturedSession> {
    throw new Error("Copilot adapter not yet implemented");
  }
}
