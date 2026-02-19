import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Adapter for Cursor sessions.
 * Reads SQLite databases from workspaceStorage/<hash>/state.vscdb
 */
export class CursorAdapter extends BaseAdapter {
  agentId: AgentId = "cursor";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    // TODO: Scan workspace databases for composer sessions
    throw new Error("Not implemented");
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    // TODO: Read session from SQLite database
    throw new Error("Not implemented");
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    // TODO: Find most recent composer session and capture it
    throw new Error("Not implemented");
  }
}
