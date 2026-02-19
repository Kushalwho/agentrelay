import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../../src/adapters/codex/adapter.js";

describe("CodexAdapter", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const FIXTURE_PATH = path.resolve(
    __dirname,
    "..",
    "fixtures",
    "codex-session.jsonl",
  );
  const RESPONSE_ITEM_FIXTURE_PATH = path.resolve(
    __dirname,
    "..",
    "fixtures",
    "codex-response-item-session.jsonl",
  );

  const SESSION_ID = "rollout-2026-02-20T09-00-00-main-session";

  let adapter: CodexAdapter;
  let tmpHome: string;
  let sessionsDir: string;
  let sessionFile: string;

  beforeEach(() => {
    adapter = new CodexAdapter();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-codex-"));
    sessionsDir = path.join(tmpHome, ".codex", "sessions", "2026", "02", "20");
    sessionFile = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.copyFileSync(FIXTURE_PATH, sessionFile);

    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("detect", () => {
    it("should return true when ~/.codex/sessions/ has JSONL files", async () => {
      const detected = await adapter.detect();
      expect(detected).toBe(true);
    });

    it("should return false when sessions directory does not exist", async () => {
      vi.spyOn(os, "homedir").mockReturnValue(
        path.join(os.tmpdir(), `missing-home-${Date.now()}`),
      );
      adapter = new CodexAdapter();
      const detected = await adapter.detect();
      expect(detected).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should list sessions sorted by most recent modified time", async () => {
      const olderId = "rollout-2026-02-19T08-00-00-old-session";
      const olderFile = path.join(
        tmpHome,
        ".codex",
        "sessions",
        "2026",
        "02",
        "19",
        `${olderId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(olderFile), { recursive: true });
      fs.writeFileSync(
        olderFile,
        JSON.stringify({
          role: "user",
          content: "Older session",
          timestamp: "2026-02-19T08:00:00Z",
          cwd: "/tmp/old-codex",
        }) + "\n",
      );
      fs.utimesSync(olderFile, new Date("2026-02-19T08:00:00Z"), new Date("2026-02-19T08:00:00Z"));
      fs.utimesSync(sessionFile, new Date("2026-02-20T09:08:00Z"), new Date("2026-02-20T09:08:00Z"));

      const sessions = await adapter.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions[0].id).toBe(SESSION_ID);
      expect(sessions[1].id).toBe(olderId);
    });

    it("should match project path from session_meta payload cwd", async () => {
      const metaSessionId = "rollout-2026-02-21T10-00-00-meta-only";
      const metaProjectPath = path.join(tmpHome, "meta-project");
      const metaFile = path.join(sessionsDir, `${metaSessionId}.jsonl`);
      fs.mkdirSync(metaProjectPath, { recursive: true });

      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-02-21T10:00:00Z",
          payload: {
            cwd: metaProjectPath,
          },
        }),
        JSON.stringify({
          role: "user",
          content: "Use metadata cwd only",
          timestamp: "2026-02-21T10:00:10Z",
        }),
      ];
      fs.writeFileSync(metaFile, `${lines.join("\n")}\n`);
      fs.utimesSync(metaFile, new Date("2026-02-21T10:00:10Z"), new Date("2026-02-21T10:00:10Z"));

      const sessions = await adapter.listSessions(metaProjectPath);
      expect(sessions.some((session) => session.id === metaSessionId)).toBe(true);
    });
  });

  describe("capture", () => {
    it("should parse Codex JSONL, extract files, and run conversation analysis", async () => {
      const session = await adapter.capture(SESSION_ID);

      expect(session.version).toBe("1.0");
      expect(session.source).toBe("codex");
      expect(session.sessionId).toBe(SESSION_ID);
      expect(session.conversation.messages.length).toBeGreaterThan(10);
      expect(session.conversation.estimatedTokens).toBeGreaterThan(0);

      expect(
        session.conversation.messages.some((msg) =>
          msg.content.includes("I'll use Fastify instead of Express"),
        ),
      ).toBe(true);
      expect(
        session.conversation.messages.some((msg) =>
          msg.content.includes("Build a task API with validation"),
        ),
      ).toBe(true);

      expect(session.task.description).toContain("Build a task API");
      expect(
        session.decisions.some((d) => d.toLowerCase().includes("fastify")),
      ).toBe(true);
      expect(
        session.decisions.some((d) => d.toLowerCase().includes("let's use zod")),
      ).toBe(true);
      expect(
        session.blockers.some((b) => b.includes("ECONNREFUSED")),
      ).toBe(true);
      expect(
        session.task.completed.some((step) =>
          step.includes("Created the server bootstrap"),
        ),
      ).toBe(true);

      expect(session.filesChanged.map((f) => f.path)).toEqual(
        expect.arrayContaining([
          "src/server.ts",
          "src/auth.ts",
          "src/generated.txt",
        ]),
      );

      expect(session.project.path).toBe("/tmp/codex-app");
    });

    it("should map role:developer to system", async () => {
      const session = await adapter.capture(SESSION_ID);
      expect(
        session.conversation.messages.some(
          (msg) =>
            msg.role === "system" &&
            msg.content.includes("AGENTS.md constraints"),
        ),
      ).toBe(true);
    });

    it("should handle empty JSONL file", async () => {
      const emptySessionId = "rollout-2026-02-21T08-00-00-empty";
      const emptyFile = path.join(sessionsDir, `${emptySessionId}.jsonl`);
      fs.writeFileSync(emptyFile, "");

      const session = await adapter.capture(emptySessionId);
      expect(session.sessionId).toBe(emptySessionId);
      expect(session.conversation.messages.length).toBe(0);
      expect(session.task.description).toBe("Unknown task");
    });

    it("should handle JSONL with only system entries", async () => {
      const systemOnlyId = "rollout-2026-02-21T09-00-00-system";
      const systemOnlyFile = path.join(sessionsDir, `${systemOnlyId}.jsonl`);
      const lines = [
        JSON.stringify({
          role: "developer",
          content: "System-only directive",
          timestamp: "2026-02-21T09:00:00Z",
          cwd: "/tmp/codex-system",
        }),
        JSON.stringify({
          role: "developer",
          content: "Another system note",
          timestamp: "2026-02-21T09:01:00Z",
          cwd: "/tmp/codex-system",
        }),
      ];
      fs.writeFileSync(systemOnlyFile, `${lines.join("\n")}\n`);

      const session = await adapter.capture(systemOnlyId);
      expect(session.conversation.messages.length).toBe(2);
      expect(session.conversation.messages.every((m) => m.role === "system")).toBe(
        true,
      );
      expect(session.task.description).toBe("Unknown task");
    });

    it("should infer project path from session_meta payload cwd", async () => {
      const metaSessionId = "rollout-2026-02-21T11-00-00-meta-capture";
      const metaProjectPath = path.join(tmpHome, "meta-capture-project");
      const metaFile = path.join(sessionsDir, `${metaSessionId}.jsonl`);
      fs.mkdirSync(metaProjectPath, { recursive: true });

      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-02-21T11:00:00Z",
          payload: {
            cwd: metaProjectPath,
          },
        }),
        JSON.stringify({
          role: "user",
          content: "Build metadata-based capture",
          timestamp: "2026-02-21T11:00:10Z",
        }),
        JSON.stringify({
          role: "assistant",
          content: "Created metadata-driven parser.",
          timestamp: "2026-02-21T11:00:20Z",
        }),
      ];
      fs.writeFileSync(metaFile, `${lines.join("\n")}\n`);

      const session = await adapter.capture(metaSessionId);
      expect(session.project.path).toBe(metaProjectPath);
    });

    it("should parse response_item payload messages from Codex VS Code sessions", async () => {
      fs.copyFileSync(RESPONSE_ITEM_FIXTURE_PATH, sessionFile);

      const session = await adapter.capture(SESSION_ID);
      expect(session.conversation.messages.length).toBeGreaterThan(6);
      expect(
        session.conversation.messages.some(
          (msg) =>
            msg.role === "user" &&
            msg.content.includes("Build a markdown search CLI"),
        ),
      ).toBe(true);
      expect(
        session.conversation.messages.some(
          (msg) =>
            msg.role === "assistant" &&
            msg.content.includes("I'll use ripgrep instead of grep"),
        ),
      ).toBe(true);
      expect(
        session.conversation.messages.some(
          (msg) =>
            msg.role === "system" &&
            msg.content.includes("Prefer TypeScript strict mode"),
        ),
      ).toBe(true);
      expect(session.task.description).toContain("Build a markdown search CLI");
      expect(
        session.task.completed.some((step) =>
          step.includes("Created CLI entrypoint"),
        ),
      ).toBe(true);
      expect(
        session.decisions.some((decision) =>
          decision.toLowerCase().includes("instead of grep"),
        ),
      ).toBe(true);
      expect(session.project.path).toBe("/tmp/codex-vscode");
      expect(session.filesChanged.map((f) => f.path)).toEqual(
        expect.arrayContaining(["src/search.ts", "src/cli.ts"]),
      );
    });
  });

  describe("captureLatest", () => {
    it("should capture the most recently modified session", async () => {
      const olderId = "rollout-2026-02-19T08-00-00-old-session";
      const olderFile = path.join(
        tmpHome,
        ".codex",
        "sessions",
        "2026",
        "02",
        "19",
        `${olderId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(olderFile), { recursive: true });
      fs.writeFileSync(
        olderFile,
        JSON.stringify({
          role: "user",
          content: "Older session",
          timestamp: "2026-02-19T08:00:00Z",
          cwd: "/tmp/old-codex",
        }) + "\n",
      );
      fs.utimesSync(olderFile, new Date("2026-02-19T08:00:00Z"), new Date("2026-02-19T08:00:00Z"));
      fs.utimesSync(sessionFile, new Date("2026-02-20T09:08:00Z"), new Date("2026-02-20T09:08:00Z"));

      const session = await adapter.captureLatest();
      expect(session.sessionId).toBe(SESSION_ID);
    });
  });
});
