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

const PROJECT_HASH = "-tmp-test-project";
const SESSION_ID = "test-session-001";

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
