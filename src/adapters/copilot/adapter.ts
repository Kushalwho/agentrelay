import fs from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

export class CopilotAdapter extends BaseAdapter {
  agentId: AgentId = "copilot";

  private get sessionsDir(): string {
    return path.join(os.homedir(), ".copilot", "session-state");
  }

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.sessionsDir)) {
      return false;
    }

    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    return entries.some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      return fs.existsSync(
        path.join(this.sessionsDir, entry.name, "workspace.yaml"),
      );
    });
  }

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const sessions: Array<SessionInfo & { sortValue: number }> = [];
    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionDir = path.join(this.sessionsDir, entry.name);
      const workspace = await this.readWorkspaceYaml(sessionDir);
      if (!workspace) {
        continue;
      }

      if (projectPath && workspace.workingDirectory) {
        if (!this.pathsEqual(projectPath, workspace.workingDirectory)) {
          continue;
        }
      } else if (projectPath && !workspace.workingDirectory) {
        continue;
      }

      const sessionId = workspace.sessionId || entry.name;
      const eventsPath = path.join(sessionDir, "events.jsonl");
      const messageCount = fs.existsSync(eventsPath)
        ? await this.countMessages(eventsPath)
        : 0;
      const startedAt = this.normalizeTimestamp(workspace.createdAt);
      const lastActiveAt =
        this.normalizeTimestamp(workspace.updatedAt) ??
        this.normalizeTimestampFromMs(fs.statSync(sessionDir).mtimeMs);

      const preview = this.trimPreview(workspace.summary);
      const sortValue = Date.parse(lastActiveAt ?? startedAt ?? "") || 0;

      sessions.push({
        id: sessionId,
        startedAt,
        lastActiveAt,
        messageCount,
        projectPath: workspace.workingDirectory,
        preview,
        sortValue,
      });
    }

    sessions.sort((a, b) => b.sortValue - a.sortValue);
    return sessions.map(({ sortValue, ...session }) => session);
  }

  async capture(sessionId: string): Promise<CapturedSession> {
    const sessionDir = await this.findSessionDir(sessionId);
    if (!sessionDir) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const workspace = await this.readWorkspaceYaml(sessionDir);
    if (!workspace) {
      throw new Error(`Missing workspace.yaml for session: ${sessionId}`);
    }

    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    const collector = new SummaryCollector();
    const extraDecisions: string[] = [];
    let totalTokens = 0;
    let sessionStartedAt: string | undefined;
    let lastAssistantMessage = "";

    const eventsPath = path.join(sessionDir, "events.jsonl");
    if (fs.existsSync(eventsPath)) {
      const rl = readline.createInterface({
        input: createReadStream(eventsPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let event: CopilotEvent;
        try {
          event = JSON.parse(trimmed) as CopilotEvent;
        } catch {
          continue;
        }

        const timestamp = this.normalizeTimestamp(event.timestamp);
        if (!sessionStartedAt && timestamp) {
          sessionStartedAt = timestamp;
        }

        totalTokens += this.extractEventTokenCount(event);

        if (event.type === "session.start") {
          const model = this.firstString(event.selectedModel, event.model);
          if (model) {
            extraDecisions.push(`Selected model: ${model}`);
          }
          continue;
        }

        if (event.type === "user.message") {
          const content = this.firstString(
            event.content,
            event.transformedContent,
          );
          if (!content) {
            continue;
          }
          messages.push({
            role: "user",
            content,
            timestamp,
          });
          continue;
        }

        if (event.type === "assistant.message") {
          const content = this.firstString(event.content);
          if (content) {
            messages.push({
              role: "assistant",
              content,
              timestamp,
            });
            lastAssistantMessage = content;
          }

          if (!Array.isArray(event.toolRequests)) {
            continue;
          }

          for (const request of event.toolRequests) {
            if (!request || typeof request !== "object") {
              continue;
            }
            const tool = request as Record<string, unknown>;
            const toolName =
              this.firstString(tool.name, tool.toolName, tool.id) || "Tool";
            const args = tool.args ?? tool.arguments ?? tool.input;
            messages.push({
              role: "tool",
              content: this.serializeUnknown(args ?? {}),
              toolName,
              timestamp,
            });

            collector.record(
              this.summaryName(toolName),
              this.summarySample(toolName, args),
            );

            const change = this.fileChangeFromTool(toolName, args);
            if (change) {
              fileChanges.set(change.path, change);
            }
          }
        }
      }
    }

    if (messages.length === 0 && workspace.summary) {
      messages.push({
        role: "assistant",
        content: workspace.summary,
        timestamp:
          this.normalizeTimestamp(workspace.updatedAt) ||
          this.normalizeTimestamp(workspace.createdAt),
      });
      lastAssistantMessage = workspace.summary;
    }

    const projectPath = workspace.workingDirectory || process.cwd();
    const projectContext = await extractProjectContext(projectPath);
    const analysis = analyzeConversation(messages);
    const decisions = this.unique([...(analysis.decisions || []), ...extraDecisions]);

    const session: CapturedSession = {
      version: "1.0",
      source: this.agentId,
      capturedAt: new Date().toISOString(),
      sessionId: workspace.sessionId || path.basename(sessionDir),
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
        remaining: [],
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
          ? `No Copilot sessions found for project: ${projectPath}`
          : "No Copilot sessions found",
      );
    }
    return this.capture(sessions[0].id);
  }

  private async findSessionDir(sessionId: string): Promise<string | null> {
    if (!fs.existsSync(this.sessionsDir)) {
      return null;
    }

    const direct = path.join(this.sessionsDir, sessionId);
    if (
      fs.existsSync(direct) &&
      fs.existsSync(path.join(direct, "workspace.yaml"))
    ) {
      return direct;
    }

    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sessionDir = path.join(this.sessionsDir, entry.name);
      const workspace = await this.readWorkspaceYaml(sessionDir);
      if (!workspace?.sessionId) {
        continue;
      }
      if (workspace.sessionId === sessionId) {
        return sessionDir;
      }
    }

    return null;
  }

  private async readWorkspaceYaml(
    sessionDir: string,
  ): Promise<CopilotWorkspace | null> {
    const workspacePath = path.join(sessionDir, "workspace.yaml");
    if (!fs.existsSync(workspacePath)) {
      return null;
    }

    const raw = fs.readFileSync(workspacePath, "utf-8");
    const parsed = await this.parseYaml(raw);
    if (!parsed) {
      return null;
    }

    return {
      sessionId: this.firstString(parsed.sessionId),
      repository: this.firstString(parsed.repository),
      branch: this.firstString(parsed.branch),
      workingDirectory: this.firstString(parsed.workingDirectory, parsed.cwd),
      summary: this.firstString(parsed.summary),
      createdAt: this.firstString(parsed.createdAt),
      updatedAt: this.firstString(parsed.updatedAt),
    };
  }

  private async parseYaml(input: string): Promise<Record<string, unknown> | null> {
    const yamlPackage = "yaml";
    try {
      const mod = (await import(yamlPackage)) as {
        parse?: (raw: string) => unknown;
        default?: { parse?: (raw: string) => unknown };
      };
      const parseFn = mod.parse ?? mod.default?.parse;
      if (parseFn) {
        const parsed = parseFn(input);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Fallback parser below.
    }
    return this.parseSimpleYaml(input);
  }

  private parseSimpleYaml(input: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = input.replace(/\r\n/g, "\n").split("\n");
    let blockKey: string | undefined;
    const blockLines: string[] = [];

    const flushBlock = () => {
      if (!blockKey) {
        return;
      }
      result[blockKey] = blockLines.join("\n").trimEnd();
      blockKey = undefined;
      blockLines.length = 0;
    };

    for (const line of lines) {
      if (blockKey) {
        if (/^\s+/.test(line)) {
          blockLines.push(line.replace(/^\s{2}/, ""));
          continue;
        }
        flushBlock();
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!match) {
        continue;
      }

      const key = match[1];
      const value = match[2];
      if (value === "|") {
        blockKey = key;
        continue;
      }

      result[key] = this.stripQuotes(value.trim());
    }

    flushBlock();
    return result;
  }

  private stripQuotes(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }

  private async countMessages(eventsPath: string): Promise<number> {
    let count = 0;
    const rl = readline.createInterface({
      input: createReadStream(eventsPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: CopilotEvent;
      try {
        event = JSON.parse(trimmed) as CopilotEvent;
      } catch {
        continue;
      }
      if (event.type === "user.message" || event.type === "assistant.message") {
        count++;
      }
    }

    return count;
  }

  private extractEventTokenCount(event: CopilotEvent): number {
    const usage =
      (event.usage && typeof event.usage === "object" ? event.usage : null) ||
      (event.tokenUsage && typeof event.tokenUsage === "object"
        ? event.tokenUsage
        : null);
    if (!usage) {
      return 0;
    }

    const input =
      this.toNumber(
        (usage as Record<string, unknown>).input_tokens ??
          (usage as Record<string, unknown>).inputTokens ??
          (usage as Record<string, unknown>).prompt_tokens,
      ) || 0;
    const output =
      this.toNumber(
        (usage as Record<string, unknown>).output_tokens ??
          (usage as Record<string, unknown>).outputTokens ??
          (usage as Record<string, unknown>).completion_tokens,
      ) || 0;
    return input + output;
  }

  private summaryName(toolName: string): string {
    const normalized = toolName.toLowerCase();
    if (
      normalized.includes("write") ||
      normalized.includes("edit") ||
      normalized.includes("patch")
    ) {
      return "Edit";
    }
    if (
      normalized.includes("read") ||
      normalized.includes("grep") ||
      normalized.includes("glob")
    ) {
      return "Read";
    }
    if (normalized.includes("bash") || normalized.includes("shell")) {
      return "Bash";
    }
    return "Tool";
  }

  private summarySample(toolName: string, args: unknown): string {
    if (!args || typeof args !== "object") {
      return toolName;
    }
    const input = args as Record<string, unknown>;
    const filePath = this.firstString(
      input.path,
      input.file_path,
      input.filePath,
      input.target,
    );
    const command = this.firstString(input.command);
    if (command) {
      return command;
    }
    if (filePath) {
      return `${toolName} ${filePath}`;
    }
    return toolName;
  }

  private fileChangeFromTool(
    toolNameRaw: string,
    input: unknown,
  ): FileChange | null {
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

    const name = toolNameRaw.toLowerCase();
    const changeType: FileChange["changeType"] =
      name.includes("create") || name.includes("write")
        ? "created"
        : name.includes("delete") || name.includes("remove")
          ? "deleted"
          : "modified";
    const diff = this.firstString(
      payload.content,
      payload.new_content,
      payload.patch,
      payload.diff,
      payload.command,
    );
    const ext = path.extname(filePath).slice(1);
    return {
      path: filePath,
      changeType,
      diff,
      language: ext || undefined,
    };
  }

  private normalizeTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) {
      return undefined;
    }
    return new Date(ts).toISOString();
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

  private trimPreview(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (!singleLine) {
      return undefined;
    }
    return singleLine.slice(0, 200);
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
    const output: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      output.push(trimmed);
    }
    return output;
  }
}

interface CopilotWorkspace {
  sessionId?: string;
  repository?: string;
  branch?: string;
  workingDirectory?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CopilotEvent {
  type?: string;
  timestamp?: string;
  content?: string;
  transformedContent?: string;
  selectedModel?: string;
  model?: string;
  usage?: unknown;
  tokenUsage?: unknown;
  toolRequests?: unknown[];
}
