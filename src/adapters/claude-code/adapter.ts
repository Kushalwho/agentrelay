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
import { SummaryCollector, shellSummary, fileSummary } from "../../core/tool-summarizer.js";
import type {
  AgentId,
  CapturedSession,
  ConversationMessage,
  FileChange,
  SessionInfo,
} from "../../types/index.js";

/**
 * Adapter for Claude Code sessions.
 * Reads JSONL files from ~/.claude/projects/<path-hash>/<session-uuid>.jsonl
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  agentId: AgentId = "claude-code";

  /** Root directory where Claude Code stores project sessions. */
  private get projectsDir(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  // ---------------------------------------------------------------------------
  // detect
  // ---------------------------------------------------------------------------

  async detect(): Promise<boolean> {
    if (!fs.existsSync(this.projectsDir)) {
      return false;
    }

    const files = await glob("**/*.jsonl", {
      cwd: this.projectsDir,
      nodir: true,
      absolute: false,
    });

    return files.length > 0;
  }

  // ---------------------------------------------------------------------------
  // listSessions
  // ---------------------------------------------------------------------------

  async listSessions(projectPath?: string): Promise<SessionInfo[]> {
    if (!fs.existsSync(this.projectsDir)) {
      return [];
    }

    let pattern: string;
    if (projectPath) {
      const hash = this.pathToHash(projectPath);
      pattern = `${hash}/*.jsonl`;
    } else {
      pattern = "**/*.jsonl";
    }

    const files = await glob(pattern, {
      cwd: this.projectsDir,
      nodir: true,
      absolute: true,
    });

    const sessions: SessionInfo[] = [];

    for (const filePath of files) {
      try {
        const info = await this.readSessionInfo(filePath);
        if (info) {
          sessions.push(info);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by lastActiveAt descending (most recent first)
    sessions.sort((a, b) => {
      const aTime = a.lastActiveAt ?? "";
      const bTime = b.lastActiveAt ?? "";
      return bTime.localeCompare(aTime);
    });

    return sessions;
  }

  // ---------------------------------------------------------------------------
  // capture
  // ---------------------------------------------------------------------------

  async capture(sessionId: string): Promise<CapturedSession> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const lines = await this.readJsonlLines(filePath);

    const messages: ConversationMessage[] = [];
    const fileChanges = new Map<string, FileChange>();
    const seenMessageIds = new Set<string>();
    const collector = new SummaryCollector();
    let totalTokens = 0;
    let lastAssistantMessage = "";
    let sessionStartedAt: string | undefined;

    for (const line of lines) {
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line) as JsonlEntry;
      } catch {
        // Skip malformed lines
        continue;
      }

      if (!entry.message) {
        continue;
      }
      if (entry.message.id && seenMessageIds.has(entry.message.id)) {
        continue;
      }
      if (entry.message.id) {
        seenMessageIds.add(entry.message.id);
      }

      // Track session start time from the first entry's timestamp
      if (!sessionStartedAt && entry.timestamp) {
        sessionStartedAt = entry.timestamp;
      }

      const role = entry.message.role === "user" ? "user" as const : "assistant" as const;
      const contentBlocks: ContentBlock[] = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];

      // Accumulate token counts
      if (entry.message.usage) {
        totalTokens +=
          (entry.message.usage.input_tokens ?? 0) +
          (entry.message.usage.output_tokens ?? 0);
      }

      // Extract text content from this message
      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      const textContent = textParts.join("\n");

      // Track last assistant message for in-progress summary
      if (role === "assistant" && textContent) {
        lastAssistantMessage = textContent;
      }

      // Create conversation message for text content
      if (textContent) {
        messages.push({
          role,
          content: textContent,
          timestamp: entry.timestamp,
          tokenCount: entry.message.usage
            ? (entry.message.usage.input_tokens ?? 0) +
              (entry.message.usage.output_tokens ?? 0)
            : undefined,
        });
      }

      // Process tool_use blocks
      for (const block of contentBlocks) {
        if (block.type === "tool_use" && block.name) {
          // Add a tool message to the conversation
          messages.push({
            role: "tool",
            content: typeof block.input === "object"
              ? JSON.stringify(block.input)
              : String(block.input ?? ""),
            toolName: block.name,
            timestamp: entry.timestamp,
          });

          // Record tool activity
          const input = block.input && typeof block.input === "object"
            ? block.input as Record<string, unknown>
            : undefined;
          if (block.name === "Bash" || block.name === "bash") {
            collector.record("Bash", shellSummary(String(input?.command ?? "")));
          } else if (block.name === "Write" || block.name === "Edit") {
            const fp = (input?.file_path ?? input?.path) as string | undefined;
            if (fp) {
              collector.record(block.name, fileSummary(fp, block.name === "Write" ? "create" : "edit"));
            } else {
              collector.record(block.name, block.name.toLowerCase());
            }
          } else if (block.name === "Read") {
            const fp = (input?.file_path ?? input?.path) as string | undefined;
            collector.record("Read", fileSummary(fp ?? "file", "read"));
          } else if (block.name === "Grep" || block.name === "Glob" || block.name === "WebFetch" || block.name === "WebSearch" || block.name === "Task") {
            collector.record(block.name, block.name.toLowerCase());
          } else {
            collector.record(block.name, block.name.toLowerCase());
          }

          // Extract file changes from Write and Edit tool blocks
          if (
            (block.name === "Write" || block.name === "Edit") &&
            input
          ) {
            const filePth =
              (input.file_path as string | undefined) ??
              (input.path as string | undefined);
            if (filePth) {
              const ext = path.extname(filePth).slice(1);
              fileChanges.set(filePth, {
                path: filePth,
                changeType: block.name === "Write" ? "created" : "modified",
                diff: input.content as string | undefined,
                language: ext || undefined,
              });
            }
          }
        }

        // Also handle tool_result blocks
        if (block.type === "tool_result") {
          const resultContent =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          messages.push({
            role: "tool",
            content: resultContent,
            timestamp: entry.timestamp,
          });
        }
      }
    }

    // Infer project path from the directory structure
    const parentDir = path.basename(path.dirname(filePath));
    const inferredProjectPath = this.hashToPath(parentDir);
    const projectContext = await extractProjectContext(inferredProjectPath);
    const analysis = analyzeConversation(messages);

    const session: CapturedSession = {
      version: "1.0",
      source: "claude-code",
      capturedAt: new Date().toISOString(),
      sessionId,
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
      toolActivity: collector.getSummaries(),
    };

    return validateSession(session) as CapturedSession;
  }

  // ---------------------------------------------------------------------------
  // captureLatest
  // ---------------------------------------------------------------------------

  async captureLatest(projectPath?: string): Promise<CapturedSession> {
    const sessions = await this.listSessions(projectPath);
    if (sessions.length === 0) {
      throw new Error(
        projectPath
          ? `No Claude Code sessions found for project: ${projectPath}`
          : "No Claude Code sessions found",
      );
    }

    return this.capture(sessions[0].id);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert an absolute project path to the hash format Claude Code uses for
   * subdirectory names.  Slashes (and on Windows, backslashes and the drive
   * colon) are replaced with hyphens.
   *
   * Example (Linux):  /home/user/project  ->  -home-user-project
   * Example (Windows): C:\Users\kusha\proj -> C--Users-kusha-proj
   */
  private pathToHash(projectPath: string): string {
    let normalized = projectPath;

    if (process.platform === "win32") {
      // Replace backslashes with forward slashes first for uniform handling
      normalized = normalized.replace(/\\/g, "/");
      // Handle drive letter: C: -> C-
      normalized = normalized.replace(/^([A-Za-z]):/, "$1-");
    }

    // Replace all forward slashes with hyphens
    return normalized.replace(/\//g, "-");
  }

  /**
   * Reverse the hash back to a plausible absolute path.
   *
   * Example (Linux):  -home-user-project  ->  /home/user/project
   * Example (Windows): C--Users-kusha-proj -> C:\Users\kusha\proj
   */
  private hashToPath(hash: string): string {
    // Detect Windows-style hash: starts with a drive letter followed by a dash
    const windowsDriveMatch = hash.match(/^([A-Za-z])-(.*)$/);
    if (windowsDriveMatch) {
      const drive = windowsDriveMatch[1];
      const rest = windowsDriveMatch[2];
      // The rest has leading dash from root, replace dashes with backslash
      return `${drive}:${rest.replace(/-/g, "\\")}`;
    }

    // Unix-style: leading dash represents root /
    return hash.replace(/-/g, "/");
  }

  /**
   * Read basic session info from a .jsonl file without loading it all into memory.
   * Reads the first line for startedAt/preview and the last line for lastActiveAt,
   * and counts lines for messageCount.
   */
  private async readSessionInfo(filePath: string): Promise<SessionInfo | null> {
    const fileName = path.basename(filePath, ".jsonl");

    // Infer project path from parent directory name
    const parentDir = path.basename(path.dirname(filePath));
    const projectPath = this.hashToPath(parentDir);

    let firstLine: string | undefined;
    let lastLine: string | undefined;
    let lineCount = 0;

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;
      if (lineCount === 1) {
        firstLine = line;
      }
      lastLine = line;
    }

    if (lineCount === 0 || !firstLine) {
      return null;
    }

    let startedAt: string | undefined;
    let lastActiveAt: string | undefined;
    let preview: string | undefined;

    try {
      const firstEntry = JSON.parse(firstLine) as JsonlEntry;
      startedAt = firstEntry.timestamp;
      // Extract preview from first message text content
      if (firstEntry.message?.content) {
        const blocks: ContentBlock[] = Array.isArray(firstEntry.message.content)
          ? firstEntry.message.content
          : [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            preview = block.text.substring(0, 200);
            break;
          }
        }
      }
    } catch {
      // Malformed first line — still include the session with what we have
    }

    if (lastLine && lastLine !== firstLine) {
      try {
        const lastEntry = JSON.parse(lastLine) as JsonlEntry;
        lastActiveAt = lastEntry.timestamp;
      } catch {
        // Ignore malformed last line
      }
    } else {
      lastActiveAt = startedAt;
    }

    return {
      id: fileName,
      startedAt,
      lastActiveAt,
      messageCount: lineCount,
      projectPath,
      preview,
    };
  }

  /**
   * Locate the session file for a given session UUID by searching all
   * subdirectories under ~/.claude/projects/.
   */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    if (!fs.existsSync(this.projectsDir)) {
      return null;
    }

    const matches = await glob(`**/${sessionId}.jsonl`, {
      cwd: this.projectsDir,
      nodir: true,
      absolute: true,
    });

    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Stream-read a JSONL file and return all non-empty lines.
   */
  private async readJsonlLines(filePath: string): Promise<string[]> {
    const lines: string[] = [];

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }

    return lines;
  }
}

// ---------------------------------------------------------------------------
// Internal types for the raw JSONL structure
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface JsonlEntry {
  type?: "human" | "assistant";
  message?: {
    id?: string;
    role: "user" | "assistant";
    content: ContentBlock[] | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  timestamp?: string;
}
