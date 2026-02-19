import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoDetectSource, getAllAdapters } from "../../src/adapters/index.js";
import type { AgentAdapter, AgentId, SessionInfo } from "../../src/types/index.js";

describe("autoDetectSource", () => {
  const adapters = getAllAdapters();

  beforeEach(() => {
    for (const adapter of adapters) {
      vi.spyOn(adapter, "detect").mockResolvedValue(true);
      vi.spyOn(adapter, "listSessions").mockResolvedValue([]);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should select the adapter with the most recent session activity", async () => {
    vi.mocked(adapterById("claude-code").listSessions).mockResolvedValue([
      session("claude-1", { lastActiveAt: "2026-02-19T20:00:00Z" }),
    ]);
    vi.mocked(adapterById("cursor").listSessions).mockResolvedValue([
      session("cursor-1", { lastActiveAt: "2026-02-19T21:00:00Z" }),
    ]);
    vi.mocked(adapterById("codex").listSessions).mockResolvedValue([
      session("codex-1", { lastActiveAt: "2026-02-19T22:00:00Z" }),
    ]);

    const detected = await autoDetectSource("/tmp/project-a");

    expect(detected?.agentId).toBe("codex");
    expect(adapterById("claude-code").listSessions).toHaveBeenCalledWith("/tmp/project-a");
    expect(adapterById("cursor").listSessions).toHaveBeenCalledWith("/tmp/project-a");
    expect(adapterById("codex").listSessions).toHaveBeenCalledWith("/tmp/project-a");
  });

  it("should fall back to the first detected adapter when no sessions exist", async () => {
    vi.spyOn(adapterById("claude-code"), "detect").mockResolvedValue(true);
    vi.spyOn(adapterById("cursor"), "detect").mockResolvedValue(false);
    vi.spyOn(adapterById("codex"), "detect").mockResolvedValue(true);

    const detected = await autoDetectSource("/tmp/no-sessions");

    expect(detected?.agentId).toBe("claude-code");
  });

  it("should ignore adapters that error and use startedAt when lastActiveAt is missing", async () => {
    vi.spyOn(adapterById("claude-code"), "detect").mockRejectedValue(
      new Error("claude unavailable"),
    );
    vi.mocked(adapterById("cursor").listSessions).mockResolvedValue([
      session("cursor-1", { startedAt: "2026-02-19T22:00:00Z" }),
    ]);
    vi.mocked(adapterById("codex").listSessions).mockResolvedValue([
      session("codex-1", { startedAt: "2026-02-19T21:00:00Z" }),
    ]);

    const detected = await autoDetectSource();

    expect(detected?.agentId).toBe("cursor");
  });
});

function adapterById(agentId: AgentId): AgentAdapter {
  const adapter = getAllAdapters().find((candidate) => candidate.agentId === agentId);
  if (!adapter) {
    throw new Error(`Missing adapter: ${agentId}`);
  }
  return adapter;
}

function session(
  id: string,
  partial: Pick<SessionInfo, "lastActiveAt" | "startedAt">,
): SessionInfo {
  return { id, ...partial };
}
