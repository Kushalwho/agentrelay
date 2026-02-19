import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Adapter for OpenAI Codex CLI sessions.
 * Reads JSONL files from ~/.codex/sessions/YYYY/MM/DD/
 */
export class CodexAdapter extends BaseAdapter {
  agentId: AgentId = "codex";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    // TODO: Glob for session JSONL files
    throw new Error("Not implemented");
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    // TODO: Parse Codex JSONL session file
    throw new Error("Not implemented");
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    // TODO: Find most recent session and capture it
    throw new Error("Not implemented");
  }
}
