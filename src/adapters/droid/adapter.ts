import fs from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

export class DroidAdapter extends BaseAdapter {
  agentId: AgentId = "droid";

  private get sessionsDir(): string {
    return path.join(os.homedir(), ".factory", "sessions");
  }

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.sessionsDir)) {
      return false;
    }
    const files = await glob("*/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
    });
    return files.length > 0;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const files = await glob("*/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });

    const sessions: Array<SessionInfo & { sortValue: number }> = [];
    for (const filePath of files) {
      const slug = path.basename(path.dirname(filePath));
      const baseName = path.basename(filePath, ".jsonl");
      let firstEvent: DroidEvent | undefined;
      let lastTimestamp: string | undefined;
      let preview: string | undefined;
      let messageCount = 0;
      let cwd: string | undefined;

      const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let event: DroidEvent;
        try {
          event = JSON.parse(trimmed) as DroidEvent;
        } catch {
          continue;
        }
        if (!firstEvent) {
          firstEvent = event;
        }

        const timestamp = this.normalizeTimestamp(event.timestamp);
        if (timestamp) {
          lastTimestamp = timestamp;
        }

        if (event.type === "session_start") {
          cwd = this.firstString(event.cwd);
          if (!preview) {
            preview = this.firstString(event.title);
          }
          continue;
        }

        if (event.type === "message" && event.message) {
          messageCount += 1;
          if (!preview) {
            preview = this.previewFromBlocks(event.message.content);
          }
        }
      }

      const inferredProjectPath = cwd || this.slugToPath(slug);
      if (projectPath && inferredProjectPath) {
        if (!this.pathsEqual(projectPath, inferredProjectPath)) {
          continue;
        }
      } else if (projectPath && !inferredProjectPath) {
        continue;
      }

      const startedAt = this.normalizeTimestamp(firstEvent?.timestamp);
      const lastActiveAt =
        lastTimestamp ?? this.normalizeTimestampFromMs(fs.statSync(filePath).mtimeMs);
      const sortValue = Date.parse(lastActiveAt ?? startedAt ?? "") || 0;

      sessions.push({
        id: `${slug}:${baseName}`,
        startedAt,
        lastActiveAt,
        messageCount,
        projectPath: inferredProjectPath,
        preview: preview?.slice(0, 200),
        sortValue,
      });
    }

    sessions.sort((a, b) => b.sortValue - a.sortValue);
    return sessions.map(({ sortValue, ...session }) => session);
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const located = await this.findSessionFile(sessionId);
    if (!located) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const { filePath, slug, baseName } = located;
    const settings = this.readSettingsFile(filePath);

    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    const collector = new SummaryCollector();
    const thoughtDecisions: string[] = [];
    const todo = {
      completed: [] as string[],
      remaining: [] as string[],
      inProgress: undefined as string | undefined,
    };

    let sessionStartedAt: string | undefined;
    let lastAssistantMessage = "";
    let cwd: string | undefined;
    let latestTimestamp: string | undefined;

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: DroidEvent;
      try {
        event = JSON.parse(trimmed) as DroidEvent;
      } catch {
        continue;
      }

      const eventTimestamp =
        this.normalizeTimestamp(event.timestamp) ||
        this.normalizeTimestamp(event.message?.timestamp);
      if (!sessionStartedAt && eventTimestamp) {
        sessionStartedAt = eventTimestamp;
      }
      if (eventTimestamp) {
        latestTimestamp = eventTimestamp;
      }

      if (event.type === "session_start") {
        cwd = this.firstString(event.cwd) || cwd;
        continue;
      }

      if (event.type === "todo_state" && typeof event.todos === "string") {
        this.parseTodoState(event.todos, todo);
        continue;
      }

      if (event.type === "compaction_state") {
        const summaryText = this.firstString(event.summaryText);
        if (summaryText) {
          thoughtDecisions.push(summaryText);
        }
        continue;
      }

      if (event.type !== "message" || !event.message) {
        continue;
      }

      const role = this.mapRole(event.message.role);
      const blocks = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      const textParts: string[] = [];

      for (const block of blocks) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const type = this.firstString(block.type) || "";

        if (type === "text") {
          const text = this.firstString(block.text, block.content);
          if (text) {
            textParts.push(text);
          }
          continue;
        }

        if (type === "thinking") {
          const thinking = this.firstString(block.thinking, block.text, block.content);
          if (thinking) {
            thoughtDecisions.push(thinking);
          }
          continue;
        }

        if (type === "tool_use") {
          const toolName = this.firstString(block.name) || "Tool";
          const input = block.input;
          messages.push({
            role: "tool",
            content: this.serializeUnknown(input ?? {}),
            toolName,
            timestamp: eventTimestamp,
          });
          collector.record(
            this.summaryName(toolName),
            this.summarySample(toolName, input),
          );

          const change = this.fileChangeFromTool(toolName, input);
          if (change) {
            fileChanges.set(change.path, change);
          }
          continue;
        }

        if (type === "tool_result") {
          const resultContent = this.serializeUnknown(block.content ?? block.result);
          messages.push({
            role: "tool",
            content: resultContent,
            timestamp: eventTimestamp,
          });
        }
      }

      const joined = textParts.join("\n").trim();
      if (joined) {
        messages.push({
          role,
          content: joined,
          timestamp: eventTimestamp,
        });
        if (role === "assistant") {
          lastAssistantMessage = joined;
        }
      }
    }

    const usage = settings?.tokenUsage;
    const totalTokens =
      (this.toNumber(usage?.inputTokens) || 0) +
      (this.toNumber(usage?.outputTokens) || 0) +
      (this.toNumber(usage?.cacheCreationTokens) || 0);

    const projectPath = cwd || this.slugToPath(slug) || process.cwd();
    const projectContext = await extractProjectContext(projectPath);
    const analysis = analyzeConversation(messages);
    const completed = this.unique([...analysis.completedSteps, ...todo.completed]);
    const remaining = this.unique([...todo.remaining]);
    const decisions = this.unique([...analysis.decisions, ...thoughtDecisions]);
    const inProgress =
      todo.inProgress ||
      (lastAssistantMessage ? lastAssistantMessage.slice(0, 200) : undefined);

    const session: CapturedSession = {
      version: "1.0",
      source: this.agentId,
      capturedAt: new Date().toISOString(),
      sessionId: `${slug}:${baseName}`,
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
        completed,
        remaining,
        inProgress,
        blockers: analysis.blockers,
      },
      toolActivity: collector.getSummaries(),
    };

    if (!session.sessionStartedAt && latestTimestamp) {
      session.sessionStartedAt = latestTimestamp;
    }

    return validateSession(session) as CapturedSession;
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    const sessions = await this.listSessions(projectPath);
    if (sessions.length === 0) {
      throw new Error(
        projectPath
          ? `No Droid sessions found for project: ${projectPath}`
          : "No Droid sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private async findSessionFile(
    sessionId: string,
  ): Promise<{ filePath: string; slug: string; baseName: string } | null> {
    if (!fs.existsSync(this.sessionsDir)) {
      return null;
    }

    const withSlug = sessionId.match(/^([^:]+):(.+)$/);
    if (withSlug) {
      const slug = withSlug[1];
      const baseName = withSlug[2];
      const filePath = path.join(this.sessionsDir, slug, `${baseName}.jsonl`);
      if (fs.existsSync(filePath)) {
        return { filePath, slug, baseName };
      }
    }

    const files = await glob("*/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });
    for (const filePath of files) {
      const slug = path.basename(path.dirname(filePath));
      const baseName = path.basename(filePath, ".jsonl");
      if (baseName === sessionId || `${slug}:${baseName}` === sessionId) {
        return { filePath, slug, baseName };
      }
    }
    return null;
  }

  private readSettingsFile(jsonlPath: string): DroidSettings | null {
    const settingsPath = jsonlPath.replace(/\.jsonl$/i, ".settings.json");
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as DroidSettings;
    } catch {
      return null;
    }
  }

  private mapRole(raw: unknown): ConversationMessage["role"] {
    const role = typeof raw === "string" ? raw.toLowerCase() : "";
    if (role === "user") {
      return "user";
    }
    if (role === "assistant") {
      return "assistant";
    }
    if (role === "system" || role === "tool") {
      return role;
    }
    return "assistant";
  }

  private previewFromBlocks(blocks: unknown): string | undefined {
    if (!Array.isArray(blocks)) {
      return undefined;
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const text = this.firstString(
        (block as Record<string, unknown>).text,
        (block as Record<string, unknown>).content,
      );
      if (text) {
        return text;
      }
    }
    return undefined;
  }

  private parseTodoState(
    rawTodos: string,
    todo: { completed: string[]; remaining: string[]; inProgress?: string },
  ): void {
    const lines = rawTodos.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*\d+\.\s*\[(.+?)\]\s*(.+)\s*$/i);
      if (!match) {
        continue;
      }
      const status = match[1].toLowerCase();
      const text = match[2].trim();
      if (!text) {
        continue;
      }
      if (status === "completed" || status === "done") {
        todo.completed.push(text);
        continue;
      }
      if (status === "in_progress" || status === "in-progress") {
        todo.inProgress = text;
        todo.remaining.push(text);
        continue;
      }
      todo.remaining.push(text);
    }
  }

  private summaryName(toolNameRaw: string): string {
    const toolName = toolNameRaw.toLowerCase();
    if (toolName === "bash" || toolName === "execute") {
      return "Bash";
    }
    if (
      toolName === "read" ||
      toolName === "ls" ||
      toolName === "glob" ||
      toolName === "grep"
    ) {
      return "Read";
    }
    if (toolName === "edit" || toolName === "create" || toolName === "applypatch") {
      return "Edit";
    }
    if (toolName.includes("___") || toolName.includes("-")) {
      return "MCP";
    }
    return "Tool";
  }

  private summarySample(toolName: string, input: unknown): string {
    if (!input || typeof input !== "object") {
      return toolName;
    }
    const payload = input as Record<string, unknown>;
    const command = this.firstString(payload.command);
    if (command) {
      return command;
    }
    const filePath = this.firstString(payload.path, payload.file_path, payload.filePath);
    if (filePath) {
      return `${toolName} ${filePath}`;
    }
    return toolName;
  }

  private fileChangeFromTool(toolNameRaw: string, input: unknown): FileChange | null {
    if (!input || typeof input !== "object") {
      return null;
    }
    const payload = input as Record<string, unknown>;
    const filePath = this.firstString(
      payload.path,
      payload.file_path,
      payload.filePath,
      payload.target,
    );
    if (!filePath) {
      return null;
    }
    const toolName = toolNameRaw.toLowerCase();
    const changeType: FileChange["changeType"] =
      toolName.includes("create")
        ? "created"
        : toolName.includes("delete") || toolName.includes("remove")
          ? "deleted"
          : "modified";
    const diff = this.firstString(
      payload.content,
      payload.new_content,
      payload.diff,
      payload.patch,
    );
    const ext = path.extname(filePath).slice(1);
    return {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    };
  }

  private slugToPath(slug: string): string {
    const normalized = slug.replace(/--+/g, "/");
    if (!normalized.includes("/") && slug.includes("-")) {
      return slug.replace(/-/g, "/");
    }
    return normalized;
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

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
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

interface DroidEvent {
  type?: string;
  timestamp?: string | number;
  id?: string;
  title?: string;
  cwd?: string;
  todos?: string;
  summaryText?: string;
  summaryTokens?: number;
  message?: {
    role?: string;
    timestamp?: string | number;
    content?: Array<Record<string, unknown>>;
  };
}

interface DroidSettings {
  model?: string;
  reasoningEffort?: string;
  autonomyMode?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
  };
}
