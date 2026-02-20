import path from "node:path";
import type { AgentId, CapturedSession, CompressionResult } from "../types/index.js";

const TARGET_HINTS: Record<string, { label: string; footer: string }> = {
  cursor: {
    label: "Cursor (paste into Composer)",
    footer: "Paste this into Cursor's Composer to continue.",
  },
  codex: {
    label: "Codex CLI",
    footer: "Feed this to Codex CLI with `codex resume` or paste it.",
  },
  "claude-code": {
    label: "Claude Code",
    footer: "Paste this into a new Claude Code session to continue.",
  },
};

/**
 * Builds the self-summarizing resume prompt (RESUME.md).
 * Uses the compressed session data to generate a structured handoff document.
 */
export function buildResumePrompt(
  session: CapturedSession,
  compressed: CompressionResult,
  targetAgent?: AgentId | "clipboard" | "file"
): string {
  const projectName =
    session.project.name || path.basename(session.project.path);
  const gitBranch = session.project.gitBranch || "unknown";

  const completedList =
    session.task.completed.length > 0
      ? session.task.completed.map((item) => `- ${item}`).join("\n")
      : "- None yet";

  const inProgressText =
    session.task.inProgress || "See remaining items";

  const remainingList =
    session.task.remaining.length > 0
      ? session.task.remaining.map((item) => `- ${item}`).join("\n")
      : "- None";

  const resumeAction =
    session.task.inProgress ||
    session.task.remaining[0] ||
    "the next logical step";

  const targetHint = targetAgent && TARGET_HINTS[targetAgent]
    ? TARGET_HINTS[targetAgent]
    : null;

  const lines: string[] = [
    `# Braindump — Session Handoff`,
    ``,
    `> **Source:** ${session.source} | **Captured:** ${session.capturedAt}`,
    `> **Project:** ${projectName} (${session.project.path}) | Branch: \`${gitBranch}\``,
    ...(targetHint ? [`> **Target:** ${targetHint.label}`] : []),
    ``,
    `---`,
    ``,
    `## Instructions for Resuming Agent`,
    ``,
    `You are continuing a task that was started in a previous ${session.source} session.`,
    `The previous session ended (likely due to token/rate limits).`,
    ``,
    `**Your job:**`,
    `1. Read ALL the context below carefully and silently internalize it`,
    `2. Do NOT summarize what you read back to the user`,
    `3. Do NOT re-debate any decisions listed in "Key Decisions"`,
    `4. Do NOT re-introduce yourself or ask if the user wants to continue`,
    `5. Pick up EXACTLY where the previous agent left off`,
    `6. Your first action should be to continue the in-progress work described below`,
    ``,
    `---`,
    ``,
    `## Current Task`,
    ``,
    `**Goal:** ${session.task.description}`,
    ``,
    `**Completed:**`,
    completedList,
    ``,
    `**In Progress (continue this immediately):**`,
    inProgressText,
    ``,
    `**Remaining:**`,
    remainingList,
    ``,
    `---`,
    ``,
    compressed.content,
    ``,
    ...(session.toolActivity && session.toolActivity.length > 0
      ? [
          `---`,
          ``,
          `## Tool Activity`,
          ``,
          ...session.toolActivity.map((t) => {
            const samplesStr = t.samples.length > 0
              ? t.samples.map((s) => `\`${s}\``).join(" . ")
              : "";
            return `- **${t.name}** (x${t.count})${samplesStr ? ": " + samplesStr : ""}`;
          }),
          ``,
        ]
      : []),
    `---`,
    ``,
    `## Resume Now`,
    ``,
    `Continue the work described above. Start with ${resumeAction}.`,
    `Do not ask for confirmation. Do not summarize. Just continue building.`,
    ``,
    targetHint ? targetHint.footer : "Paste into your target agent.",
  ];

  return lines.join("\n");
}
