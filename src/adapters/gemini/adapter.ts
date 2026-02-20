import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import { BaseAdapter } from "../base-adapter.js";
import { analyzeConversation } from "../../core/conversation-analyzer.js";
import { extractProjectContext } from "../../core/project-context.js";
import { SummaryCollector } from "../../core/tool-summarizer.js";
import { validateSession } from "../../core/validation.js";
import type {
  AgentId,
  CapturedSession,
  ConversationMessage,
  FileChange,
  SessionInfo,
} from "../../types/index.js";

export class GeminiAdapter extends BaseAdapter {
  agentId: AgentId = "gemini";

  private get sessionsDir(): string {
    return path.join(os.homedir(), ".gemini", "tmp");
  }

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.sessionsDir)) {
      return false;
    }
    const files = await glob("*/chats/session-*.json", {
      cwd: this.sessionsDir,
      nodir: true,
    });
    return files.length > 0;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const files = await glob("*/chats/session-*.json", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });

    const sessions: Array<SessionInfo & { sortValue: number }> = [];
    for (const filePath of files) {
      let payload: GeminiSessionFile;
      try {
        payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as GeminiSessionFile;
      } catch {
        continue;
      }

      const resolvedProjectPath = this.extractProjectPath(payload);
      if (projectPath && resolvedProjectPath) {
        if (!this.pathsEqual(projectPath, resolvedProjectPath)) {
          continue;
        }
      } else if (projectPath && !resolvedProjectPath) {
        continue;
      }

      const id = this.extractSessionId(payload, filePath);
      const startedAt = this.sessionStartedAt(payload);
      const lastActiveAt = this.sessionLastActiveAt(payload, filePath);
      const preview = this.preview(payload);
      const sortValue = Date.parse(lastActiveAt ?? startedAt ?? "") || 0;

      sessions.push({
        id,
        startedAt,
        lastActiveAt,
        messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
        projectPath: resolvedProjectPath,
        preview,
        sortValue,
      });
    }

    sessions.sort((a, b) => b.sortValue - a.sortValue);
    return sessions.map(({ sortValue, ...session }) => session);
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let payload: GeminiSessionFile;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as GeminiSessionFile;
    } catch {
      throw new Error(`Invalid Gemini session file: ${filePath}`);
    }

    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    const decisionsFromThoughts: string[] = [];
    const remainingFromThoughts: string[] = [];
    const collector = new SummaryCollector();
    let sessionStartedAt: string | undefined;
    let lastAssistantMessage = "";

    if (Array.isArray(payload.messages)) {
      for (const message of payload.messages) {
        if (!message || typeof message !== "object") {
          continue;
        }

        const role = this.mapRole(message.role);
        const timestamp = this.normalizeTimestamp(
          message.timestamp ?? message.createdAt ?? message.time,
        );
        if (!sessionStartedAt && timestamp) {
          sessionStartedAt = timestamp;
        }

        const text = this.extractMessageText(message.parts);
        if (text) {
          messages.push({
            role,
            content: text,
            timestamp,
          });
          if (role === "assistant") {
            lastAssistantMessage = text;
          }
        }

        if (Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) {
            if (!call || typeof call !== "object") {
              continue;
            }
            const toolName = this.firstString(call.name, call.toolName) || "Tool";
            const args = call.args ?? call.arguments ?? call.input;
            messages.push({
              role: "tool",
              content: this.serializeUnknown(args ?? {}),
              toolName,
              timestamp,
            });

            collector.record(
              this.summaryName(toolName),
              this.summarySample(toolName, args, call.resultDisplay),
            );

            const change = this.fileChangeFromToolCall(toolName, call);
            if (change) {
              fileChanges.set(change.path, change);
            }

            if (call.result != null) {
              messages.push({
                role: "tool",
                content: this.serializeUnknown(call.result),
                timestamp,
              });
            }
          }
        }

        if (Array.isArray(message.thoughts)) {
          for (const thought of message.thoughts) {
            const description =
              typeof thought === "string"
                ? this.firstString(thought)
                : this.firstString(thought?.description, thought?.subject);
            if (!description) {
              continue;
            }
            decisionsFromThoughts.push(description);
            if (/(todo|next|remaining|follow up)/i.test(description)) {
              remainingFromThoughts.push(description);
            }
          }
        }
      }
    }

    const usage = payload.tokenUsage || {};
    const totalTokens =
      (this.toNumber(usage.inputTokens ?? usage.input_tokens) || 0) +
      (this.toNumber(usage.outputTokens ?? usage.output_tokens) || 0);

    const projectPath = this.extractProjectPath(payload) || process.cwd();
    const projectContext = await extractProjectContext(projectPath);
    const analysis = analyzeConversation(messages);
    const decisions = this.unique([
      ...analysis.decisions,
      ...decisionsFromThoughts,
    ]);
    const remaining = this.unique(remainingFromThoughts);

    const session: CapturedSession = {
      version: "1.0",
      source: this.agentId,
      capturedAt: new Date().toISOString(),
      sessionId: this.extractSessionId(payload, filePath),
      sessionStartedAt,
      project: {
        ...projectContext,
        path: projectContext.path || projectPath,
        name: projectContext.name || path.basename(projectPath),
      },
      conversation: {
        messageCount: messages.length,
        estimatedTokens: totalTokens,
        messages,
      },
      filesChanged: Array.from(fileChanges.values()),
      decisions,
      blockers: analysis.blockers,
      task: {
        description: analysis.taskDescription,
        completed: analysis.completedSteps,
        remaining,
        inProgress: lastAssistantMessage
          ? lastAssistantMessage.slice(0, 200)
          : undefined,
        blockers: analysis.blockers,
      },
      toolActivity: collector.getSummaries(),
    };

    return validateSession(session) as CapturedSession;
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    const sessions = await this.listSessions(projectPath);
    if (sessions.length === 0) {
      throw new Error(
        projectPath
          ? `No Gemini sessions found for project: ${projectPath}`
          : "No Gemini sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    if (!fs.existsSync(this.sessionsDir)) {
      return null;
    }

    const files = await glob("*/chats/session-*.json", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });

    const direct = files.find((file) => path.basename(file, ".json") === sessionId);
    if (direct) {
      return direct;
    }

    for (const filePath of files) {
      try {
        const payload = JSON.parse(
          fs.readFileSync(filePath, "utf-8"),
        ) as GeminiSessionFile;
        if (this.extractSessionId(payload, filePath) === sessionId) {
          return filePath;
        }
      } catch {
        // Skip unreadable files.
      }
    }

    return null;
  }

  private extractSessionId(payload: GeminiSessionFile, filePath: string): string {
    const id = this.firstString(payload.sessionId, payload.id);
    if (id) {
      return id;
    }
    return path.basename(filePath, ".json");
  }

  private sessionStartedAt(payload: GeminiSessionFile): string | undefined {
    const direct = this.normalizeTimestamp(payload.createdAt);
    if (direct) {
      return direct;
    }
    if (!Array.isArray(payload.messages)) {
      return undefined;
    }
    for (const message of payload.messages) {
      const ts = this.normalizeTimestamp(
        message?.timestamp ?? message?.createdAt ?? message?.time,
      );
      if (ts) {
        return ts;
      }
    }
    return undefined;
  }

  private sessionLastActiveAt(
    payload: GeminiSessionFile,
    filePath: string,
  ): string | undefined {
    const direct = this.normalizeTimestamp(payload.updatedAt);
    if (direct) {
      return direct;
    }
    if (Array.isArray(payload.messages)) {
      for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
        const ts = this.normalizeTimestamp(
          payload.messages[i]?.timestamp ??
            payload.messages[i]?.createdAt ??
            payload.messages[i]?.time,
        );
        if (ts) {
          return ts;
        }
      }
    }
    return this.normalizeTimestampFromMs(fs.statSync(filePath).mtimeMs);
  }

  private preview(payload: GeminiSessionFile): string | undefined {
    if (!Array.isArray(payload.messages)) {
      return undefined;
    }
    for (const message of payload.messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const text = this.extractMessageText(message.parts);
      if (text) {
        return text.slice(0, 200);
      }
    }
    return undefined;
  }

  private extractProjectPath(payload: GeminiSessionFile): string | undefined {
    return this.firstString(
      payload.workingDirectory,
      payload.projectPath,
      payload.cwd,
    );
  }

  private mapRole(raw: unknown): ConversationMessage["role"] {
    const role = typeof raw === "string" ? raw.toLowerCase() : "";
    if (role === "user") {
      return "user";
    }
    if (role === "model" || role === "assistant") {
      return "assistant";
    }
    if (role === "system") {
      return "system";
    }
    if (role === "tool") {
      return "tool";
    }
    return "assistant";
  }

  private extractMessageText(parts: unknown): string {
    if (!Array.isArray(parts)) {
      return "";
    }
    const textParts: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        textParts.push(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        continue;
      }
      const block = part as Record<string, unknown>;
      const text = this.firstString(block.text, block.content);
      if (text) {
        textParts.push(text);
      }
    }
    return textParts.join("\n").trim();
  }

  private summaryName(toolNameRaw: string): string {
    const toolName = toolNameRaw.toLowerCase();
    if (toolName.includes("write") || toolName.includes("edit")) {
      return "Edit";
    }
    if (toolName.includes("read")) {
      return "Read";
    }
    if (toolName.includes("mcp")) {
      return "MCP";
    }
    if (toolName.includes("bash") || toolName.includes("shell")) {
      return "Bash";
    }
    return "Tool";
  }

  private summarySample(
    toolName: string,
    args: unknown,
    resultDisplay?: GeminiResultDisplay,
  ): string {
    const argObj =
      args && typeof args === "object" ? (args as Record<string, unknown>) : null;
    const filePath = this.firstString(
      resultDisplay?.filePath,
      resultDisplay?.fileName,
      argObj?.path,
      argObj?.file_path,
      argObj?.filePath,
    );
    if (filePath) {
      const added = this.toNumber(resultDisplay?.diffStat?.model_added_lines) || 0;
      const removed =
        this.toNumber(resultDisplay?.diffStat?.model_removed_lines) || 0;
      if (added || removed) {
        return `${toolName} ${filePath} (+${added} -${removed})`;
      }
      return `${toolName} ${filePath}`;
    }
    if (argObj?.command && typeof argObj.command === "string") {
      return argObj.command;
    }
    return toolName;
  }

  private fileChangeFromToolCall(
    toolNameRaw: string,
    call: GeminiToolCall,
  ): FileChange | null {
    const display = call.resultDisplay;
    const argObj =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : call.input && typeof call.input === "object"
            ? (call.input as Record<string, unknown>)
            : null;
    const filePath = this.firstString(
      display?.filePath,
      display?.fileName,
      argObj?.path,
      argObj?.file_path,
      argObj?.filePath,
    );
    if (!filePath) {
      return null;
    }

    const normalizedToolName = toolNameRaw.toLowerCase();
    const changeType: FileChange["changeType"] =
      display?.isNewFile || normalizedToolName.includes("create")
        ? "created"
        : normalizedToolName.includes("delete")
          ? "deleted"
          : "modified";

    const diffStat = display?.diffStat;
    const added = this.toNumber(diffStat?.model_added_lines) || 0;
    const removed = this.toNumber(diffStat?.model_removed_lines) || 0;
    const diff = added || removed ? `+${added} -${removed}` : undefined;
    const ext = path.extname(filePath).slice(1);

    return {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    };
  }

  private normalizeTimestamp(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const ts = Date.parse(value);
      if (!Number.isNaN(ts)) {
        return new Date(ts).toISOString();
      }
    }
    return undefined;
  }

  private normalizeTimestampFromMs(value: number): string | undefined {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return new Date(value).toISOString();
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private serializeUnknown(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private pathsEqual(a: string, b: string): boolean {
    const normalize = (value: string) =>
      path.resolve(value).replace(/[\\/]+/g, "/").toLowerCase();
    return normalize(a) === normalize(b);
  }

  private unique(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  }

}

interface GeminiSessionFile {
  sessionId?: string;
  id?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  workingDirectory?: string;
  projectPath?: string;
  cwd?: string;
  model?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  messages?: GeminiMessage[];
}

interface GeminiMessage {
  role?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  time?: string | number;
  parts?: unknown[];
  toolCalls?: GeminiToolCall[];
  thoughts?: Array<{ subject?: string; description?: string } | string>;
}

interface GeminiToolCall {
  name?: string;
  toolName?: string;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
  result?: unknown;
  resultDisplay?: GeminiResultDisplay;
}

interface GeminiResultDisplay {
  fileName?: string;
  filePath?: string;
  isNewFile?: boolean;
  diffStat?: {
    model_added_lines?: number | string;
    model_removed_lines?: number | string;
  };
}
