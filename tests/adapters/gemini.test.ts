import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "../../src/adapters/gemini/adapter.js";

describe("GeminiAdapter", () => {
  let adapter: GeminiAdapter;
  let tmpHome: string;
  let sessionsRoot: string;

  beforeEach(() => {
    adapter = new GeminiAdapter();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-gemini-"));
    sessionsRoot = path.join(tmpHome, ".gemini", "tmp");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("should detect gemini sessions", async () => {
    writeSession(sessionsRoot, "hash-a", "session-100.json", {
      sessionId: "session-100",
      messages: [],
    });
    await expect(adapter.detect()).resolves.toBe(true);
  });

  it("should list sessions from multiple project hashes", async () => {
    const projectA = path.join(tmpHome, "proj-a");
    const projectB = path.join(tmpHome, "proj-b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    writeSession(sessionsRoot, "hash-a", "session-101.json", {
      sessionId: "session-101",
      workingDirectory: projectA,
      updatedAt: "2026-02-20T11:00:00Z",
      messages: [{ role: "user", parts: [{ text: "A" }] }],
    });
    writeSession(sessionsRoot, "hash-b", "session-102.json", {
      sessionId: "session-102",
      workingDirectory: projectB,
      updatedAt: "2026-02-20T12:00:00Z",
      messages: [{ role: "user", parts: [{ text: "B" }] }],
    });

    const sessions = await adapter.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe("session-102");
    expect(sessions[1].id).toBe("session-101");
  });

  it("should capture session with tool calls and thoughts", async () => {
    const project = path.join(tmpHome, "proj-capture");
    fs.mkdirSync(project, { recursive: true });
    writeSession(sessionsRoot, "hash-c", "session-103.json", {
      sessionId: "session-103",
      workingDirectory: project,
      tokenUsage: { inputTokens: 120, outputTokens: 30 },
      messages: [
        {
          role: "user",
          timestamp: "2026-02-20T10:00:00Z",
          parts: [{ text: "Implement auth middleware" }],
        },
        {
          role: "model",
          timestamp: "2026-02-20T10:01:00Z",
          parts: [{ text: "I'll edit src/auth.ts and add tests." }],
          toolCalls: [
            {
              name: "write_file",
              args: { path: "src/auth.ts", content: "new content" },
              result: "File written",
              resultDisplay: {
                fileName: "auth.ts",
                filePath: "src/auth.ts",
                diffStat: { model_added_lines: 10, model_removed_lines: 3 },
                isNewFile: false,
              },
            },
          ],
          thoughts: [
            {
              subject: "approach",
              description: "Next: add middleware tests after refactor.",
            },
          ],
        },
      ],
    });

    const session = await adapter.capture("session-103");
    expect(session.source).toBe("gemini");
    expect(session.conversation.messages.some((msg) => msg.role === "assistant")).toBe(
      true,
    );
    expect(session.filesChanged.map((f) => f.path)).toContain("src/auth.ts");
    expect(session.decisions.some((d) => d.includes("Next: add middleware tests"))).toBe(
      true,
    );
    expect(session.task.remaining.some((r) => r.toLowerCase().includes("next"))).toBe(
      true,
    );
    expect(session.conversation.estimatedTokens).toBe(150);
    expect((session as { toolActivity?: unknown[] }).toolActivity?.length).toBeGreaterThan(0);
  });

  it("should extract file changes from diffStat", async () => {
    writeSession(sessionsRoot, "hash-d", "session-104.json", {
      sessionId: "session-104",
      messages: [
        {
          role: "model",
          parts: [{ text: "Updated file" }],
          toolCalls: [
            {
              name: "write_file",
              args: { path: "src/app.ts" },
              resultDisplay: {
                filePath: "src/app.ts",
                diffStat: { model_added_lines: 5, model_removed_lines: 2 },
                isNewFile: false,
              },
            },
          ],
        },
      ],
    });

    const session = await adapter.capture("session-104");
    expect(session.filesChanged.length).toBe(1);
    expect(session.filesChanged[0].path).toBe("src/app.ts");
    expect(session.filesChanged[0].diff).toBe("+5 -2");
  });

  it("should handle empty messages array", async () => {
    writeSession(sessionsRoot, "hash-e", "session-105.json", {
      sessionId: "session-105",
      messages: [],
    });

    const session = await adapter.capture("session-105");
    expect(session.conversation.messages.length).toBe(0);
    expect(session.task.description).toBe("Unknown task");
  });
});

function writeSession(
  sessionsRoot: string,
  hash: string,
  fileName: string,
  payload: Record<string, unknown>,
): void {
  const chatsDir = path.join(sessionsRoot, hash, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, fileName), JSON.stringify(payload, null, 2));
}
