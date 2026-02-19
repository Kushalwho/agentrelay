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

  const SESSION_ID = "rollout-2026-02-20T09-00-00-main-session";

  let adapter: CodexAdapter;
  let tmpHome: string;
  let sessionsDir: string;
  let sessionFile: string;

  beforeEach(() => {
    adapter = new CodexAdapter();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-codex-"));
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
