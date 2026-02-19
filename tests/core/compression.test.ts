import { describe, it, expect } from "vitest";
import { buildLayers, compress } from "../../src/core/compression.js";
import { estimateTokens, fitsInBudget } from "../../src/core/token-estimator.js";
import type { CapturedSession } from "../../src/types/index.js";

const mockSession: CapturedSession = {
  version: "1.0",
  source: "claude-code",
  capturedAt: "2025-02-19T10:00:00Z",
  sessionId: "test-123",
  project: {
    path: "/home/user/my-app",
    gitBranch: "main",
    gitStatus: "M src/index.ts",
  },
  conversation: {
    messageCount: 5,
    estimatedTokens: 2000,
    messages: [
      { role: "user", content: "Add error handling to the API route", timestamp: "2025-02-19T10:00:00Z" },
      { role: "assistant", content: "I'll add comprehensive error handling.", toolName: "Read", timestamp: "2025-02-19T10:00:05Z" },
      { role: "assistant", content: "Here's the updated code with try/catch blocks.", toolName: "Write", timestamp: "2025-02-19T10:01:00Z" },
      { role: "user", content: "Now add input validation too", timestamp: "2025-02-19T10:02:00Z" },
      { role: "assistant", content: "Adding zod validation for the request body.", timestamp: "2025-02-19T10:02:30Z" },
    ],
  },
  filesChanged: [
    { path: "src/api/nutrition.ts", changeType: "modified", diff: "added try/catch", language: "typescript" },
  ],
  decisions: ["Use zod for validation", "Return 400 for invalid input"],
  blockers: ["OAuth token refresh failing intermittently"],
  task: {
    description: "Add error handling and input validation to nutrition API",
    completed: ["Error handling with try/catch"],
    remaining: ["Input validation with zod"],
    inProgress: "Adding zod schema",
    blockers: [],
  },
};

describe("Token Estimator", () => {
  it("should estimate tokens as ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("Hello, world!")).toBe(4); // 13 chars -> ceil(13/4) = 4
  });

  it("should check budget correctly", () => {
    expect(fitsInBudget("abcd", 1)).toBe(true);
    expect(fitsInBudget("abcde", 1)).toBe(false);
    expect(fitsInBudget("abcde", 2)).toBe(true);
  });
});

describe("Compression Engine", () => {
  describe("buildLayers", () => {
    it("should create all 7 priority layers", () => {
      const layers = buildLayers(mockSession);
      expect(layers).toHaveLength(7);
      const names = layers.map(l => l.name);
      expect(names).toContain("TASK STATE");
      expect(names).toContain("ACTIVE FILES");
      expect(names).toContain("DECISIONS & BLOCKERS");
      expect(names).toContain("PROJECT CONTEXT");
      expect(names).toContain("SESSION OVERVIEW");
      expect(names).toContain("RECENT MESSAGES");
      expect(names).toContain("FULL HISTORY");
    });

    it("should always include priority 1 (task state) with correct content", () => {
      const layers = buildLayers(mockSession);
      const taskLayer = layers.find(l => l.name === "TASK STATE")!;
      expect(taskLayer.priority).toBe(1);
      expect(taskLayer.content).toContain("Add error handling and input validation");
      expect(taskLayer.content).toContain("Error handling with try/catch");
      expect(taskLayer.content).toContain("Adding zod schema");
      expect(taskLayer.tokens).toBeGreaterThan(0);
    });

    it("should include file diffs in active files layer", () => {
      const layers = buildLayers(mockSession);
      const filesLayer = layers.find(l => l.name === "ACTIVE FILES")!;
      expect(filesLayer.content).toContain("src/api/nutrition.ts");
      expect(filesLayer.content).toContain("added try/catch");
    });

    it("should include decisions and blockers", () => {
      const layers = buildLayers(mockSession);
      const layer = layers.find(l => l.name === "DECISIONS & BLOCKERS")!;
      expect(layer.content).toContain("Use zod for validation");
      expect(layer.content).toContain("OAuth token refresh failing intermittently");
    });

    it("should assign correct priorities", () => {
      const layers = buildLayers(mockSession);
      const sorted = [...layers].sort((a, b) => a.priority - b.priority);
      expect(sorted.map(l => l.name)).toEqual([
        "TASK STATE",
        "ACTIVE FILES",
        "DECISIONS & BLOCKERS",
        "PROJECT CONTEXT",
        "SESSION OVERVIEW",
        "RECENT MESSAGES",
        "FULL HISTORY",
      ]);
    });
  });

  describe("compress", () => {
    it("should fit within the token budget", () => {
      const result = compress(mockSession, { targetTokens: 5000 });
      expect(result.totalTokens).toBeLessThanOrEqual(5000);
    });

    it("should include higher priority layers first", () => {
      const result = compress(mockSession, { targetTokens: 5000 });
      // Task state (priority 1) should always be included
      expect(result.includedLayers).toContain("TASK STATE");
      // If something is dropped, it should be lower priority
      if (result.droppedLayers.length > 0) {
        const layers = buildLayers(mockSession);
        const includedPriorities = result.includedLayers.map(name =>
          layers.find(l => l.name === name)!.priority
        );
        const droppedPriorities = result.droppedLayers.map(name =>
          layers.find(l => l.name === name)!.priority
        );
        const maxIncluded = Math.max(...includedPriorities);
        const minDropped = Math.min(...droppedPriorities);
        expect(minDropped).toBeGreaterThanOrEqual(maxIncluded);
      }
    });

    it("should report dropped layers when budget is small", () => {
      // Very small budget should drop some layers
      const result = compress(mockSession, { targetTokens: 600 });
      expect(result.droppedLayers.length).toBeGreaterThan(0);
      // Task state should still be included (priority 1, small)
      expect(result.includedLayers).toContain("TASK STATE");
    });

    it("should include all layers when budget is large", () => {
      const result = compress(mockSession, { targetTokens: 100_000 });
      expect(result.droppedLayers).toHaveLength(0);
      expect(result.includedLayers).toHaveLength(7);
    });

    it("should use default budget from registry when no targetTokens", () => {
      // "file" target defaults to 19000 tokens
      const result = compress(mockSession, {});
      expect(result.totalTokens).toBeLessThanOrEqual(19000);
    });
  });
});
