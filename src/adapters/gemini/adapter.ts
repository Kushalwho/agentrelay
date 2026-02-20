import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Stub adapter for Gemini CLI sessions.
 * Storage: ~/.gemini/tmp/<project-hash>/chats/session-<timestamp>.json
 */
export class GeminiAdapter extends BaseAdapter {
  agentId: AgentId = "gemini";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(_projectPath?: string): Promise<SessionInfo[]> {
    return [];
  }

  async capture(_sessionId: string): Promise<CapturedSession> {
    throw new Error("Gemini adapter not yet implemented");
  }

  async captureLatest(_projectPath?: string): Promise<CapturedSession> {
    throw new Error("Gemini adapter not yet implemented");
  }
}
