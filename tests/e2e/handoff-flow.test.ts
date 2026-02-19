import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compress } from "../../src/core/compression.js";
import { buildResumePrompt } from "../../src/core/prompt-builder.js";
import { mkdirSync, writeFileSync } from "node:fs";
import type { CapturedSession } from "../../src/types/index.js";

function makeMockSession(overrides?: Partial<CapturedSession>): CapturedSession {
  return {
    version: "1.0",
    source: "claude-code",
    capturedAt: "2026-02-19T10:00:00Z",
    sessionId: "e2e-test-session-abc123def456",
    project: {
      path: "/home/user/my-app",
      name: "my-app",
      gitBranch: "feat/e2e-tests",
      gitStatus: "M src/index.ts",
      structure: "src/\n  index.ts\n  utils.ts\ntests/\n  index.test.ts",
    },
    conversation: {
      messageCount: 8,
      estimatedTokens: 3000,
      messages: [
        { role: "user", content: "Set up the project with TypeScript and Vitest" },
        { role: "assistant", content: "I'll set up the project with TypeScript and Vitest. Let me create the config files." },
        { role: "assistant", content: "Created tsconfig.json and vitest.config.ts", toolName: "write_file" },
        { role: "user", content: "Now add the compression engine" },
        { role: "assistant", content: "I'll implement the compression engine with priority layers." },
        { role: "assistant", content: "Created src/core/compression.ts", toolName: "write_file" },
        { role: "user", content: "Add tests for the compression engine" },
        { role: "assistant", content: "Writing compression tests now." },
      ],
    },
    filesChanged: [
      { path: "src/core/compression.ts", changeType: "created", diff: "+export function compress() {}" },
      { path: "tsconfig.json", changeType: "created" },
      { path: "vitest.config.ts", changeType: "created" },
    ],
    decisions: ["Use priority-layered compression", "Target 80% of context window"],
    blockers: [],
    task: {
      description: "Build a compression engine for session handoff",
      completed: ["Project setup", "Type definitions"],
      remaining: ["Write tests", "Add CLI integration"],
      inProgress: "Implementing compression engine",
      blockers: [],
    },
    ...overrides,
  };
}

describe("E2E: Handoff Flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentrelay-e2e-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should run full pipeline: compress → build resume → verify sections", () => {
    const session = makeMockSession();

    // Compress
    const compressed = compress(session, { targetTokens: 10000 });
    expect(compressed.totalTokens).toBeGreaterThan(0);
    expect(compressed.includedLayers.length).toBeGreaterThan(0);

    // Build resume
    const resume = buildResumePrompt(session, compressed);

    // Verify key sections exist
    expect(resume).toContain("# AgentRelay — Session Handoff");
    expect(resume).toContain("## Instructions for Resuming Agent");
    expect(resume).toContain("## Current Task");
    expect(resume).toContain("## Resume Now");

    // Verify task state
    expect(resume).toContain("Build a compression engine for session handoff");
    expect(resume).toContain("- Project setup");
    expect(resume).toContain("- Type definitions");
    expect(resume).toContain("Implementing compression engine");
    expect(resume).toContain("- Write tests");

    // Verify compressed content includes priority layers
    expect(resume).toContain("TASK STATE");
    expect(resume).toContain("ACTIVE FILES");
    expect(resume).toContain("DECISIONS & BLOCKERS");

    // Verify project context in header
    expect(resume).toContain("my-app");
    expect(resume).toContain("feat/e2e-tests");
  });

  it("should write RESUME.md to .handoff/ directory", () => {
    const session = makeMockSession();
    const compressed = compress(session, { targetTokens: 10000 });
    const resume = buildResumePrompt(session, compressed);

    // Write to temp .handoff/ dir (simulating what CLI does)
    const handoffDir = join(tempDir, ".handoff");
    mkdirSync(handoffDir, { recursive: true });
    const outputPath = join(handoffDir, "RESUME.md");
    writeFileSync(outputPath, resume);

    // Verify file exists and content matches
    const written = readFileSync(outputPath, "utf-8");
    expect(written).toBe(resume);
    expect(written).toContain("# AgentRelay — Session Handoff");
    expect(written).toContain("## Resume Now");
    expect(written.length).toBeGreaterThan(100);
  });

  it("should respect token budget and drop low-priority layers", () => {
    const session = makeMockSession();

    // Use a tiny budget that can't fit everything
    const compressed = compress(session, { targetTokens: 500 });

    // High-priority layers should be included
    expect(compressed.includedLayers).toContain("TASK STATE");

    // Low-priority layers should be dropped
    expect(compressed.droppedLayers.length).toBeGreaterThan(0);

    // The total tokens should respect the budget
    expect(compressed.totalTokens).toBeLessThanOrEqual(500);

    // Build resume with the compressed result — should still be valid
    const resume = buildResumePrompt(session, compressed);
    expect(resume).toContain("# AgentRelay — Session Handoff");
    expect(resume).toContain("## Current Task");
  });

  it("should handle empty session gracefully", () => {
    const session = makeMockSession({
      conversation: {
        messageCount: 0,
        estimatedTokens: 0,
        messages: [],
      },
      filesChanged: [],
      decisions: [],
      blockers: [],
      task: {
        description: "Empty task",
        completed: [],
        remaining: [],
        blockers: [],
      },
    });

    const compressed = compress(session, { targetTokens: 10000 });
    expect(compressed.totalTokens).toBeGreaterThan(0); // Still has layer headers
    expect(compressed.includedLayers.length).toBeGreaterThan(0);

    const resume = buildResumePrompt(session, compressed);
    expect(resume).toContain("# AgentRelay — Session Handoff");
    expect(resume).toContain("Empty task");
    expect(resume).toContain("- None yet"); // No completed items
    expect(resume).toContain("- None"); // No remaining items
    expect(resume).toContain("## Resume Now");
  });
});
