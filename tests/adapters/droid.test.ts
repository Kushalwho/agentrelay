import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DroidAdapter } from "../../src/adapters/droid/adapter.js";

describe("DroidAdapter", () => {
  let adapter: DroidAdapter;
  let tmpHome: string;
  let sessionsRoot: string;

  beforeEach(() => {
    adapter = new DroidAdapter();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-droid-"));
    sessionsRoot = path.join(tmpHome, ".factory", "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("should detect droid sessions", async () => {
    writeDroidSession(sessionsRoot, "workspace-a", "uuid-1", []);
    await expect(adapter.detect()).resolves.toBe(true);
  });

  it("should capture session with tool calls", async () => {
    const project = path.join(tmpHome, "project-droid");
    fs.mkdirSync(project, { recursive: true });

    writeDroidSession(sessionsRoot, "workspace-a", "uuid-2", [
      {
        type: "session_start",
        timestamp: "2026-02-20T10:00:00Z",
        cwd: project,
      },
      {
        type: "message",
        timestamp: "2026-02-20T10:00:10Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix auth bug" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-02-20T10:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll update src/auth.ts" },
            {
              type: "tool_use",
              name: "Edit",
              input: { path: "src/auth.ts", content: "patched" },
            },
          ],
        },
      },
    ]);

    const session = await adapter.capture("workspace-a:uuid-2");
    expect(session.source).toBe("droid");
    expect(session.conversation.messages.some((m) => m.role === "tool")).toBe(true);
    expect(session.filesChanged.map((f) => f.path)).toContain("src/auth.ts");
    expect((session as { toolActivity?: unknown[] }).toolActivity?.length).toBeGreaterThan(0);
  });

  it("should parse todo_state into task state", async () => {
    writeDroidSession(sessionsRoot, "workspace-b", "uuid-3", [
      { type: "session_start", timestamp: "2026-02-20T11:00:00Z" },
      {
        type: "todo_state",
        timestamp: "2026-02-20T11:01:00Z",
        todos:
          "1. [in_progress] Fix auth bug\n2. [pending] Add tests\n3. [completed] Setup project",
      },
    ]);

    const session = await adapter.capture("workspace-b:uuid-3");
    expect(session.task.inProgress).toBe("Fix auth bug");
    expect(session.task.remaining).toContain("Fix auth bug");
    expect(session.task.remaining).toContain("Add tests");
    expect(session.task.completed).toContain("Setup project");
  });

  it("should read settings.json for model and token usage", async () => {
    writeDroidSession(
      sessionsRoot,
      "workspace-c",
      "uuid-4",
      [
        { type: "session_start", timestamp: "2026-02-20T12:00:00Z" },
        {
          type: "message",
          timestamp: "2026-02-20T12:00:10Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
      ],
      {
        model: "claude-sonnet-4-20250514",
        tokenUsage: { inputTokens: 500, outputTokens: 100, cacheCreationTokens: 50 },
      },
    );

    const session = await adapter.capture("workspace-c:uuid-4");
    expect(session.conversation.estimatedTokens).toBe(650);
  });

  it("should handle missing settings.json gracefully", async () => {
    writeDroidSession(sessionsRoot, "workspace-d", "uuid-5", [
      { type: "session_start", timestamp: "2026-02-20T12:30:00Z" },
      {
        type: "message",
        timestamp: "2026-02-20T12:31:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No settings present." }],
        },
      },
    ]);

    const session = await adapter.capture("workspace-d:uuid-5");
    expect(session.sessionId).toBe("workspace-d:uuid-5");
    expect(session.conversation.messages.length).toBeGreaterThan(0);
  });

  it("should extract thinking blocks as decisions", async () => {
    writeDroidSession(sessionsRoot, "workspace-e", "uuid-6", [
      { type: "session_start", timestamp: "2026-02-20T13:00:00Z" },
      {
        type: "message",
        timestamp: "2026-02-20T13:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Use JWT strategy for this auth flow." },
            { type: "text", text: "Implemented auth plan." },
          ],
        },
      },
    ]);

    const session = await adapter.capture("workspace-e:uuid-6");
    expect(
      session.decisions.some((decision) => decision.includes("JWT strategy")),
    ).toBe(true);
  });
});

function writeDroidSession(
  sessionsRoot: string,
  slug: string,
  id: string,
  events: unknown[],
  settings?: Record<string, unknown>,
): void {
  const dir = path.join(sessionsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  if (settings) {
    fs.writeFileSync(
      path.join(dir, `${id}.settings.json`),
      JSON.stringify(settings, null, 2),
    );
  }
}
