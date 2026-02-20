import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { OpenCodeAdapter } from "../../src/adapters/opencode/adapter.js";

describe("OpenCodeAdapter", () => {
  let adapter: OpenCodeAdapter;
  let tmpHome: string;
  let rootDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-opencode-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    process.env.LOCALAPPDATA = path.join(tmpHome, "AppData", "Local");
    rootDir = resolveOpenCodeRoot(tmpHome);
    fs.mkdirSync(rootDir, { recursive: true });
    adapter = new OpenCodeAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("should detect opencode via SQLite DB", async () => {
    createSqliteFixture(path.join(rootDir, "opencode.db"), {
      sessions: [
        {
          id: "sess-1",
          project_id: "proj-1",
          directory: path.join(tmpHome, "proj"),
          title: "SQLite session",
          time_created: "2026-02-20T10:00:00Z",
          time_updated: "2026-02-20T10:05:00Z",
        },
      ],
    });

    await expect(adapter.detect()).resolves.toBe(true);
  });

  it("should detect opencode via JSON fallback", async () => {
    createJsonStorageFixture(rootDir, {
      sessionId: "json-session-1",
      directory: path.join(tmpHome, "json-proj"),
    });

    await expect(adapter.detect()).resolves.toBe(true);
  });

  it("should list sessions from SQLite", async () => {
    createSqliteFixture(path.join(rootDir, "opencode.db"), {
      sessions: [
        {
          id: "sess-1",
          project_id: "proj-1",
          directory: path.join(tmpHome, "proj-a"),
          title: "Older",
          time_created: "2026-02-20T10:00:00Z",
          time_updated: "2026-02-20T10:05:00Z",
        },
        {
          id: "sess-2",
          project_id: "proj-2",
          directory: path.join(tmpHome, "proj-b"),
          title: "Newer",
          time_created: "2026-02-20T11:00:00Z",
          time_updated: "2026-02-20T11:05:00Z",
        },
      ],
    });

    const sessions = await adapter.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe("sess-2");
    expect(sessions[1].id).toBe("sess-1");
  });

  it("should capture session with text and tool parts", async () => {
    createSqliteFixture(path.join(rootDir, "opencode.db"), {
      sessions: [
        {
          id: "sess-capture",
          project_id: "proj-cap",
          directory: path.join(tmpHome, "proj-cap"),
          title: "Capture session",
          time_created: "2026-02-20T12:00:00Z",
          time_updated: "2026-02-20T12:10:00Z",
        },
      ],
      messages: [
        {
          id: "msg-1",
          session_id: "sess-capture",
          data: { role: "assistant" },
          time_created: "2026-02-20T12:01:00Z",
        },
      ],
      parts: [
        {
          id: "part-1",
          message_id: "msg-1",
          session_id: "sess-capture",
          data: { type: "text", text: "Implemented auth middleware." },
          time_created: "2026-02-20T12:01:01Z",
        },
        {
          id: "part-2",
          message_id: "msg-1",
          session_id: "sess-capture",
          data: {
            type: "tool-invocation",
            toolName: "write_file",
            args: { path: "src/auth.ts", content: "patched" },
            result: "done",
          },
          time_created: "2026-02-20T12:01:02Z",
        },
      ],
    });

    const session = await adapter.capture("sess-capture");
    expect(session.source).toBe("opencode");
    expect(
      session.conversation.messages.some(
        (msg) => msg.role === "assistant" && msg.content.includes("Implemented"),
      ),
    ).toBe(true);
    expect(session.filesChanged.map((f) => f.path)).toContain("src/auth.ts");
    expect((session as { toolActivity?: unknown[] }).toolActivity?.length).toBeGreaterThan(0);
  });

  it("should fall back to JSON when SQLite fails", async () => {
    fs.writeFileSync(path.join(rootDir, "opencode.db"), "not-a-sqlite-db");
    createJsonStorageFixture(rootDir, {
      sessionId: "json-fallback",
      directory: path.join(tmpHome, "proj-json"),
      messages: [
        {
          id: "msg-1",
          data: { role: "assistant" },
          time_created: "2026-02-20T13:01:00Z",
          parts: [{ type: "text", text: "JSON fallback path works." }],
        },
      ],
    });

    const session = await adapter.capture("json-fallback");
    expect(session.sessionId).toBe("json-fallback");
    expect(
      session.conversation.messages.some((msg) => msg.content.includes("fallback")),
    ).toBe(true);
  });
});

function resolveOpenCodeRoot(home: string): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "opencode",
    );
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "opencode");
  }
  return path.join(home, ".local", "share", "opencode");
}

function createSqliteFixture(
  dbPath: string,
  data: {
    sessions: Array<{
      id: string;
      project_id: string;
      directory?: string;
      title?: string;
      time_created?: string;
      time_updated?: string;
      slug?: string;
    }>;
    messages?: Array<{
      id: string;
      session_id: string;
      data: Record<string, unknown>;
      time_created?: string;
    }>;
    parts?: Array<{
      id: string;
      message_id: string;
      session_id: string;
      data: Record<string, unknown>;
      time_created?: string;
    }>;
  },
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        slug TEXT,
        directory TEXT,
        title TEXT,
        version TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        time_created TEXT,
        time_updated TEXT
      );
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created TEXT,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created TEXT,
        data TEXT
      );
    `);

    for (const session of data.sessions) {
      db.prepare(
        "INSERT INTO session (id, project_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        session.id,
        session.project_id,
        session.slug || null,
        session.directory || null,
        session.title || null,
        "1",
        0,
        0,
        0,
        session.time_created || null,
        session.time_updated || null,
      );
      db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)")
        .run(session.project_id, session.directory || null);
    }

    for (const message of data.messages || []) {
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      ).run(
        message.id,
        message.session_id,
        message.time_created || null,
        JSON.stringify(message.data),
      );
    }

    for (const part of data.parts || []) {
      db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
      ).run(
        part.id,
        part.message_id,
        part.session_id,
        part.time_created || null,
        JSON.stringify(part.data),
      );
    }
  } finally {
    db.close();
  }
}

function createJsonStorageFixture(
  rootDir: string,
  data: {
    sessionId: string;
    directory: string;
    messages?: Array<{
      id: string;
      time_created?: string;
      data?: Record<string, unknown>;
      parts?: unknown[];
    }>;
  },
): void {
  const storageDir = path.join(rootDir, "storage");
  const sessionDir = path.join(storageDir, "session", "proj-hash");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `ses_${data.sessionId}.json`),
    JSON.stringify(
      {
        id: data.sessionId,
        directory: data.directory,
        time_created: "2026-02-20T13:00:00Z",
        time_updated: "2026-02-20T13:05:00Z",
        title: "JSON fallback session",
      },
      null,
      2,
    ),
  );

  const messageDir = path.join(storageDir, "message", data.sessionId);
  fs.mkdirSync(messageDir, { recursive: true });
  for (const message of data.messages || []) {
    fs.writeFileSync(
      path.join(messageDir, `msg_${message.id}.json`),
      JSON.stringify(
        {
          id: message.id,
          time_created: message.time_created || "2026-02-20T13:01:00Z",
          data: message.data || { role: "assistant" },
          parts: message.parts || [],
        },
        null,
        2,
      ),
    );
  }
}
