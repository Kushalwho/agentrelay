import fs from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { glob } from "glob";
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
 * Adapter for OpenAI Codex CLI sessions.
 * Reads JSONL files from ~/.codex/sessions/YYYY/MM/DD/
 */
export class CodexAdapter extends BaseAdapter {
  agentId: AgentId = "codex";

  private get sessionsDir(): string {
    return path.join(os.homedir(), ".codex", "sessions");
  }

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.sessionsDir)) {
      return false;
    }
    const files = await glob("**/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: false,
    });
    return files.length > 0;
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const files = await glob("**/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });

    const sessions: Array<SessionInfo & { mtimeMs: number }> = [];

    for (const filePath of files) {
      try {
        const info = await this.readSessionInfo(filePath);
        if (!info) {
          continue;
        }
        if (projectPath && info.projectPath) {
          if (!this.pathsEqual(projectPath, info.projectPath)) {
            continue;
          }
        } else if (projectPath && !info.projectPath) {
          continue;
        }

        const stat = fs.statSync(filePath);
        sessions.push({ ...info, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip unreadable files.
      }
    }

    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.map(({ mtimeMs, ...session }) => session);
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    let totalTokens = 0;
    let sessionStartedAt: string | undefined;
    let lastAssistantMessage = "";
    let detectedProjectPath: string | undefined;

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let entry: CodexEntry;
      try {
        entry = JSON.parse(trimmed) as CodexEntry;
      } catch {
        continue;
      }

      if (!detectedProjectPath) {
        detectedProjectPath = this.extractProjectPath(entry);
      }

      const timestamp = this.entryTimestamp(entry);
      if (!sessionStartedAt && timestamp) {
        sessionStartedAt = timestamp;
      }

      totalTokens += this.extractUsageTokens(entry);

      const responseItem = this.responseItemPayload(entry);
      if (responseItem?.type === "function_call" && responseItem.name) {
        const input = this.parseFunctionCallInput(responseItem.arguments);
        messages.push({
          role: "tool",
          content: JSON.stringify(input ?? {}),
          toolName: responseItem.name,
          timestamp,
        });
        this.recordFileChange(fileChanges, responseItem.name, input);
      }

      if (responseItem?.type === "function_call_output") {
        const output =
          typeof responseItem.output === "string"
            ? responseItem.output
            : JSON.stringify(responseItem.output ?? "");
        messages.push({
          role: "tool",
          content: output,
          timestamp,
        });
      }

      const directRole = this.entryRole(entry);
      const directContent = this.entryContent(entry);
      if (directRole && directContent != null) {
        const parsed = this.parseContent(directContent, timestamp);
        if (parsed.text) {
          const role = this.mapRole(directRole);
          messages.push({
            role,
            content: parsed.text,
            timestamp,
            tokenCount: this.extractUsageTokens(entry) || undefined,
          });
          if (role === "assistant") {
            lastAssistantMessage = parsed.text;
          }
        }

        for (const tool of parsed.toolCalls) {
          messages.push({
            role: "tool",
            content: JSON.stringify(tool.input ?? {}),
            toolName: tool.name,
            timestamp,
          });
          this.recordFileChange(fileChanges, tool.name, tool.input);
        }

        for (const result of parsed.toolResults) {
          messages.push({
            role: "tool",
            content: result,
            timestamp,
          });
        }
      }

      if (entry.type === "tool_call" && entry.name) {
        const input = entry.input;
        messages.push({
          role: "tool",
          content: JSON.stringify(input ?? {}),
          toolName: entry.name,
          timestamp,
        });
        this.recordFileChange(fileChanges, entry.name, input);
      }

      if (entry.type === "tool_result") {
        const resultContent =
          typeof entry.output === "string"
            ? entry.output
            : typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.output ?? entry.content ?? "");
        messages.push({
          role: "tool",
          content: resultContent,
          timestamp,
        });
      }

      if (Array.isArray(entry.tool_calls)) {
        for (const call of entry.tool_calls) {
          if (!call?.name) {
            continue;
          }
          messages.push({
            role: "tool",
            content: JSON.stringify(call.input ?? {}),
            toolName: call.name,
            timestamp,
          });
          this.recordFileChange(fileChanges, call.name, call.input);
        }
      }
    }

    const canonicalId = path.basename(filePath, ".jsonl");
    const inferredProjectPath = detectedProjectPath || process.cwd();
    const projectContext = await extractProjectContext(inferredProjectPath);
    const analysis = analyzeConversation(messages);

    const session: CapturedSession = {
      version: "1.0",
      source: "codex",
      capturedAt: new Date().toISOString(),
      sessionId: canonicalId,
      sessionStartedAt,
      project: {
        ...projectContext,
        path: projectContext.path || inferredProjectPath,
        name: projectContext.name || path.basename(inferredProjectPath),
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
          ? `No Codex sessions found for project: ${projectPath}`
          : "No Codex sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private async readSessionInfo(filePath: string): Promise<SessionInfo | null> {
    const id = path.basename(filePath, ".jsonl");
    let firstEntry: CodexEntry | undefined;
    let lastEntry: CodexEntry | undefined;
    let lineCount = 0;
    let projectPath: string | undefined;

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let entry: CodexEntry;
      try {
        entry = JSON.parse(trimmed) as CodexEntry;
      } catch {
        continue;
      }
      lineCount++;
      if (!firstEntry) {
        firstEntry = entry;
      }
      lastEntry = entry;
      if (!projectPath) {
        projectPath = this.extractProjectPath(entry);
      }
    }

    if (!firstEntry || lineCount === 0) {
      return null;
    }

    const preview = this.extractPreview(firstEntry);
    return {
      id,
      startedAt: this.entryTimestamp(firstEntry),
      lastActiveAt: this.entryTimestamp(lastEntry),
      messageCount: lineCount,
      projectPath,
      preview,
    };
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    if (!fs.existsSync(this.sessionsDir)) {
      return null;
    }

    const files = await glob("**/*.jsonl", {
      cwd: this.sessionsDir,
      nodir: true,
      absolute: true,
    });
    if (files.length === 0) {
      return null;
    }

    const exact = files.find(
      (filePath) => path.basename(filePath, ".jsonl") === sessionId,
    );
    if (exact) {
      return exact;
    }

    const prefixed = files.find((filePath) =>
      path.basename(filePath, ".jsonl").includes(sessionId),
    );
    return prefixed ?? null;
  }

  private pathsEqual(a: string, b: string): boolean {
    const normalize = (value: string) =>
      path.resolve(value).replace(/[\\/]+/g, "/").toLowerCase();
    return normalize(a) === normalize(b);
  }

  private mapRole(role: string): ConversationMessage["role"] {
    const normalized = role.toLowerCase();
    if (normalized === "developer") {
      return "system";
    }
    if (
      normalized === "user" ||
      normalized === "assistant" ||
      normalized === "system" ||
      normalized === "tool"
    ) {
      return normalized;
    }
    return "assistant";
  }

  private entryRole(entry: CodexEntry): string | undefined {
    if (
      entry.payload &&
      typeof entry.payload.role === "string" &&
      entry.payload.role
    ) {
      return entry.payload.role;
    }
    if (
      entry.payload &&
      entry.payload.message &&
      typeof entry.payload.message.role === "string" &&
      entry.payload.message.role
    ) {
      return entry.payload.message.role;
    }
    if (entry.message && typeof entry.message.role === "string") {
      return entry.message.role;
    }
    if (typeof entry.role === "string") {
      return entry.role;
    }
    return undefined;
  }

  private entryContent(entry: CodexEntry): unknown {
    if (
      entry.payload &&
      "content" in entry.payload &&
      entry.payload.content != null
    ) {
      return entry.payload.content;
    }
    const payloadMessage = entry.payload?.message;
    if (
      payloadMessage &&
      typeof payloadMessage === "object" &&
      "content" in payloadMessage
    ) {
      return payloadMessage.content;
    }
    if (
      entry.message &&
      typeof entry.message === "object" &&
      "content" in entry.message
    ) {
      return entry.message.content;
    }
    return entry.content;
  }

  private entryTimestamp(entry: CodexEntry | undefined): string | undefined {
    if (!entry) {
      return undefined;
    }
    if (typeof entry.timestamp === "string") {
      return entry.timestamp;
    }
    if (
      entry.payload &&
      typeof entry.payload.timestamp === "string" &&
      entry.payload.timestamp
    ) {
      return entry.payload.timestamp;
    }
    if (
      entry.payload &&
      entry.payload.message &&
      typeof entry.payload.message.timestamp === "string" &&
      entry.payload.message.timestamp
    ) {
      return entry.payload.message.timestamp;
    }
    if (entry.message && typeof entry.message.timestamp === "string") {
      return entry.message.timestamp;
    }
    return undefined;
  }

  private extractUsageTokens(entry: CodexEntry): number {
    const usage =
      entry.payload?.message?.usage ??
      entry.payload?.usage ??
      entry.message?.usage ??
      entry.usage;
    if (!usage) {
      return 0;
    }
    return (
      (usage.input_tokens ?? usage.prompt_tokens ?? 0) +
      (usage.output_tokens ?? usage.completion_tokens ?? 0)
    );
  }

  private extractProjectPath(entry: CodexEntry): string | undefined {
    if (typeof entry.cwd === "string" && entry.cwd) {
      return entry.cwd;
    }
    if (
      entry.payload &&
      typeof entry.payload.cwd === "string" &&
      entry.payload.cwd
    ) {
      return entry.payload.cwd;
    }
    return undefined;
  }

  private parseContent(
    content: unknown,
    timestamp?: string,
  ): { text: string; toolCalls: ParsedToolCall[]; toolResults: string[] } {
    if (typeof content === "string") {
      return { text: content, toolCalls: [], toolResults: [] };
    }

    if (!Array.isArray(content)) {
      return { text: "", toolCalls: [], toolResults: [] };
    }

    const textParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];
    const toolResults: string[] = [];

    for (const item of content) {
      if (typeof item === "string") {
        textParts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") {
        continue;
      }

      const block = item as Record<string, unknown>;
      const type = typeof block.type === "string" ? block.type : "";

      if (
        (type === "text" || type === "output_text" || type === "input_text") &&
        (typeof block.text === "string" || typeof block.content === "string")
      ) {
        textParts.push(
          typeof block.text === "string" ? block.text : String(block.content),
        );
        continue;
      }

      if (type === "tool_call" || type === "tool_use") {
        const name =
          (typeof block.name === "string" && block.name) ||
          (typeof block.tool_name === "string" ? block.tool_name : undefined);
        if (name) {
          toolCalls.push({
            name,
            input: block.input ?? block.arguments,
            timestamp,
          });
        }
        continue;
      }

      if (type === "tool_result") {
        if (typeof block.output === "string") {
          toolResults.push(block.output);
        } else if (typeof block.content === "string") {
          toolResults.push(block.content);
        } else {
          toolResults.push(JSON.stringify(block.output ?? block.content ?? ""));
        }
      }
    }

    return {
      text: textParts.join("\n").trim(),
      toolCalls,
      toolResults,
    };
  }

  private responseItemPayload(
    entry: CodexEntry,
  ): CodexResponseItemPayload | undefined {
    if (
      entry.type !== "response_item" ||
      !entry.payload ||
      typeof entry.payload !== "object"
    ) {
      return undefined;
    }
    return entry.payload;
  }

  private parseFunctionCallInput(raw: unknown): unknown {
    if (typeof raw !== "string") {
      return raw;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return { raw: trimmed };
    }
  }

  private recordFileChange(
    fileChanges: Map<string, FileChange>,
    toolNameRaw: string,
    input: unknown,
  ): void {
    const toolName = toolNameRaw.toLowerCase();
    if (typeof input !== "object" || input === null) {
      return;
    }
    const payload = input as Record<string, unknown>;

    let filePath =
      (payload.path as string | undefined) ??
      (payload.file_path as string | undefined) ??
      (payload.filePath as string | undefined) ??
      (payload.target as string | undefined);

    if (!filePath && toolName === "shell") {
      const command = payload.command as string | undefined;
      if (command) {
        const redirectMatch = command.match(/>\s*([^\s]+)/);
        if (redirectMatch?.[1]) {
          filePath = redirectMatch[1];
        }
      }
    }

    if (!filePath) {
      return;
    }

    const changeType: FileChange["changeType"] =
      toolName.includes("write") || toolName.includes("create")
        ? "created"
        : toolName.includes("delete") || toolName.includes("remove")
          ? "deleted"
          : "modified";

    const diff =
      (payload.content as string | undefined) ??
      (payload.new_content as string | undefined) ??
      (payload.diff as string | undefined) ??
      (payload.patch as string | undefined) ??
      (payload.command as string | undefined);

    const ext = path.extname(filePath).slice(1);
    fileChanges.set(filePath, {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    });
  }

  private extractPreview(entry: CodexEntry): string | undefined {
    const content = this.entryContent(entry);
    if (typeof content === "string") {
      return content.slice(0, 200);
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") {
          return item.slice(0, 200);
        }
        if (!item || typeof item !== "object") {
          continue;
        }
        const block = item as Record<string, unknown>;
        if (typeof block.text === "string") {
          return block.text.slice(0, 200);
        }
      }
    }
    return undefined;
  }
}

interface ParsedToolCall {
  name: string;
  input: unknown;
  timestamp?: string;
}

interface CodexEntry {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  cwd?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    timestamp?: string;
    cwd?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    name?: string;
    arguments?: unknown;
    output?: unknown;
    message?: {
      role?: string;
      content?: unknown;
      timestamp?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  name?: string;
  input?: unknown;
  output?: unknown;
  tool_calls?: Array<{
    name?: string;
    input?: unknown;
  }>;
}

interface CodexResponseItemPayload {
  type?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
}
