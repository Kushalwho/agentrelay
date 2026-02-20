import type {
  CapturedSession,
  CompressionOptions,
  CompressionResult,
  PriorityLayer,
} from "../types/index.js";
import { estimateTokens } from "./token-estimator.js";
import { getUsableTokenBudget } from "./registry.js";

/**
 * Build all priority layers from a captured session.
 */
export function buildLayers(session: CapturedSession): PriorityLayer[] {
  const layers: PriorityLayer[] = [];

  // Priority 1: TASK STATE
  {
    const lines: string[] = ["## TASK STATE"];
    lines.push(`**Description:** ${session.task.description}`);
    if (session.task.completed.length > 0) {
      lines.push(`**Completed:** ${session.task.completed.join(", ")}`);
    }
    if (session.task.inProgress) {
      lines.push(`**In Progress:** ${session.task.inProgress}`);
    }
    if (session.task.remaining.length > 0) {
      lines.push(`**Remaining:** ${session.task.remaining.join(", ")}`);
    }
    if (session.task.blockers.length > 0) {
      lines.push(`**Blockers:** ${session.task.blockers.join(", ")}`);
    }
    const content = lines.join("\n");
    layers.push({ name: "TASK STATE", priority: 1, content, tokens: estimateTokens(content) });
  }

  // Priority 2: ACTIVE FILES
  {
    const lines: string[] = ["## ACTIVE FILES"];
    const files = session.filesChanged.slice(0, 15);
    for (const file of files) {
      lines.push(`- \`${file.path}\` (${file.changeType})`);
      if (file.diff) {
        const truncatedDiff = file.diff.length > 2000 ? file.diff.slice(0, 2000) + "..." : file.diff;
        lines.push("```" + (file.language || ""));
        lines.push(truncatedDiff);
        lines.push("```");
      }
    }
    const content = lines.join("\n");
    layers.push({ name: "ACTIVE FILES", priority: 2, content, tokens: estimateTokens(content) });
  }

  // Priority 3: DECISIONS & BLOCKERS
  {
    const lines: string[] = ["## DECISIONS & BLOCKERS"];
    if (session.decisions.length > 0) {
      lines.push("**Decisions:**");
      for (const d of session.decisions) {
        lines.push(`- ${d}`);
      }
    }
    if (session.blockers.length > 0) {
      lines.push("**Blockers:**");
      for (const b of session.blockers) {
        lines.push(`- ${b}`);
      }
    }
    const content = lines.join("\n");
    layers.push({ name: "DECISIONS & BLOCKERS", priority: 3, content, tokens: estimateTokens(content) });
  }

  // Priority 4: PROJECT CONTEXT
  {
    const lines: string[] = ["## PROJECT CONTEXT"];
    lines.push(`**Path:** ${session.project.path}`);
    if (session.project.name) {
      lines.push(`**Name:** ${session.project.name}`);
    }
    if (session.project.gitBranch) {
      lines.push(`**Branch:** ${session.project.gitBranch}`);
    }
    if (session.project.gitStatus) {
      lines.push(`**Git Status:** ${session.project.gitStatus}`);
    }
    if (session.project.structure) {
      const structureLines = session.project.structure.split("\n");
      const truncated = structureLines.slice(0, 40).join("\n");
      lines.push("**Structure:**");
      lines.push("```");
      lines.push(truncated);
      lines.push("```");
    }
    if (session.project.memoryFileContents) {
      const mem = session.project.memoryFileContents.length > 2000
        ? session.project.memoryFileContents.slice(0, 2000) + "..."
        : session.project.memoryFileContents;
      lines.push("**Memory File:**");
      lines.push(mem);
    }
    const content = lines.join("\n");
    layers.push({ name: "PROJECT CONTEXT", priority: 4, content, tokens: estimateTokens(content) });
  }

  // Priority 4.5: TOOL ACTIVITY
  if (session.toolActivity && session.toolActivity.length > 0) {
    const lines: string[] = ["## TOOL ACTIVITY"];
    for (const tool of session.toolActivity) {
      const samplesStr = tool.samples.length > 0
        ? tool.samples.map((s) => `\`${s}\``).join(" . ")
        : "";
      lines.push(`- **${tool.name}** (x${tool.count})${samplesStr ? ": " + samplesStr : ""}`);
    }
    const content = lines.join("\n");
    layers.push({ name: "TOOL ACTIVITY", priority: 4.5, content, tokens: estimateTokens(content) });
  }

  // Priority 5: SESSION OVERVIEW
  {
    const lines: string[] = ["## SESSION OVERVIEW"];
    lines.push(`**Messages:** ${session.conversation.messageCount}`);
    lines.push(`**Estimated Tokens:** ${session.conversation.estimatedTokens}`);
    const messages = session.conversation.messages;
    const firstUser = messages.find(m => m.role === "user");
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    if (firstUser) {
      lines.push(`**First User Message:** ${firstUser.content}`);
    }
    if (lastUser && lastUser !== firstUser) {
      lines.push(`**Last User Message:** ${lastUser.content}`);
    }
    const toolNames = new Set(
      messages.filter(m => m.toolName).map(m => m.toolName!)
    );
    if (toolNames.size > 0) {
      lines.push(`**Tools Used:** ${[...toolNames].join(", ")}`);
    }
    const content = lines.join("\n");
    layers.push({ name: "SESSION OVERVIEW", priority: 5, content, tokens: estimateTokens(content) });
  }

  // Priority 6: RECENT MESSAGES (last 20)
  {
    const messages = session.conversation.messages;
    const recent = messages.slice(-20);
    const lines: string[] = ["## RECENT MESSAGES"];
    for (const msg of recent) {
      const truncated = msg.content.length > 1000 ? msg.content.slice(0, 1000) + "..." : msg.content;
      const tool = msg.toolName ? ` [${msg.toolName}]` : "";
      lines.push(`**${msg.role}${tool}:** ${truncated}`);
    }
    const content = lines.join("\n");
    layers.push({ name: "RECENT MESSAGES", priority: 6, content, tokens: estimateTokens(content) });
  }

  // Priority 7: FULL HISTORY (older messages beyond last 20)
  {
    const messages = session.conversation.messages;
    const olderCount = Math.max(0, messages.length - 20);
    if (olderCount > 0) {
      const older = messages.slice(0, olderCount);
      const lines: string[] = ["## FULL HISTORY"];
      for (const msg of older) {
        const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
        const tool = msg.toolName ? ` [${msg.toolName}]` : "";
        lines.push(`**${msg.role}${tool}:** ${truncated}`);
      }
      const content = lines.join("\n");
      layers.push({ name: "FULL HISTORY", priority: 7, content, tokens: estimateTokens(content) });
    } else {
      layers.push({ name: "FULL HISTORY", priority: 7, content: "## FULL HISTORY\nNo older messages.", tokens: estimateTokens("## FULL HISTORY\nNo older messages.") });
    }
  }

  return layers;
}

/**
 * Compression engine using priority-layered packing.
 * Takes a CapturedSession and a token budget, produces compressed content.
 */
export function compress(
  session: CapturedSession,
  options: CompressionOptions
): CompressionResult {
  const budget = options.targetTokens || getUsableTokenBudget(options.targetAgent || "file");
  const reservedTokens = 400;
  let remaining = budget - reservedTokens;

  const layers = buildLayers(session);
  layers.sort((a, b) => a.priority - b.priority);

  const includedLayers: string[] = [];
  const droppedLayers: string[] = [];
  const includedContent: string[] = [];

  for (const layer of layers) {
    if (layer.tokens <= remaining) {
      includedContent.push(layer.content);
      includedLayers.push(layer.name);
      remaining -= layer.tokens;
    } else if (layer.priority <= 3 && remaining > 200) {
      // Truncate high-priority layers to fit
      const availableChars = remaining * 4;
      const truncated = layer.content.slice(0, availableChars);
      includedContent.push(truncated);
      includedLayers.push(layer.name);
      remaining = 0;
    } else {
      droppedLayers.push(layer.name);
    }
  }

  const content = includedContent.join("\n\n");
  const totalTokens = estimateTokens(content);

  return { content, totalTokens, includedLayers, droppedLayers };
}
