import { describe, it, expect } from "vitest";
import type { CapturedSession } from "../../src/types/index.js";
import {
  safeValidateSession,
  validateSession,
} from "../../src/core/validation.js";

function validSession(): CapturedSession {
  return {
    version: "1.0",
    source: "claude-code",
    capturedAt: "2026-02-20T12:00:00Z",
    sessionId: "session-1",
    project: {
      path: "/tmp/project",
    },
    conversation: {
      messageCount: 1,
      estimatedTokens: 12,
      messages: [
        {
          role: "user",
          content: "Build feature X",
        },
      ],
    },
    filesChanged: [],
    decisions: [],
    blockers: [],
    task: {
      description: "Build feature X",
      completed: [],
      remaining: [],
      blockers: [],
    },
  };
}

describe("validation", () => {
  it("should validate a correct CapturedSession", () => {
    const result = validateSession(validSession());
    expect(result.sessionId).toBe("session-1");
  });

  it("should reject session with missing required fields", () => {
    const bad = { project: { path: "/tmp/project" } };
    expect(() => validateSession(bad)).toThrow();
  });

  it("should reject session with wrong version", () => {
    const bad = { ...validSession(), version: "2.0" };
    expect(() => validateSession(bad)).toThrow();
  });

  it("should reject invalid message role", () => {
    const bad = validSession() as unknown as {
      conversation: { messages: Array<{ role: string; content: string }> };
    };
    bad.conversation.messages[0].role = "admin";
    expect(() => validateSession(bad)).toThrow();
  });

  it("should reject invalid changeType", () => {
    const bad = {
      ...validSession(),
      filesChanged: [
        {
          path: "src/index.ts",
          changeType: "renamed",
        },
      ],
    };
    expect(() => validateSession(bad)).toThrow();
  });

  it("should accept session with all optional fields omitted", () => {
    const minimal: CapturedSession = {
      version: "1.0",
      source: "codex",
      capturedAt: "2026-02-20T12:00:00Z",
      sessionId: "min-1",
      project: {
        path: "/tmp/min",
      },
      conversation: {
        messageCount: 0,
        estimatedTokens: 0,
        messages: [],
      },
      filesChanged: [],
      decisions: [],
      blockers: [],
      task: {
        description: "Unknown task",
        completed: [],
        remaining: [],
        blockers: [],
      },
    };
    expect(validateSession(minimal).sessionId).toBe("min-1");
  });

  it("should return typed data from validateSession", () => {
    const result = validateSession(validSession());
    const typed: CapturedSession = result;
    expect(typed.source).toBe("claude-code");
  });

  it("should use safeValidateSession without throwing", () => {
    const ok = safeValidateSession(validSession());
    expect(ok.success).toBe(true);

    const bad = safeValidateSession({ nope: true });
    expect(bad.success).toBe(false);
  });
});
