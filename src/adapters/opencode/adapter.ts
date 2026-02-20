import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

export class OpenCodeAdapter extends BaseAdapter {
  agentId: AgentId = "opencode";

  private get rootDir(): string {
    if (process.platform === "win32") {
      const base =
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      return path.join(base, "opencode");
    }
    if (process.platform === "darwin") {
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "opencode",
      );
    }
    return path.join(os.homedir(), ".local", "share", "opencode");
  }

  private get sqlitePath(): string {
    return path.join(this.rootDir, "opencode.db");
  }

  private get storageDir(): string {
    return path.join(this.rootDir, "storage");
  }

  async detect(): Promise<boolean> {
    if (fs.existsSync(this.sqlitePath)) {
      return true;
    }
    if (!fs.existsSync(this.storageDir)) {
      return false;
    }
    const sessions = await glob("session/*/*.json", {
      cwd: this.storageDir,
      nodir: true,
    });
    return sessions.length > 0;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    const dbSessions = this.listSessionsFromDb(projectPath);
    if (dbSessions.length > 0) {
      return dbSessions;
    }
    return this.listSessionsFromJson(projectPath);
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const dbCapture = await this.captureFromDb(sessionId);
    if (dbCapture) {
      return dbCapture;
    }
    const jsonCapture = await this.captureFromJson(sessionId);
    if (jsonCapture) {
      return jsonCapture;
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    const sessions = await this.listSessions(projectPath);
    if (sessions.length === 0) {
      throw new Error(
        projectPath
          ? `No OpenCode sessions found for project: ${projectPath}`
          : "No OpenCode sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private listSessionsFromDb(projectPath?: string): SessionInfo[] {
    if (!fs.existsSync(this.sqlitePath)) {
      return [];
    }

    const db = this.openDatabase(this.sqlitePath);
    if (!db) {
      return [];
    }

    try {
      const rows = db
        .prepare(
          "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
        )
        .all() as Array<{
        id: string | number;
        title?: string;
        directory?: string;
        time_created?: string | number;
        time_updated?: string | number;
      }>;

      const sessions = rows
        .map((row) => {
          const resolvedProjectPath = this.firstString(row.directory);
          const startedAt = this.normalizeTimestamp(row.time_created);
          const lastActiveAt =
            this.normalizeTimestamp(row.time_updated) || startedAt;
          return {
            id: String(row.id),
            startedAt,
            lastActiveAt,
            projectPath: resolvedProjectPath,
            preview: this.firstString(row.title),
          } as SessionInfo;
        })
        .filter((session) => {
          if (!projectPath) {
            return true;
          }
          if (!session.projectPath) {
            return false;
          }
          return this.pathsEqual(projectPath, session.projectPath);
        });

      return sessions;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  private async listSessionsFromJson(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.storageDir)) {
      return [];
    }

    const files = await glob("session/*/*.json", {
      cwd: this.storageDir,
      nodir: true,
      absolute: true,
    });

    const sessions: Array<SessionInfo & { sortValue: number }> = [];
    for (const filePath of files) {
      let payload: OpenCodeSessionJson;
      try {
        payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as OpenCodeSessionJson;
      } catch {
        continue;
      }
      const id = this.firstString(payload.id, payload.sessionId, payload.slug);
      if (!id) {
        continue;
      }
      const resolvedProjectPath = this.firstString(payload.directory);
      if (projectPath && resolvedProjectPath) {
        if (!this.pathsEqual(projectPath, resolvedProjectPath)) {
          continue;
        }
      } else if (projectPath && !resolvedProjectPath) {
        continue;
      }

      const startedAt = this.normalizeTimestamp(payload.time_created);
      const lastActiveAt =
        this.normalizeTimestamp(payload.time_updated) ||
        this.normalizeTimestampFromMs(fs.statSync(filePath).mtimeMs) ||
        startedAt;
      const sortValue = Date.parse(lastActiveAt ?? startedAt ?? "") || 0;

      sessions.push({
        id,
        startedAt,
        lastActiveAt,
        projectPath: resolvedProjectPath,
        preview: this.firstString(payload.title),
        sortValue,
      });
    }

    sessions.sort((a, b) => b.sortValue - a.sortValue);
    return sessions.map(({ sortValue, ...session }) => session);
  }

  private async captureFromDb(sessionId: string): Promise<CapturedSession | null> {
    if (!fs.existsSync(this.sqlitePath)) {
      return null;
    }
    const db = this.openDatabase(this.sqlitePath);
    if (!db) {
      return null;
    }

    try {
      const sessionRow = db
        .prepare(
          "SELECT id, project_id, slug, directory, title, time_created, time_updated FROM session WHERE id = ? OR slug = ? LIMIT 1",
        )
        .get(sessionId, sessionId) as
        | {
            id: string | number;
            project_id?: string | number;
            slug?: string;
            directory?: string;
            title?: string;
            time_created?: string | number;
            time_updated?: string | number;
          }
        | undefined;

      if (!sessionRow) {
        return null;
      }

      let projectPath = this.firstString(sessionRow.directory);
      if (!projectPath && sessionRow.project_id != null) {
        const projectRow = db
          .prepare("SELECT worktree FROM project WHERE id = ? LIMIT 1")
          .get(sessionRow.project_id) as { worktree?: string } | undefined;
        projectPath = this.firstString(projectRow?.worktree);
      }

      const collector = new SummaryCollector();
      const fileChanges = new Map<string, FileChange>();
      const messages: ConversationMessage[] = [];
      let sessionStartedAt = this.normalizeTimestamp(sessionRow.time_created);
      let lastAssistantMessage = "";
      let totalTokens = 0;

      const messageRows = db
        .prepare(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created",
        )
        .all(sessionRow.id) as Array<{
        id: string | number;
        data?: string;
        time_created?: string | number;
      }>;

      for (const row of messageRows) {
        const messageData = this.parseJsonObject(row.data);
        const role = this.mapRole(messageData?.role);
        const messageTimestamp = this.normalizeTimestamp(row.time_created);
        if (!sessionStartedAt && messageTimestamp) {
          sessionStartedAt = messageTimestamp;
        }
        totalTokens += this.extractUsageTokens(messageData?.usage);

        const partRows = db
          .prepare(
            "SELECT data, time_created FROM part WHERE message_id = ? ORDER BY time_created",
          )
          .all(row.id) as Array<{ data?: string; time_created?: string | number }>;

        const textParts: string[] = [];
        for (const partRow of partRows) {
          const partData = this.parsePartPayload(partRow.data);
          if (!partData) {
            continue;
          }
          const partTimestamp =
            this.normalizeTimestamp(partRow.time_created) || messageTimestamp;

          if (partData.type === "text") {
            const text = this.firstString(partData.text, partData.content);
            if (text) {
              textParts.push(text);
            }
            continue;
          }

          if (partData.type === "tool-invocation") {
            const toolName = this.firstString(partData.toolName, partData.name) || "Tool";
            messages.push({
              role: "tool",
              content: this.serializeUnknown(partData.args ?? partData.input ?? {}),
              toolName,
              timestamp: partTimestamp,
            });

            collector.record(
              this.summaryName(toolName),
              this.summarySample(toolName, partData.args ?? partData.input),
            );

            const change = this.fileChangeFromTool(
              toolName,
              partData.args ?? partData.input,
              partData.result,
            );
            if (change) {
              fileChanges.set(change.path, change);
            }

            if (partData.result != null) {
              messages.push({
                role: "tool",
                content: this.serializeUnknown(partData.result),
                timestamp: partTimestamp,
              });
            }
          }
        }

        const text = textParts.join("\n").trim();
        if (text) {
          messages.push({
            role,
            content: text,
            timestamp: messageTimestamp,
          });
          if (role === "assistant") {
            lastAssistantMessage = text;
          }
        }
      }

      return this.buildCapturedSession({
        sessionId: String(sessionRow.id),
        messages,
        fileChanges,
        collector,
        totalTokens,
        sessionStartedAt,
        lastAssistantMessage,
        projectPath: projectPath || process.cwd(),
      });
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  private async captureFromJson(sessionId: string): Promise<CapturedSession | null> {
    if (!fs.existsSync(this.storageDir)) {
      return null;
    }

    const sessionFiles = await glob("session/*/*.json", {
      cwd: this.storageDir,
      nodir: true,
      absolute: true,
    });

    let sessionPayload: OpenCodeSessionJson | null = null;
    for (const filePath of sessionFiles) {
      let parsed: OpenCodeSessionJson;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as OpenCodeSessionJson;
      } catch {
        continue;
      }
      const id = this.firstString(parsed.id, parsed.sessionId, parsed.slug);
      if (id === sessionId) {
        sessionPayload = parsed;
        break;
      }
    }

    if (!sessionPayload) {
      return null;
    }

    const resolvedSessionId =
      this.firstString(sessionPayload.id, sessionPayload.sessionId, sessionPayload.slug) ||
      sessionId;
    const collector = new SummaryCollector();
    const fileChanges = new Map<string, FileChange>();
    const messages: ConversationMessage[] = [];

    const messageDir = path.join(this.storageDir, "message", resolvedSessionId);
    const messageFiles = fs.existsSync(messageDir)
      ? fs
          .readdirSync(messageDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => path.join(messageDir, name))
      : [];

    const parsedMessages = messageFiles
      .map((filePath) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, "utf-8")) as OpenCodeMessageJson;
        } catch {
          return null;
        }
      })
      .filter((value): value is OpenCodeMessageJson => value !== null)
      .sort((a, b) => {
        const aTs = Date.parse(String(a.time_created ?? "")) || 0;
        const bTs = Date.parse(String(b.time_created ?? "")) || 0;
        return aTs - bTs;
      });

    let sessionStartedAt: string | undefined;
    let totalTokens = 0;
    let lastAssistantMessage = "";

    for (const msg of parsedMessages) {
      const messageId = this.firstString(msg.id);
      const messageData = this.parseJsonObject(msg.data) ?? (msg as Record<string, unknown>);
      const role = this.mapRole(messageData.role);
      const messageTimestamp = this.normalizeTimestamp(msg.time_created);
      if (!sessionStartedAt && messageTimestamp) {
        sessionStartedAt = messageTimestamp;
      }
      totalTokens += this.extractUsageTokens(messageData.usage);

      const inlineParts = Array.isArray(msg.parts) ? msg.parts : [];
      const partPayloads: OpenCodePartData[] = [];
      for (const inlinePart of inlineParts) {
        const normalized = this.parsePartPayload(inlinePart);
        if (normalized) {
          partPayloads.push(normalized);
        }
      }

      if (messageId) {
        const partDir = path.join(this.storageDir, "part", messageId);
        if (fs.existsSync(partDir)) {
          const partFiles = fs
            .readdirSync(partDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(partDir, name))
            .sort();
          for (const partFile of partFiles) {
            try {
              const parsed = JSON.parse(
                fs.readFileSync(partFile, "utf-8"),
              ) as OpenCodePartJson;
              const normalized = this.parsePartPayload(parsed.data ?? parsed);
              if (normalized) {
                partPayloads.push(normalized);
              }
            } catch {
              // Skip malformed part files.
            }
          }
        }
      }

      const textParts: string[] = [];
      for (const part of partPayloads) {
        if (part.type === "text") {
          const text = this.firstString(part.text, part.content);
          if (text) {
            textParts.push(text);
          }
          continue;
        }
        if (part.type === "tool-invocation") {
          const toolName = this.firstString(part.toolName, part.name) || "Tool";
          messages.push({
            role: "tool",
            content: this.serializeUnknown(part.args ?? part.input ?? {}),
            toolName,
            timestamp: messageTimestamp,
          });
          collector.record(
            this.summaryName(toolName),
            this.summarySample(toolName, part.args ?? part.input),
          );
          const change = this.fileChangeFromTool(
            toolName,
            part.args ?? part.input,
            part.result,
          );
          if (change) {
            fileChanges.set(change.path, change);
          }
          if (part.result != null) {
            messages.push({
              role: "tool",
              content: this.serializeUnknown(part.result),
              timestamp: messageTimestamp,
            });
          }
        }
      }

      const text = textParts.join("\n").trim();
      if (text) {
        messages.push({
          role,
          content: text,
          timestamp: messageTimestamp,
        });
        if (role === "assistant") {
          lastAssistantMessage = text;
        }
      }
    }

    const projectPath =
      this.firstString(sessionPayload.directory) || process.cwd();

    return this.buildCapturedSession({
      sessionId: resolvedSessionId,
      messages,
      fileChanges,
      collector,
      totalTokens,
      sessionStartedAt,
      lastAssistantMessage,
      projectPath,
    });
  }

  private async buildCapturedSession(args: {
    sessionId: string;
    messages: ConversationMessage[];
    fileChanges: Map<string, FileChange>;
    collector: SummaryCollector;
    totalTokens: number;
    sessionStartedAt?: string;
    lastAssistantMessage?: string;
    projectPath: string;
  }): Promise<CapturedSession> {
    const projectContext = await extractProjectContext(args.projectPath);
    const analysis = analyzeConversation(args.messages);

    const session: CapturedSession = {
      version: "1.0",
      source: this.agentId,
      capturedAt: new Date().toISOString(),
      sessionId: args.sessionId,
      sessionStartedAt: args.sessionStartedAt,
      project: {
        ...projectContext,
        path: projectContext.path || args.projectPath,
        name: projectContext.name || path.basename(args.projectPath),
      },
      conversation: {
        messageCount: args.messages.length,
        estimatedTokens: args.totalTokens,
        messages: args.messages,
      },
      filesChanged: Array.from(args.fileChanges.values()),
      decisions: analysis.decisions,
      blockers: analysis.blockers,
      task: {
        description: analysis.taskDescription,
        completed: analysis.completedSteps,
        remaining: [],
        inProgress: args.lastAssistantMessage
          ? args.lastAssistantMessage.slice(0, 200)
          : undefined,
        blockers: analysis.blockers,
      },
      toolActivity: args.collector.getSummaries(),
    };

    return validateSession(session) as CapturedSession;
  }

  private openDatabase(dbPath: string): Database.Database | null {
    try {
      return new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
  }

  private parseJsonObject(value: unknown): Record<string, unknown> | null {
    if (!value) {
      return null;
    }
    if (typeof value === "object") {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  private parsePartPayload(value: unknown): OpenCodePartData | null {
    const parsed = this.parseJsonObject(value);
    if (!parsed) {
      return null;
    }
    const type = this.firstString(parsed.type);
    if (!type) {
      return null;
    }
    if (type === "text") {
      return {
        type: "text",
        text: this.firstString(parsed.text),
        content: this.firstString(parsed.content),
      };
    }
    if (type === "tool-invocation") {
      return {
        type: "tool-invocation",
        toolName: this.firstString(parsed.toolName),
        name: this.firstString(parsed.name),
        args: parsed.args,
        input: parsed.input,
        result: parsed.result,
      };
    }
    return null;
  }

  private mapRole(value: unknown): ConversationMessage["role"] {
    const role = typeof value === "string" ? value.toLowerCase() : "";
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

  private summaryName(toolNameRaw: string): string {
    const toolName = toolNameRaw.toLowerCase();
    if (
      toolName.includes("write") ||
      toolName.includes("edit") ||
      toolName.includes("patch")
    ) {
      return "Edit";
    }
    if (
      toolName.includes("read") ||
      toolName.includes("grep") ||
      toolName.includes("glob")
    ) {
      return "Read";
    }
    if (toolName.includes("bash") || toolName.includes("shell")) {
      return "Bash";
    }
    return "Tool";
  }

  private summarySample(toolName: string, args: unknown): string {
    if (!args || typeof args !== "object") {
      return toolName;
    }
    const payload = args as Record<string, unknown>;
    const command = this.firstString(payload.command);
    if (command) {
      return command;
    }
    const filePath = this.firstString(
      payload.path,
      payload.file_path,
      payload.filePath,
      payload.target,
    );
    if (filePath) {
      return `${toolName} ${filePath}`;
    }
    return toolName;
  }

  private fileChangeFromTool(
    toolNameRaw: string,
    args: unknown,
    result: unknown,
  ): FileChange | null {
    const payload =
      args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const resultPayload =
      result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const filePath = this.firstString(
      payload.path,
      payload.file_path,
      payload.filePath,
      resultPayload.filePath,
      resultPayload.file_path,
    );
    if (!filePath) {
      return null;
    }

    const toolName = toolNameRaw.toLowerCase();
    const changeType: FileChange["changeType"] =
      toolName.includes("create") || toolName.includes("write")
        ? "created"
        : toolName.includes("delete") || toolName.includes("remove")
          ? "deleted"
          : "modified";
    const diff = this.firstString(
      payload.content,
      payload.new_content,
      payload.diff,
      resultPayload.diff,
    );
    const ext = path.extname(filePath).slice(1);
    return {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    };
  }

  private extractUsageTokens(usage: unknown): number {
    if (!usage || typeof usage !== "object") {
      return 0;
    }
    const payload = usage as Record<string, unknown>;
    const input = this.toNumber(
      payload.input_tokens ?? payload.inputTokens ?? payload.prompt_tokens,
    );
    const output = this.toNumber(
      payload.output_tokens ??
        payload.outputTokens ??
        payload.completion_tokens ??
        payload.total_tokens,
    );
    return (input || 0) + (output || 0);
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

}

interface OpenCodeSessionJson {
  id?: string;
  sessionId?: string;
  slug?: string;
  project_id?: string;
  directory?: string;
  title?: string;
  time_created?: string | number;
  time_updated?: string | number;
}

interface OpenCodeMessageJson {
  id?: string;
  data?: unknown;
  role?: string;
  time_created?: string | number;
  parts?: unknown[];
}

interface OpenCodePartJson {
  data?: unknown;
}

interface OpenCodePartData {
  type: "text" | "tool-invocation";
  text?: string;
  content?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
}
