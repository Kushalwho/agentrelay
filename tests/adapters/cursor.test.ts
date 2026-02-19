import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CursorAdapter } from "../../src/adapters/cursor/adapter.js";

describe("CursorAdapter", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const FIXTURE_PATH = path.resolve(
    __dirname,
    "..",
    "fixtures",
    "cursor-state.json",
  );

  let adapter: CursorAdapter;
  let tmpRoot: string;
  let workspaceStorageDir: string;
  let modernSessionId: string;
  let legacySessionId: string;

  function getWorkspaceStoragePath(homeDir: string): string {
    if (process.platform === "darwin") {
      return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
    }
    if (process.platform === "linux") {
      return path.join(homeDir, ".config", "Cursor", "User", "workspaceStorage");
    }
    // Windows
    return path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "workspaceStorage");
  }

  beforeEach(() => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as CursorFixture;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-cursor-"));

    vi.spyOn(os, "homedir").mockReturnValue(tmpRoot);
    // Also set APPDATA for Windows path resolution inside the adapter
    process.env.APPDATA = path.join(tmpRoot, "AppData", "Roaming");

    workspaceStorageDir = getWorkspaceStoragePath(tmpRoot);
    fs.mkdirSync(workspaceStorageDir, { recursive: true });

    const modernWorkspaceHash = "ws-modern";
    const modernWorkspaceDir = path.join(workspaceStorageDir, modernWorkspaceHash);
    fs.mkdirSync(modernWorkspaceDir, { recursive: true });
    const modernProjectPath = path.join(tmpRoot, "projects", "cursor-modern");
    fs.mkdirSync(modernProjectPath, { recursive: true });
    fs.writeFileSync(
      path.join(modernWorkspaceDir, "workspace.json"),
      JSON.stringify({
        folder: `file:///${modernProjectPath.replace(/\\/g, "/")}`,
      }),
    );
    buildWorkspaceDb(
      path.join(modernWorkspaceDir, "state.vscdb"),
      fixture.modern.composerData,
      fixture.modern.bubbles,
    );
    modernSessionId = `${modernWorkspaceHash}:composer-123`;

    const legacyWorkspaceHash = "ws-legacy";
    const legacyWorkspaceDir = path.join(workspaceStorageDir, legacyWorkspaceHash);
    fs.mkdirSync(legacyWorkspaceDir, { recursive: true });
    const legacyProjectPath = path.join(tmpRoot, "projects", "cursor-legacy");
    fs.mkdirSync(legacyProjectPath, { recursive: true });
    fs.writeFileSync(
      path.join(legacyWorkspaceDir, "workspace.json"),
      JSON.stringify({
        folder: `file:///${legacyProjectPath.replace(/\\/g, "/")}`,
      }),
    );
    buildWorkspaceDb(
      path.join(legacyWorkspaceDir, "state.vscdb"),
      { allComposers: [] },
      {},
      fixture.legacy.chatData,
    );
    legacySessionId = `${legacyWorkspaceHash}:legacy-777`;

    adapter = new CursorAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("detect", () => {
    it("should return true when Cursor workspaceStorage exists", async () => {
      const detected = await adapter.detect();
      expect(detected).toBe(true);
    });

    it("should return false when directory does not exist", async () => {
      const missingHome = path.join(os.tmpdir(), `missing-home-${Date.now()}`);
      vi.spyOn(os, "homedir").mockReturnValue(missingHome);
      const emptyAdapter = new CursorAdapter();
      const detected = await emptyAdapter.detect();
      expect(detected).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should list composer sessions from SQLite and sort by recency", async () => {
      const sessions = await adapter.listSessions();

      expect(sessions.length).toBe(3);
      expect(sessions[0].id).toBe(modernSessionId);
      expect(sessions.some((s) => s.id === legacySessionId)).toBe(true);
      expect(sessions[0].projectPath).toContain("cursor-modern");
    });
  });

  describe("capture", () => {
    it("should read messages from modern state.vscdb format", async () => {
      const session = await adapter.capture(modernSessionId);

      expect(session.version).toBe("1.0");
      expect(session.source).toBe("cursor");
      expect(session.sessionId).toBe(modernSessionId);
      expect(session.conversation.messages.length).toBeGreaterThan(4);
      expect(session.task.description).toContain("Build a task API");

      expect(
        session.decisions.some((decision) =>
          decision.toLowerCase().includes("fastify instead of express"),
        ),
      ).toBe(true);
      expect(
        session.blockers.some((blocker) => blocker.includes("ECONNREFUSED")),
      ).toBe(true);
      expect(
        session.task.completed.some((step) =>
          step.includes("Created the auth middleware"),
        ),
      ).toBe(true);
      expect(session.filesChanged.map((f) => f.path)).toEqual(
        expect.arrayContaining(["src/auth.ts", "src/token.ts"]),
      );
    });

    it("should handle legacy format fallback", async () => {
      const session = await adapter.capture(legacySessionId);

      expect(session.sessionId).toBe(legacySessionId);
      expect(
        session.conversation.messages.some((m) =>
          m.content.includes("Implement legacy fallback parser"),
        ),
      ).toBe(true);
      expect(session.task.description).toContain("Implement legacy fallback parser");
    });
  });

  describe("captureLatest", () => {
    it("should capture the latest session", async () => {
      const latest = await adapter.captureLatest();
      expect(latest.sessionId).toBe(modernSessionId);
    });

    it("should validate session ID format", async () => {
      await expect(adapter.capture("bad-format")).rejects.toThrow(
        "Invalid Cursor session ID",
      );
    });
  });
});

interface CursorFixture {
  modern: {
    composerData: Record<string, unknown>;
    bubbles: Record<string, Record<string, unknown>>;
  };
  legacy: {
    chatData: Record<string, unknown>;
  };
}

function buildWorkspaceDb(
  dbPath: string,
  composerData: Record<string, unknown>,
  bubbles: Record<string, Record<string, unknown>>,
  legacyChatData?: Record<string, unknown>,
): void {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("composer.composerData", JSON.stringify(composerData));

    if (legacyChatData) {
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
        .run(
          "workbench.panel.aichat.view.aichat.chatdata",
          JSON.stringify(legacyChatData),
        );
    }

    for (const [key, value] of Object.entries(bubbles)) {
      const payload = { ...value };
      if (typeof payload.contentText === "string" && !payload.new_content) {
        payload.new_content = payload.contentText;
      }
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
        .run(key, JSON.stringify(payload));
    }
  } finally {
    db.close();
  }
}
