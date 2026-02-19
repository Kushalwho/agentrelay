import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { BaseAdapter } from "../base-adapter.js";
import { analyzeConversation } from "../../core/conversation-analyzer.js";
import { extractProjectContext } from "../../core/project-context.js";
import { validateSession } from "../../core/validation.js";
import type {
  AgentId,
  CapturedSession,
  ConversationMessage,
  FileChange,
  SessionInfo,
} from "../../types/index.js";

/**
 * Adapter for Cursor sessions.
 * Reads SQLite databases from workspaceStorage/<hash>/state.vscdb
 */
export class CursorAdapter extends BaseAdapter {
  agentId: AgentId = "cursor";

  private _workspaceStorageDir: string | undefined;

  private get workspaceStorageDir(): string {
    if (this._workspaceStorageDir) {
      return this._workspaceStorageDir;
    }
    this._workspaceStorageDir = this.resolveWorkspaceStorageDir();
    return this._workspaceStorageDir;
  }

  private resolveWorkspaceStorageDir(): string {
    if (process.platform === "darwin") {
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "workspaceStorage",
      );
    }
    if (process.platform === "linux") {
      // Check native Linux path first
      const linuxPath = path.join(
        os.homedir(),
        ".config",
        "Cursor",
        "User",
        "workspaceStorage",
      );
      if (fs.existsSync(linuxPath)) {
        return linuxPath;
      }

      // Fall back to Windows path via WSL mount
      const wslPath = this.detectWslCursorPath();
      if (wslPath) {
        return wslPath;
      }

      return linuxPath;
    }

    const appData =
      process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "workspaceStorage");
  }

  /**
   * Detect Cursor's workspace storage via WSL's /mnt/c mount.
   * Returns the path if found, undefined otherwise.
   */
  private detectWslCursorPath(): string | undefined {
    try {
      // Check if running under WSL
      if (!fs.existsSync("/proc/version")) {
        return undefined;
      }
      const procVersion = fs.readFileSync("/proc/version", "utf-8");
      if (!/microsoft/i.test(procVersion)) {
        return undefined;
      }

      // Find Windows user directories under /mnt/c/Users
      const usersDir = "/mnt/c/Users";
      if (!fs.existsSync(usersDir)) {
        return undefined;
      }

      const userDirs = fs.readdirSync(usersDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !["Public", "Default", "Default User", "All Users"].includes(e.name));

      for (const userDir of userDirs) {
        const cursorPath = path.join(
          usersDir,
          userDir.name,
          "AppData",
          "Roaming",
          "Cursor",
          "User",
          "workspaceStorage",
        );
        if (fs.existsSync(cursorPath)) {
          return cursorPath;
        }
      }
    } catch {
      // WSL detection failed — not critical
    }
    return undefined;
  }

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.workspaceStorageDir)) {
      return false;
    }

    const entries = fs.readdirSync(this.workspaceStorageDir, {
      withFileTypes: true,
    });
    return entries.some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const dbPath = path.join(
        this.workspaceStorageDir,
        entry.name,
        "state.vscdb",
      );
      return fs.existsSync(dbPath);
    });
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.workspaceStorageDir)) {
      return [];
    }

    const sessions: SessionInfo[] = [];
    const workspaceEntries = fs
      .readdirSync(this.workspaceStorageDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    const candidates: WorkspaceCandidate[] = [];
    for (const workspaceEntry of workspaceEntries) {
      const workspaceHash = workspaceEntry.name;
      const workspaceDir = path.join(this.workspaceStorageDir, workspaceHash);
      const dbPath = path.join(workspaceDir, "state.vscdb");
      if (!fs.existsSync(dbPath)) {
        continue;
      }
      const resolvedProjectPath = this.readWorkspaceProjectPath(workspaceDir);
      const stat = fs.statSync(dbPath);
      candidates.push({
        workspaceHash,
        workspaceDir,
        dbPath,
        resolvedProjectPath,
        mtimeMs: stat.mtimeMs,
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    let selectedCandidates = candidates;
    if (projectPath) {
      const exactMatches = candidates.filter(
        (candidate) =>
          candidate.resolvedProjectPath &&
          this.pathsEqual(projectPath, candidate.resolvedProjectPath),
      );
      const hashMatches = candidates.filter((candidate) =>
        this.matchesWorkspaceHash(projectPath, candidate.workspaceHash),
      );

      if (exactMatches.length > 0) {
        selectedCandidates = exactMatches;
      } else if (hashMatches.length > 0) {
        selectedCandidates = hashMatches;
      } else {
        const fallback = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        selectedCandidates = fallback ? [fallback] : [];
      }
    }

    for (const candidate of selectedCandidates) {
      let db: Database.Database | null = null;
      try {
        db = this.openDatabase(candidate.dbPath);
        const composers = this.readComposers(db);
        for (const composer of composers) {
          sessions.push({
            id: `${candidate.workspaceHash}:${composer.id}`,
            startedAt: composer.startedAt,
            lastActiveAt: composer.lastActiveAt,
            messageCount: composer.messageCount,
            projectPath:
              candidate.resolvedProjectPath ??
              (projectPath && this.matchesWorkspaceHash(projectPath, candidate.workspaceHash)
                ? projectPath
                : undefined),
            preview: composer.preview,
          });
        }
      } catch {
        // Skip unreadable workspace DBs.
      } finally {
        db?.close();
      }
    }

    sessions.sort((a, b) => {
      const aTime = a.lastActiveAt || a.startedAt || "";
      const bTime = b.lastActiveAt || b.startedAt || "";
      return bTime.localeCompare(aTime);
    });

    return sessions;
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const separator = sessionId.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        `Invalid Cursor session ID: ${sessionId}. Expected <workspace-hash>:<composer-id>`,
      );
    }

    const workspaceHash = sessionId.slice(0, separator);
    const composerId = sessionId.slice(separator + 1);
    const workspaceDir = path.join(this.workspaceStorageDir, workspaceHash);
    const dbPath = path.join(workspaceDir, "state.vscdb");
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Cursor workspace DB not found: ${dbPath}`);
    }

    const projectPath = this.readWorkspaceProjectPath(workspaceDir) || process.cwd();
    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    let totalTokens = 0;
    let sessionStartedAt: string | undefined;
    let lastAssistantMessage = "";

    const db = this.openDatabase(dbPath);
    try {
      const bubbleRows = this.readBubbleRows(db, composerId);
      for (const row of bubbleRows) {
        const parsed = this.parseCursorPayload(row.value);
        if (parsed.message) {
          messages.push(parsed.message);
          if (!sessionStartedAt && parsed.message.timestamp) {
            sessionStartedAt = parsed.message.timestamp;
          }
          if (parsed.message.role === "assistant") {
            lastAssistantMessage = parsed.message.content;
          }
        }
        for (const toolMessage of parsed.toolMessages) {
          messages.push(toolMessage);
        }
        for (const change of parsed.fileChanges) {
          fileChanges.set(change.path, change);
        }
        totalTokens += parsed.tokenCount;
      }

      if (messages.length === 0) {
        const composerData = this.getJsonValue(db, `composerData:${composerId}`);
        const fallbackPayloads = this.extractMessagesFromComposerData(
          composerData,
          composerId,
        );
        for (const payload of fallbackPayloads) {
          const parsed = this.parseCursorPayload(payload);
          if (parsed.message) {
            messages.push(parsed.message);
            if (!sessionStartedAt && parsed.message.timestamp) {
              sessionStartedAt = parsed.message.timestamp;
            }
            if (parsed.message.role === "assistant") {
              lastAssistantMessage = parsed.message.content;
            }
          }
          for (const toolMessage of parsed.toolMessages) {
            messages.push(toolMessage);
          }
          for (const change of parsed.fileChanges) {
            fileChanges.set(change.path, change);
          }
          totalTokens += parsed.tokenCount;
        }
      }

      if (messages.length === 0) {
        const legacy = this.getJsonValue(
          db,
          "workbench.panel.aichat.view.aichat.chatdata",
        );
        const legacyPayloads = this.extractMessagesFromLegacy(legacy, composerId);
        for (const payload of legacyPayloads) {
          const parsed = this.parseCursorPayload(payload);
          if (parsed.message) {
            messages.push(parsed.message);
            if (!sessionStartedAt && parsed.message.timestamp) {
              sessionStartedAt = parsed.message.timestamp;
            }
            if (parsed.message.role === "assistant") {
              lastAssistantMessage = parsed.message.content;
            }
          }
          for (const toolMessage of parsed.toolMessages) {
            messages.push(toolMessage);
          }
          for (const change of parsed.fileChanges) {
            fileChanges.set(change.path, change);
          }
          totalTokens += parsed.tokenCount;
        }
      }
    } finally {
      db.close();
    }

    messages.sort((a, b) => {
      const aTime = a.timestamp || "";
      const bTime = b.timestamp || "";
      return aTime.localeCompare(bTime);
    });

    const projectContext = await extractProjectContext(projectPath);
    const analysis = analyzeConversation(messages);

    const session: CapturedSession = {
      version: "1.0",
      source: "cursor",
      capturedAt: new Date().toISOString(),
      sessionId,
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
      decisions: analysis.decisions,
      blockers: analysis.blockers,
      task: {
        description: analysis.taskDescription,
        completed: analysis.completedSteps,
        remaining: [],
        inProgress: lastAssistantMessage
          ? lastAssistantMessage.substring(0, 200)
          : undefined,
        blockers: analysis.blockers,
      },
    };
    return validateSession(session) as CapturedSession;
  }

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    const sessions = await this.listSessions(projectPath);
    if (sessions.length === 0) {
      throw new Error(
        projectPath
          ? `No Cursor sessions found for project: ${projectPath}`
          : "No Cursor sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private openDatabase(dbPath: string): Database.Database {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  private getAvailableTables(db: Database.Database): string[] {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ItemTable', 'cursorDiskKV')",
      )
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  private getValue(db: Database.Database, key: string): string | null {
    for (const table of this.getAvailableTables(db)) {
      const row = db
        .prepare(`SELECT value FROM ${table} WHERE key = ? LIMIT 1`)
        .get(key) as { value?: string } | undefined;
      if (row?.value != null) {
        return row.value;
      }
    }
    return null;
  }

  private getJsonValue(db: Database.Database, key: string): unknown {
    const raw = this.getValue(db, key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private readBubbleRows(
    db: Database.Database,
    composerId: string,
  ): Array<{ key: string; value: unknown }> {
    const rows: Array<{ key: string; value: unknown }> = [];
    for (const table of this.getAvailableTables(db)) {
      const results = db
        .prepare(`SELECT key, value FROM ${table} WHERE key LIKE ? ORDER BY key`)
        .all(`bubbleId:${composerId}:%`) as Array<{ key: string; value: string }>;
      for (const row of results) {
        try {
          rows.push({ key: row.key, value: JSON.parse(row.value) });
        } catch {
          // Skip malformed rows.
        }
      }
    }
    return rows;
  }

  private readComposers(db: Database.Database): CursorComposerSummary[] {
    const modern = this.getJsonValue(db, "composer.composerData");
    const modernComposers = this.normalizeComposerEntries(modern);
    if (modernComposers.length > 0) {
      return modernComposers;
    }

    const legacy = this.getJsonValue(
      db,
      "workbench.panel.aichat.view.aichat.chatdata",
    );
    return this.normalizeComposerEntries(legacy);
  }

  private normalizeComposerEntries(payload: unknown): CursorComposerSummary[] {
    const items = this.findComposerArray(payload);
    const composers: CursorComposerSummary[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const candidate = item as Record<string, unknown>;
      const id =
        (candidate.composerId as string | undefined) ||
        (candidate.id as string | undefined) ||
        (candidate.uuid as string | undefined);
      if (!id) {
        continue;
      }

      const preview =
        (candidate.preview as string | undefined) ||
        (candidate.title as string | undefined) ||
        (candidate.initialPrompt as string | undefined) ||
        (candidate.lastMessagePreview as string | undefined);

      composers.push({
        id,
        startedAt: this.normalizeTimestamp(
          candidate.createdAt ??
            candidate.startedAt ??
            candidate.firstMessageAt ??
            candidate.timestamp,
        ),
        lastActiveAt: this.normalizeTimestamp(
          candidate.lastUpdatedAt ??
            candidate.lastActiveAt ??
            candidate.updatedAt ??
            candidate.timestamp,
        ),
        messageCount: this.normalizeNumber(
          candidate.messageCount ??
            (Array.isArray(candidate.messages) ? candidate.messages.length : undefined),
        ),
        preview,
      });
    }
    return composers;
  }

  private findComposerArray(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.allComposers)) {
      return obj.allComposers;
    }
    if (Array.isArray(obj.composers)) {
      return obj.composers;
    }
    if (Array.isArray(obj.sessions)) {
      return obj.sessions;
    }
    if (Array.isArray(obj.chats)) {
      return obj.chats;
    }
    return [];
  }

  private extractMessagesFromComposerData(
    payload: unknown,
    composerId: string,
  ): unknown[] {
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return obj.messages;
    }
    if (Array.isArray(obj.bubbles)) {
      return obj.bubbles;
    }
    if (
      Array.isArray(obj.composers) ||
      Array.isArray(obj.allComposers) ||
      Array.isArray(obj.sessions)
    ) {
      const composers = this.findComposerArray(obj);
      for (const entry of composers) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const composer = entry as Record<string, unknown>;
        const id =
          (composer.composerId as string | undefined) ||
          (composer.id as string | undefined);
        if (id !== composerId) {
          continue;
        }
        if (Array.isArray(composer.messages)) {
          return composer.messages;
        }
        if (Array.isArray(composer.bubbles)) {
          return composer.bubbles;
        }
      }
    }
    return [];
  }

  private extractMessagesFromLegacy(payload: unknown, composerId: string): unknown[] {
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const obj = payload as Record<string, unknown>;
    const containers = this.findComposerArray(obj);
    for (const entry of containers) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const session = entry as Record<string, unknown>;
      const id =
        (session.composerId as string | undefined) ||
        (session.id as string | undefined);
      if (id && id !== composerId) {
        continue;
      }
      if (Array.isArray(session.messages)) {
        return session.messages;
      }
      if (Array.isArray(session.bubbles)) {
        return session.bubbles;
      }
    }
    return [];
  }

  private parseCursorPayload(payload: unknown): ParsedCursorPayload {
    if (!payload || typeof payload !== "object") {
      return { toolMessages: [], fileChanges: [], tokenCount: 0 };
    }

    const obj = payload as Record<string, unknown>;
    const timestamp = this.normalizeTimestamp(
      obj.timestamp ?? obj.createdAt ?? obj.time,
    );
    const tokenCount =
      this.normalizeNumber(
        obj.tokenCount ??
          (obj.usage && typeof obj.usage === "object"
            ? (obj.usage as Record<string, unknown>).total_tokens
            : undefined),
      ) || 0;

    const role = this.mapRole(
      (obj.role as string | undefined) ||
        (obj.type as string | undefined) ||
        (obj.sender as string | undefined),
    );
    const text = this.extractText(obj);

    const parsed: ParsedCursorPayload = {
      toolMessages: [],
      fileChanges: [],
      tokenCount,
    };

    if (text) {
      parsed.message = {
        role,
        content: text,
        timestamp,
        tokenCount: tokenCount || undefined,
      };
    }

    const nestedTool = obj.tool;
    const nestedToolName =
      nestedTool &&
      typeof nestedTool === "object" &&
      typeof (nestedTool as Record<string, unknown>).name === "string"
        ? ((nestedTool as Record<string, unknown>).name as string)
        : undefined;
    const toolName =
      (typeof obj.toolName === "string" ? obj.toolName : undefined) ||
      nestedToolName;
    if (toolName) {
      parsed.toolMessages.push({
        role: "tool",
        content: JSON.stringify(obj.input ?? obj.toolInput ?? {}),
        toolName,
        timestamp,
      });
      const toolFileChange = this.fileChangeFromPayload(toolName, obj);
      if (toolFileChange) {
        parsed.fileChanges.push(toolFileChange);
      }
    }

    if (Array.isArray(obj.toolCalls)) {
      for (const toolCall of obj.toolCalls) {
        if (!toolCall || typeof toolCall !== "object") {
          continue;
        }
        const call = toolCall as Record<string, unknown>;
        const callName = call.name as string | undefined;
        if (!callName) {
          continue;
        }
        parsed.toolMessages.push({
          role: "tool",
          content: JSON.stringify(call.input ?? {}),
          toolName: callName,
          timestamp,
        });
        const callPayload =
          call.input && typeof call.input === "object"
            ? (call.input as Record<string, unknown>)
            : call;
        const callChange = this.fileChangeFromPayload(callName, callPayload);
        if (callChange) {
          parsed.fileChanges.push(callChange);
        }
      }
    }

    const directChange = this.fileChangeFromPayload("edit_file", obj);
    if (directChange) {
      parsed.fileChanges.push(directChange);
    }

    return parsed;
  }

  private fileChangeFromPayload(
    toolNameRaw: string,
    payload: Record<string, unknown>,
  ): FileChange | null {
    const filePath =
      (payload.path as string | undefined) ||
      (payload.filePath as string | undefined) ||
      (payload.file_path as string | undefined);
    if (!filePath) {
      return null;
    }

    const toolName = toolNameRaw.toLowerCase();
    const changeType: FileChange["changeType"] =
      toolName.includes("write") || toolName.includes("create")
        ? "created"
        : toolName.includes("delete")
          ? "deleted"
          : "modified";

    const diff =
      (payload.content as string | undefined) ||
      (payload.diff as string | undefined) ||
      (payload.new_content as string | undefined);
    const ext = path.extname(filePath).slice(1);

    return {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    };
  }

  private extractText(payload: Record<string, unknown>): string {
    const directContent = payload.content;
    if (typeof directContent === "string") {
      return directContent.trim();
    }
    if (typeof payload.text === "string") {
      return payload.text.trim();
    }

    if (Array.isArray(directContent)) {
      const textParts: string[] = [];
      for (const item of directContent) {
        if (typeof item === "string") {
          textParts.push(item);
          continue;
        }
        if (!item || typeof item !== "object") {
          continue;
        }
        const block = item as Record<string, unknown>;
        if (typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      return textParts.join("\n").trim();
    }

    const nestedMessage = payload.message;
    if (nestedMessage && typeof nestedMessage === "object") {
      const nested = nestedMessage as Record<string, unknown>;
      if (typeof nested.content === "string") {
        return nested.content.trim();
      }
      if (Array.isArray(nested.content)) {
        const parts: string[] = [];
        for (const item of nested.content) {
          if (typeof item === "string") {
            parts.push(item);
            continue;
          }
          if (!item || typeof item !== "object") {
            continue;
          }
          const block = item as Record<string, unknown>;
          if (typeof block.text === "string") {
            parts.push(block.text);
          }
        }
        return parts.join("\n").trim();
      }
    }

    return "";
  }

  private mapRole(rawRole: string | undefined): ConversationMessage["role"] {
    const role = (rawRole || "").toLowerCase();
    if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
      return role;
    }
    if (role === "developer") {
      return "system";
    }
    if (role === "human") {
      return "user";
    }
    if (role === "ai") {
      return "assistant";
    }
    return "assistant";
  }

  private normalizeTimestamp(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return new Date(value).toISOString();
    }
    return undefined;
  }

  private normalizeNumber(value: unknown): number | undefined {
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

  private readWorkspaceProjectPath(workspaceDir: string): string | undefined {
    const workspaceJsonPath = path.join(workspaceDir, "workspace.json");
    if (!fs.existsSync(workspaceJsonPath)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(workspaceJsonPath, "utf-8"),
      ) as { folder?: string };
      if (!parsed.folder) {
        return undefined;
      }
      return this.fromFileUri(parsed.folder);
    } catch {
      return undefined;
    }
  }

  private fromFileUri(folder: string): string {
    if (!folder.startsWith("file://")) {
      return folder;
    }
    try {
      const url = new URL(folder);
      let pathname = decodeURIComponent(url.pathname);
      if (process.platform === "win32" && pathname.startsWith("/")) {
        pathname = pathname.slice(1);
      }
      if (process.platform === "win32") {
        pathname = pathname.replace(/\//g, "\\");
      }
      return pathname;
    } catch {
      return folder.replace(/^file:\/\//, "");
    }
  }

  private pathsEqual(a: string, b: string): boolean {
    const normalize = (value: string) =>
      path.resolve(value).replace(/[\\/]+/g, "/").toLowerCase();
    return normalize(a) === normalize(b);
  }

  private matchesWorkspaceHash(projectPath: string, workspaceHash: string): boolean {
    const normalizedPath = path.resolve(projectPath).replace(/\\/g, "/");
    const uriPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
    const fileUri = `file://${uriPath}`;
    const rawCandidates = [projectPath, normalizedPath, fileUri, encodeURI(fileUri)];

    const hashCandidates = new Set<string>();
    for (const value of rawCandidates) {
      hashCandidates.add(createHash("md5").update(value).digest("hex"));
      hashCandidates.add(createHash("sha1").update(value).digest("hex"));
      hashCandidates.add(createHash("sha256").update(value).digest("hex"));
    }
    return hashCandidates.has(workspaceHash.toLowerCase());
  }
}

interface CursorComposerSummary {
  id: string;
  startedAt?: string;
  lastActiveAt?: string;
  messageCount?: number;
  preview?: string;
}

interface ParsedCursorPayload {
  message?: ConversationMessage;
  toolMessages: ConversationMessage[];
  fileChanges: FileChange[];
  tokenCount: number;
}

interface WorkspaceCandidate {
  workspaceHash: string;
  workspaceDir: string;
  dbPath: string;
  resolvedProjectPath?: string;
  mtimeMs: number;
}
