import { describe, it, expect } from "vitest";
import { buildResumePrompt } from "../../src/core/prompt-builder.js";
import type {
  CapturedSession,
  CompressionResult,
} from "../../src/types/index.js";

const mockSession: CapturedSession = {
  version: "1.0",
  source: "claude-code",
  capturedAt: "2026-02-19T12:00:00Z",
  sessionId: "test-session-123",
  project: {
    path: "/home/user/my-project",
    name: "my-project",
    gitBranch: "feature/handoff",
  },
  conversation: {
    messageCount: 42,
    estimatedTokens: 15000,
    messages: [],
  },
  filesChanged: [
    { path: "src/index.ts", changeType: "modified", diff: "+added line" },
    { path: "src/utils.ts", changeType: "created" },
  ],
  decisions: ["Use ESM modules", "Store sessions in SQLite"],
  blockers: [],
  task: {
    description: "Build the AgentRelay CLI tool",
    completed: ["Set up project skeleton", "Define type interfaces"],
    remaining: ["Implement compression engine", "Write tests"],
    inProgress: "Implementing the prompt builder",
    blockers: [],
  },
};

const mockCompressed: CompressionResult = {
  content:
    "## Key Decisions\n\n- Use ESM modules\n- Store sessions in SQLite\n\n## Files Changed\n\n- src/index.ts (modified)\n- src/utils.ts (created)",
  totalTokens: 500,
  includedLayers: ["task-state", "decisions", "files-changed"],
  droppedLayers: ["full-conversation"],
};

describe("Prompt Builder", () => {
  it("should generate valid markdown", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("# AgentRelay — Session Handoff");
  });

  it("should include the self-summarizing instructions header", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain("## Instructions for Resuming Agent");
    expect(result).toContain(
      "You are continuing a task that was started in a previous claude-code session."
    );
    expect(result).toContain("Pick up EXACTLY where the previous agent left off");
  });

  it("should include task state section", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain("## Current Task");
    expect(result).toContain("Build the AgentRelay CLI tool");
    expect(result).toContain("- Set up project skeleton");
    expect(result).toContain("- Define type interfaces");
    expect(result).toContain("Implementing the prompt builder");
    expect(result).toContain("- Implement compression engine");
  });

  it("should include decisions section when decisions exist", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain("Key Decisions");
    expect(result).toContain("Use ESM modules");
    expect(result).toContain("Store sessions in SQLite");
  });

  it("should include files changed section", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain("Files Changed");
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/utils.ts");
  });

  it("should include the compressed content", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain(mockCompressed.content);
  });

  it("should include Resume Now footer", () => {
    const result = buildResumePrompt(mockSession, mockCompressed);
    expect(result).toContain("## Resume Now");
    expect(result).toContain("Do not ask for confirmation. Do not summarize. Just continue building.");
    expect(result).toContain("Start with Implementing the prompt builder");
  });

  it("should use project path basename when name is missing", () => {
    const sessionNoName: CapturedSession = {
      ...mockSession,
      project: { path: "/home/user/cool-app" },
    };
    const result = buildResumePrompt(sessionNoName, mockCompressed);
    expect(result).toContain("cool-app");
  });

  it("should show 'unknown' when git branch is missing", () => {
    const sessionNoBranch: CapturedSession = {
      ...mockSession,
      project: { ...mockSession.project, gitBranch: undefined },
    };
    const result = buildResumePrompt(sessionNoBranch, mockCompressed);
    expect(result).toContain("Branch: `unknown`");
  });

  it("should handle empty completed and remaining lists", () => {
    const sessionEmpty: CapturedSession = {
      ...mockSession,
      task: {
        description: "Some task",
        completed: [],
        remaining: [],
        blockers: [],
      },
    };
    const result = buildResumePrompt(sessionEmpty, mockCompressed);
    expect(result).toContain("- None yet");
    expect(result).toContain("- None");
    expect(result).toContain("Start with the next logical step");
  });

  describe("target agent hints", () => {
    it("should add Cursor target hint and footer", () => {
      const result = buildResumePrompt(mockSession, mockCompressed, "cursor");
      expect(result).toContain("**Target:** Cursor (paste into Composer)");
      expect(result).toContain("Paste this into Cursor's Composer to continue.");
    });

    it("should add Codex target hint and footer", () => {
      const result = buildResumePrompt(mockSession, mockCompressed, "codex");
      expect(result).toContain("**Target:** Codex CLI");
      expect(result).toContain("Feed this to Codex CLI with `codex resume` or paste it.");
    });

    it("should add Claude Code target hint and footer", () => {
      const result = buildResumePrompt(mockSession, mockCompressed, "claude-code");
      expect(result).toContain("**Target:** Claude Code");
      expect(result).toContain("Paste this into a new Claude Code session to continue.");
    });

    it("should use generic footer for file target", () => {
      const result = buildResumePrompt(mockSession, mockCompressed, "file");
      expect(result).not.toContain("**Target:**");
      expect(result).toContain("Paste into your target agent.");
    });

    it("should use generic footer when no target is specified", () => {
      const result = buildResumePrompt(mockSession, mockCompressed);
      expect(result).not.toContain("**Target:**");
      expect(result).toContain("Paste into your target agent.");
    });

    it("should use generic footer for clipboard target", () => {
      const result = buildResumePrompt(mockSession, mockCompressed, "clipboard");
      expect(result).not.toContain("**Target:**");
      expect(result).toContain("Paste into your target agent.");
    });
  });
});
