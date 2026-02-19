import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "claude-code-session.jsonl",
);
const RICH_FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "claude-code-session-rich.jsonl",
);

const PROJECT_HASH = "-tmp-test-project";
const SESSION_ID = "test-session-001";

function toClaudeProjectHash(projectPath: string): string {
  let normalized = projectPath;
  if (process.platform === "win32") {
    normalized = normalized.replace(/\\/g, "/");
    normalized = normalized.replace(/^([A-Za-z]):/, "$1-");
  }
  return normalized.replace(/\//g, "-");
}

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;
  let tmpHome: string;
  let projectsDir: string;
  let sessionDir: string;
  let sessionFile: string;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();

    // Create a unique temp directory to act as the fake home
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-test-"));
    projectsDir = path.join(tmpHome, ".claude", "projects");
    sessionDir = path.join(projectsDir, PROJECT_HASH);
    sessionFile = path.join(sessionDir, `${SESSION_ID}.jsonl`);

    // Create the directory structure
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy the fixture JSONL into the temp directory
    fs.copyFileSync(FIXTURE_PATH, sessionFile);

    // Mock os.homedir() to return our temp home
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // detect()
  // ---------------------------------------------------------------------------

  describe("detect", () => {
    it("should return true when projects dir exists with .jsonl files", async () => {
      const result = await adapter.detect();
      expect(result).toBe(true);
    });

    it("should return false when directory does not exist", async () => {
      // Point homedir to a non-existent path
      vi.spyOn(os, "homedir").mockReturnValue(
        path.join(os.tmpdir(), "non-existent-home-dir-" + Date.now()),
      );
      // Re-create adapter so it picks up the new homedir
      adapter = new ClaudeCodeAdapter();

      const result = await adapter.detect();
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // listSessions()
  // ---------------------------------------------------------------------------

  describe("listSessions", () => {
    it("should list sessions sorted by most recent", async () => {
      // Create a second session file with an older timestamp
      const secondSessionId = "test-session-002";
      const secondSessionFile = path.join(
        sessionDir,
        `${secondSessionId}.jsonl`,
      );

      // Write an older session (timestamps earlier than the fixture)
      const olderLines = [
        JSON.stringify({
          type: "human",
          message: {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          },
          timestamp: "2025-01-01T08:00:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi there!" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          timestamp: "2025-01-01T08:01:00Z",
        }),
      ];
      fs.writeFileSync(secondSessionFile, olderLines.join("\n") + "\n");

      const sessions = await adapter.listSessions();

      expect(sessions.length).toBe(2);
      // The fixture session (lastActiveAt 2025-02-19T10:35:00Z) should come first
      expect(sessions[0].id).toBe(SESSION_ID);
      expect(sessions[1].id).toBe(secondSessionId);
      // Verify ordering: first session's lastActiveAt > second session's lastActiveAt
      expect(sessions[0].lastActiveAt! > sessions[1].lastActiveAt!).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // capture()
  // ---------------------------------------------------------------------------

  describe("capture", () => {
    it("should parse JSONL and return a CapturedSession", async () => {
      const session = await adapter.capture(SESSION_ID);

      expect(session.version).toBe("1.0");
      expect(session.source).toBe("claude-code");
      expect(session.sessionId).toBe(SESSION_ID);

      // The fixture has 7 lines, 1 malformed, 6 valid.
      // Messages breakdown:
      //   Line 1: user text -> 1 message
      //   Line 2: assistant text + tool_use(Read) -> 2 messages
      //   Line 3: user text -> 1 message
      //   Line 4: SKIPPED (malformed)
      //   Line 5: assistant text + tool_use(Write) + tool_use(Write) -> 3 messages
      //   Line 6: user text -> 1 message
      //   Line 7: assistant text + tool_use(Bash) -> 2 messages
      // Total: 10 messages
      expect(session.conversation.messageCount).toBe(10);
      expect(session.conversation.messages.length).toBe(10);

      // Token count: (450+120) + (800+350) + (600+80) = 2400
      expect(session.conversation.estimatedTokens).toBe(2400);

      // Task description should be the first user message
      expect(session.task.description).toBe(
        "Set up an Express REST API with a /health endpoint",
      );

      // sessionStartedAt should be the timestamp of the first entry
      expect(session.sessionStartedAt).toBe("2025-02-19T10:30:00Z");
    });

    it("should extract file changes from tool_use blocks", async () => {
      const session = await adapter.capture(SESSION_ID);

      // The fixture has 2 Write tool_use blocks: src/index.ts and src/routes/users.ts
      expect(session.filesChanged.length).toBe(2);

      const filePaths = session.filesChanged.map((fc) => fc.path);
      expect(filePaths).toContain("src/index.ts");
      expect(filePaths).toContain("src/routes/users.ts");

      // Both should be "created" since they use the Write tool
      for (const fc of session.filesChanged) {
        expect(fc.changeType).toBe("created");
      }

      // Verify language detection from extension
      const indexChange = session.filesChanged.find(
        (fc) => fc.path === "src/index.ts",
      );
      expect(indexChange).toBeDefined();
      expect(indexChange!.language).toBe("ts");

      // Verify diff (content) is populated
      expect(indexChange!.diff).toContain("express");

      const usersChange = session.filesChanged.find(
        (fc) => fc.path === "src/routes/users.ts",
      );
      expect(usersChange).toBeDefined();
      expect(usersChange!.diff).toContain("Router");
    });

    it("should skip malformed JSONL lines", async () => {
      // The fixture contains a malformed line (line 4).
      // The adapter should not crash and should still return valid data.
      const session = await adapter.capture(SESSION_ID);

      // Should parse successfully without throwing
      expect(session).toBeDefined();
      expect(session.version).toBe("1.0");

      // Verify all valid messages are still captured (10 messages from 6 valid lines)
      expect(session.conversation.messages.length).toBe(10);
    });

    it("should handle very large session files (1000+ messages)", async () => {
      const largeSessionId = "test-session-large";
      const largeSessionFile = path.join(sessionDir, `${largeSessionId}.jsonl`);

      const lines: string[] = [];
      for (let i = 0; i < 1002; i++) {
        lines.push(
          JSON.stringify({
            type: i % 2 === 0 ? "human" : "assistant",
            message: {
              role: i % 2 === 0 ? "user" : "assistant",
              id: `msg-${i}`,
              content: [{ type: "text", text: `message-${i}` }],
              usage:
                i % 2 === 0
                  ? undefined
                  : { input_tokens: 2, output_tokens: 3 },
            },
            timestamp: new Date(2026, 1, 20, 10, 0, i).toISOString(),
          }),
        );
      }
      fs.writeFileSync(largeSessionFile, `${lines.join("\n")}\n`);

      const session = await adapter.capture(largeSessionId);
      expect(session.conversation.messages.length).toBe(1002);
      expect(session.conversation.messageCount).toBe(1002);
    });

    it("should skip duplicate messages", async () => {
      const duplicateSessionId = "test-session-duplicates";
      const duplicateSessionFile = path.join(
        sessionDir,
        `${duplicateSessionId}.jsonl`,
      );
      const lines = [
        JSON.stringify({
          type: "human",
          message: {
            id: "dup-1",
            role: "user",
            content: [{ type: "text", text: "Build endpoint" }],
          },
          timestamp: "2026-02-20T10:00:00Z",
        }),
        JSON.stringify({
          type: "human",
          message: {
            id: "dup-1",
            role: "user",
            content: [{ type: "text", text: "Build endpoint" }],
          },
          timestamp: "2026-02-20T10:00:01Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "dup-2",
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          timestamp: "2026-02-20T10:00:02Z",
        }),
      ];
      fs.writeFileSync(duplicateSessionFile, `${lines.join("\n")}\n`);

      const session = await adapter.capture(duplicateSessionId);
      expect(session.conversation.messages.length).toBe(2);
      expect(session.conversation.messages[0].content).toBe("Build endpoint");
      expect(session.conversation.messages[1].content).toBe("Done.");
    });

    it("should enrich project context from filesystem", async () => {
      const projectRoot = path.join(
        os.tmpdir(),
        "agentrelayctx",
        "workspace",
        "demoproject",
      );
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ name: "demo-project" }),
      );
      fs.writeFileSync(
        path.join(projectRoot, "CLAUDE.md"),
        "Project memory note: prefer migrations over sync.",
      );
      fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "src", "index.ts"), "export {};\n");

      const hash = toClaudeProjectHash(projectRoot);
      const contextSessionId = "test-session-context";
      const contextSessionDir = path.join(projectsDir, hash);
      fs.mkdirSync(contextSessionDir, { recursive: true });
      fs.copyFileSync(
        FIXTURE_PATH,
        path.join(contextSessionDir, `${contextSessionId}.jsonl`),
      );

      const session = await adapter.capture(contextSessionId);

      expect(session.project.path).toBe(projectRoot);
      expect(session.project.name).toBe("demo-project");
      expect(session.project.structure).toContain("package.json");
      expect(session.project.memoryFileContents).toContain("Project memory note");

      fs.rmSync(path.join(os.tmpdir(), "agentrelayctx"), {
        recursive: true,
        force: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // conversation analysis
  // ---------------------------------------------------------------------------

  describe("conversation analysis", () => {
    beforeEach(() => {
      fs.copyFileSync(RICH_FIXTURE_PATH, sessionFile);
    });

    it("should extract a meaningful task description", async () => {
      const session = await adapter.capture(SESSION_ID);
      expect(session.task.description).toContain(
        "Build a REST API with JWT auth",
      );
      expect(session.task.description.toLowerCase()).not.toContain("interrupted");
    });

    it("should find decisions from assistant messages", async () => {
      const session = await adapter.capture(SESSION_ID);

      expect(session.decisions.length).toBeGreaterThan(0);
      expect(
        session.decisions.some((decision) =>
          decision.includes("Express instead of Fastify"),
        ),
      ).toBe(true);
      expect(
        session.decisions.some((decision) =>
          decision.toLowerCase().includes("let's use zod"),
        ),
      ).toBe(true);
    });

    it("should detect errors and blockers", async () => {
      const session = await adapter.capture(SESSION_ID);

      expect(session.blockers.length).toBeGreaterThan(0);
      expect(
        session.blockers.some((blocker) => blocker.includes("ECONNREFUSED")),
      ).toBe(true);
      expect(
        session.blockers.some((blocker) =>
          blocker.includes("Permission denied"),
        ),
      ).toBe(true);
      expect(
        session.blockers.some((blocker) =>
          blocker.includes("Stack trace: Object.<anonymous>"),
        ),
      ).toBe(true);
    });

    it("should identify completed steps", async () => {
      const session = await adapter.capture(SESSION_ID);

      expect(session.task.completed.length).toBeGreaterThan(0);
      expect(
        session.task.completed.some((step) =>
          step.includes("Created the initial server bootstrap"),
        ),
      ).toBe(true);
      expect(
        session.task.completed.some((step) =>
          step.includes("Implemented integration tests"),
        ),
      ).toBe(true);
      expect(
        session.task.completed.some((step) =>
          step.includes("Fixed token expiration handling"),
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // captureLatest()
  // ---------------------------------------------------------------------------

  describe("captureLatest", () => {
    it("should capture the most recently modified session", async () => {
      const session = await adapter.captureLatest();

      // Should return a valid CapturedSession
      expect(session).toBeDefined();
      expect(session.version).toBe("1.0");
      expect(session.source).toBe("claude-code");
      expect(session.sessionId).toBe(SESSION_ID);
      expect(session.conversation.messages.length).toBeGreaterThan(0);
    });
  });
});
