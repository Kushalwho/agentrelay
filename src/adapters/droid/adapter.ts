import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

/**
 * Stub adapter for Factory Droid sessions.
 * Storage: ~/.factory/sessions/<workspace-slug>/<uuid>.jsonl + <uuid>.settings.json
 */
export class DroidAdapter extends BaseAdapter {
  agentId: AgentId = "droid";

  async detect(): Promise<boolean> {
    return false;
  }

  async listSessions(_projectPath?: string): Promise<SessionInfo[]> {
    return [];
  }

  async capture(_sessionId: string): Promise<CapturedSession> {
    throw new Error("Droid adapter not yet implemented");
  }

  async captureLatest(_projectPath?: string): Promise<CapturedSession> {
    throw new Error("Droid adapter not yet implemented");
  }
}
