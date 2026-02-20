import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotAdapter } from "../../src/adapters/copilot/adapter.js";

describe("CopilotAdapter", () => {
  let adapter: CopilotAdapter;
  let tmpHome: string;
  let sessionsDir: string;

  beforeEach(() => {
    adapter = new CopilotAdapter();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-copilot-"));
    sessionsDir = path.join(tmpHome, ".copilot", "session-state");
    fs.mkdirSync(sessionsDir, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("should detect copilot sessions", async () => {
    createWorkspace(sessionsDir, "session-1", {
      sessionId: "session-1",
      workingDirectory: path.join(tmpHome, "project-a"),
      createdAt: "2026-02-20T10:00:00Z",
      updatedAt: "2026-02-20T10:05:00Z",
    });

    await expect(adapter.detect()).resolves.toBe(true);
  });

  it("should list sessions filtered by project path", async () => {
    const projectA = path.join(tmpHome, "project-a");
    const projectB = path.join(tmpHome, "project-b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    createWorkspace(sessionsDir, "a", {
      sessionId: "copilot-a",
      workingDirectory: projectA,
      createdAt: "2026-02-20T10:00:00Z",
      updatedAt: "2026-02-20T12:00:00Z",
      summary: "A summary",
    });
    createWorkspace(sessionsDir, "b", {
      sessionId: "copilot-b",
      workingDirectory: projectB,
      createdAt: "2026-02-20T11:00:00Z",
      updatedAt: "2026-02-20T13:00:00Z",
      summary: "B summary",
    });

    const sessions = await adapter.listSessions(projectA);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("copilot-a");
    expect(sessions[0].projectPath).toBe(projectA);
  });

  it("should capture session with messages", async () => {
    const project = path.join(tmpHome, "project-capture");
    fs.mkdirSync(project, { recursive: true });
    createWorkspace(sessionsDir, "capture-1", {
      sessionId: "capture-1",
      workingDirectory: project,
      createdAt: "2026-02-20T09:00:00Z",
      updatedAt: "2026-02-20T09:10:00Z",
    });
    fs.writeFileSync(
      path.join(sessionsDir, "capture-1", "events.jsonl"),
      [
        JSON.stringify({
          type: "session.start",
          timestamp: "2026-02-20T09:00:00Z",
          selectedModel: "gpt-4o",
        }),
        JSON.stringify({
          type: "user.message",
          timestamp: "2026-02-20T09:00:10Z",
          content: "Fix login bug",
        }),
        JSON.stringify({
          type: "assistant.message",
          timestamp: "2026-02-20T09:01:00Z",
          content: "I'll patch auth.ts",
          toolRequests: [
            {
              name: "edit_file",
              args: { path: "src/auth.ts", content: "patched content" },
            },
          ],
        }),
      ].join("\n") + "\n",
    );

    const session = await adapter.capture("capture-1");
    expect(session.source).toBe("copilot");
    expect(session.conversation.messages.length).toBeGreaterThanOrEqual(3);
    expect(
      session.conversation.messages.some(
        (msg) => msg.role === "user" && msg.content.includes("Fix login bug"),
      ),
    ).toBe(true);
    expect(session.filesChanged.map((fc) => fc.path)).toContain("src/auth.ts");
    expect((session as { toolActivity?: unknown[] }).toolActivity?.length).toBeGreaterThan(0);
  });

  it("should handle missing events.jsonl gracefully", async () => {
    const project = path.join(tmpHome, "project-missing-events");
    fs.mkdirSync(project, { recursive: true });
    createWorkspace(sessionsDir, "missing-events", {
      sessionId: "missing-events",
      workingDirectory: project,
      createdAt: "2026-02-20T08:00:00Z",
      updatedAt: "2026-02-20T08:05:00Z",
    });

    const session = await adapter.capture("missing-events");
    expect(session.sessionId).toBe("missing-events");
    expect(session.conversation.messages.length).toBe(0);
  });

  it("should synthesize from workspace summary when no messages", async () => {
    const project = path.join(tmpHome, "project-summary");
    fs.mkdirSync(project, { recursive: true });
    createWorkspace(sessionsDir, "summary-only", {
      sessionId: "summary-only",
      workingDirectory: project,
      createdAt: "2026-02-20T07:00:00Z",
      updatedAt: "2026-02-20T07:05:00Z",
      summary: "Working on auth middleware and tests.",
    });

    const session = await adapter.capture("summary-only");
    expect(session.conversation.messages.length).toBe(1);
    expect(session.conversation.messages[0].role).toBe("assistant");
    expect(session.conversation.messages[0].content).toContain("auth middleware");
  });
});

function createWorkspace(
  sessionsDir: string,
  id: string,
  data: {
    sessionId: string;
    workingDirectory: string;
    createdAt: string;
    updatedAt: string;
    summary?: string;
  },
): void {
  const dir = path.join(sessionsDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const yamlLines = [
    `sessionId: "${data.sessionId}"`,
    `workingDirectory: "${data.workingDirectory.replace(/\\/g, "\\\\")}"`,
    `createdAt: "${data.createdAt}"`,
    `updatedAt: "${data.updatedAt}"`,
  ];
  if (data.summary) {
    yamlLines.push("summary: |");
    for (const line of data.summary.split(/\r?\n/)) {
      yamlLines.push(`  ${line}`);
    }
  }

  fs.writeFileSync(path.join(dir, "workspace.yaml"), `${yamlLines.join("\n")}\n`);
}
