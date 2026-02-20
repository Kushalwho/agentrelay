// === Portable Session Format ===

export interface CapturedSession {
  version: "1.0";
  source: AgentId;
  capturedAt: string;
  sessionId: string;
  sessionStartedAt?: string;

  project: ProjectContext;
  conversation: Conversation;
  filesChanged: FileChange[];
  decisions: string[];
  blockers: string[];
  task: TaskState;
  toolActivity?: ToolActivitySummary[];
}

export interface ToolActivitySummary {
  name: string;       // e.g. "Bash", "Edit", "Read"
  count: number;      // e.g. 47
  samples: string[];  // Up to 3 one-liner examples
}

export interface ProjectContext {
  path: string;
  name?: string;
  gitBranch?: string;
  gitStatus?: string;
  gitLog?: string[];
  structure?: string;
  memoryFileContents?: string;
}

export interface Conversation {
  messageCount: number;
  estimatedTokens: number;
  summary?: string;
  messages: ConversationMessage[];
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  timestamp?: string;
  tokenCount?: number;
}

export interface FileChange {
  path: string;
  changeType: "created" | "modified" | "deleted";
  diff?: string;
  language?: string;
}

export interface TaskState {
  description: string;
  completed: string[];
  remaining: string[];
  inProgress?: string;
  blockers: string[];
}

// === Agent Adapter Interface ===

export type AgentId = "claude-code" | "cursor" | "codex" | "copilot" | "gemini" | "opencode" | "droid";

export interface SessionInfo {
  id: string;
  startedAt?: string;
  lastActiveAt?: string;
  messageCount?: number;
  projectPath?: string;
  preview?: string;
}

export interface AgentAdapter {
  agentId: AgentId;
  detect(): Promise<boolean>;
  listSessions(projectPath?: string): Promise<SessionInfo[]>;
  capture(sessionId: string): Promise<CapturedSession>;
  captureLatest(projectPath?: string): Promise<CapturedSession>;
}

// === Compression ===

export interface CompressionOptions {
  targetTokens?: number;
  targetAgent?: AgentId | "clipboard" | "file";
}

export interface CompressionResult {
  content: string;
  totalTokens: number;
  includedLayers: string[];
  droppedLayers: string[];
}

export interface PriorityLayer {
  name: string;
  priority: number;
  content: string;
  tokens: number;
}

// === Provider ===

export interface ResumeProvider {
  deliver(content: string, options?: ProviderOptions): Promise<void>;
}

export interface ProviderOptions {
  projectPath?: string;
  targetAgent?: AgentId;
}

// === Watcher ===

export interface WatcherEvent {
  type: "session-update" | "new-session" | "rate-limit" | "idle";
  agentId: AgentId;
  sessionId?: string;
  timestamp: string;
  details?: string;
}

export interface WatcherOptions {
  agents?: AgentId[];
  interval?: number;
  projectPath?: string;
  onEvent?: (event: WatcherEvent) => void;
}

export interface WatcherState {
  timestamp: string;
  agents: AgentId[];
  activeSessions: Record<
    string,
    {
      messageCount: number;
      lastCheckedAt: string;
      lastChangedAt?: string;
    }
  >;
  running: boolean;
}

// === CLI ===

export interface HandoffOptions {
  source?: AgentId;
  target?: AgentId | "clipboard" | "file";
  session?: string;
  project?: string;
  tokens?: number;
}

export interface DetectResult {
  agentId: AgentId;
  detected: boolean;
  path: string;
  sessionCount?: number;
}

// === Agent Registry ===

export interface AgentMeta {
  id: AgentId;
  name: string;
  storagePaths: Record<string, string>;
  contextWindow: number;
  usableTokens: number;
  memoryFiles: string[];
}
