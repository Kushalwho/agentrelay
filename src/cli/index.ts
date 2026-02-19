#!/usr/bin/env node

import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgents, autoDetectSource, getAdapter } from "../adapters/index.js";
import { compress } from "../core/compression.js";
import { buildResumePrompt } from "../core/prompt-builder.js";
import { AGENT_REGISTRY, getUsableTokenBudget } from "../core/registry.js";
import type { AgentId } from "../types/index.js";

const program = new Command();

program
  .name("agentrelay")
  .description(
    "Capture your AI coding agent session and continue in a different agent."
  )
  .version("0.1.0");

// --- detect ---
program
  .command("detect")
  .description("Scan for installed AI coding agents")
  .action(async () => {
    try {
      const results = await detectAgents();
      for (const r of results) {
        const icon = r.detected ? "+" : "-";
        const status = r.detected ? "detected" : "not found";
        console.log(`  [${icon}] ${r.agentId}: ${status} (${r.path})`);
      }
      if (!results.some((r) => r.detected)) {
        console.log(
          "\nNo agents detected. Install Claude Code, Cursor, or Codex CLI."
        );
        process.exit(1);
      }
    } catch (err) {
      console.error("Failed to detect agents:", (err as Error).message);
      process.exit(1);
    }
  });

// --- list ---
program
  .command("list")
  .description("List recent sessions across detected agents")
  .option("-s, --source <agent>", "Filter by agent (claude-code, cursor, codex)")
  .option("-l, --limit <n>", "Max sessions to show", "10")
  .action(async (options) => {
    try {
      const limit = parseInt(options.limit, 10) || 10;
      const agentIds: AgentId[] = options.source
        ? [options.source as AgentId]
        : (Object.keys(AGENT_REGISTRY) as AgentId[]);

      let totalShown = 0;
      for (const agentId of agentIds) {
        const adapter = getAdapter(agentId);
        if (!adapter) continue;

        let sessions;
        try {
          sessions = await adapter.listSessions();
        } catch {
          continue;
        }

        if (sessions.length === 0) continue;

        console.log(`\n${AGENT_REGISTRY[agentId].name}:`);
        const toShow = sessions.slice(0, limit - totalShown);
        for (const s of toShow) {
          const idShort = s.id.slice(0, 12);
          const date = s.lastActiveAt || s.startedAt || "unknown";
          const msgs = s.messageCount != null ? `${s.messageCount} msgs` : "";
          const preview = s.preview ? ` - ${s.preview}` : "";
          console.log(`  ${idShort}  ${date}  ${msgs}${preview}`);
          totalShown++;
        }
        if (totalShown >= limit) break;
      }

      if (totalShown === 0) {
        console.log("No sessions found.");
      }
    } catch (err) {
      console.error("Failed to list sessions:", (err as Error).message);
      process.exit(2);
    }
  });

// --- capture ---
program
  .command("capture")
  .description("Capture a session into .handoff/session.json")
  .option("-s, --source <agent>", "Source agent")
  .option("--session <id>", "Specific session ID")
  .option("-p, --project <path>", "Project path")
  .action(async (options) => {
    try {
      const projectPath = options.project || process.cwd();
      const adapter = options.source
        ? getAdapter(options.source as AgentId)
        : await autoDetectSource(projectPath);

      if (!adapter) {
        console.error("No agent detected. Use --source to specify one.");
        process.exit(1);
      }
      console.log(`Capturing from ${adapter.agentId}...`);

      const session = options.session
        ? await adapter.capture(options.session)
        : await adapter.captureLatest(projectPath);

      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      writeFileSync(join(handoffDir, "session.json"), JSON.stringify(session, null, 2));

      console.log(`Captured: ${session.conversation.messageCount} messages, ~${session.conversation.estimatedTokens} tokens`);
      console.log(`Written to ${join(handoffDir, "session.json")}`);
    } catch (err) {
      console.error("Capture error:", (err as Error).message);
      process.exit(3);
    }
  });

// --- handoff ---
program
  .command("handoff")
  .description("Full pipeline: capture -> compress -> generate resume -> deliver")
  .option("-s, --source <agent>", "Source agent")
  .option("-t, --target <target>", "Target agent or delivery method", "file")
  .option("--session <id>", "Specific session ID")
  .option("-p, --project <path>", "Project path")
  .option("--tokens <n>", "Token budget override")
  .action(async (options) => {
    try {
      const projectPath = options.project || process.cwd();

      // 1. Determine source adapter
      let adapter;
      if (options.source) {
        adapter = getAdapter(options.source as AgentId);
        if (!adapter) {
          console.error(`Unknown source agent: ${options.source}`);
          process.exit(1);
        }
      } else {
        console.log("Auto-detecting source agent...");
        adapter = await autoDetectSource(projectPath);
        if (!adapter) {
          console.error(
            "No source agent detected. Use --source to specify one."
          );
          process.exit(1);
        }
        console.log(`Detected: ${adapter.agentId}`);
      }

      // 2. Capture session
      let session;
      console.log("Capturing session...");
      try {
        if (options.session) {
          session = await adapter.capture(options.session);
        } else {
          session = await adapter.captureLatest(projectPath);
        }
      } catch (err) {
        console.error("Failed to capture session:", (err as Error).message);
        process.exit(3);
      }

      // 3. Compress
      const targetTokens = options.tokens
        ? parseInt(options.tokens, 10)
        : undefined;
      console.log("Compressing session...");
      const compressed = compress(session, {
        targetTokens,
        targetAgent: (options.target as AgentId | "clipboard" | "file") || "file",
      });

      // 4. Build resume prompt
      console.log("Building resume prompt...");
      const resume = buildResumePrompt(session, compressed);

      // 5. Write to .handoff/RESUME.md
      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      const outputPath = join(handoffDir, "RESUME.md");
      writeFileSync(outputPath, resume);

      // 6. Print stats
      const budget = targetTokens || getUsableTokenBudget(
        (options.target as AgentId | "clipboard" | "file") || "file"
      );
      console.log("\nHandoff complete!");
      console.log(`  Source:     ${adapter.agentId}`);
      console.log(`  Session:    ${session.sessionId}`);
      console.log(`  Tokens:     ${compressed.totalTokens} / ${budget}`);
      console.log(`  Layers:     ${compressed.includedLayers.join(", ")}`);
      if (compressed.droppedLayers.length > 0) {
        console.log(`  Dropped:    ${compressed.droppedLayers.join(", ")}`);
      }
      console.log(`  Output:     ${outputPath}`);

      // 7. Try clipboard copy
      try {
        const { default: clipboard } = await import("clipboardy");
        await clipboard.write(resume);
        console.log("  Clipboard:  copied!");
      } catch {
        // Clipboard not available, that's fine
      }
    } catch (err) {
      console.error("Handoff failed:", (err as Error).message);
      process.exit(3);
    }
  });

// --- watch ---
program
  .command("watch")
  .description("Start background watcher for rate limit detection")
  .option("--agents <csv>", "Comma-separated list of agents to watch")
  .option("--interval <seconds>", "Snapshot interval in seconds", "30")
  .action(async (options) => {
    // TODO: Start watcher
    console.log("watch: not implemented yet");
  });

// --- resume ---
program
  .command("resume")
  .description("Re-generate resume prompt from a captured session.json")
  .option("-t, --target <agent>", "Target agent for formatting")
  .option("--tokens <n>", "Token budget override")
  .option("-f, --file <path>", "Path to session.json")
  .action(async (options) => {
    try {
      const filePath = options.file || join(process.cwd(), ".handoff", "session.json");
      const raw = readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);

      const targetTokens = options.tokens ? parseInt(options.tokens, 10) : undefined;
      const target = (options.target || "file") as AgentId | "clipboard" | "file";

      const compressed = compress(session, { targetTokens, targetAgent: target });
      const resume = buildResumePrompt(session, compressed);

      const handoffDir = join(process.cwd(), ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      writeFileSync(join(handoffDir, "RESUME.md"), resume);

      console.log(`Resume regenerated: ${compressed.totalTokens} tokens`);
      console.log(`Written to ${join(handoffDir, "RESUME.md")}`);
    } catch (err) {
      console.error("Resume error:", (err as Error).message);
      process.exit(3);
    }
  });

// --- info ---
program
  .command("info")
  .description("Show agent storage paths, context window sizes, and config")
  .action(async () => {
    const platform = process.platform as string;
    console.log("AgentRelay - Agent Registry\n");
    for (const meta of Object.values(AGENT_REGISTRY)) {
      const storagePath = meta.storagePaths[platform] || "N/A for this platform";
      console.log(`${meta.name} (${meta.id}):`);
      console.log(`  Storage:        ${storagePath}`);
      console.log(`  Context Window: ${meta.contextWindow.toLocaleString()} tokens`);
      console.log(`  Usable Tokens:  ${meta.usableTokens.toLocaleString()} tokens`);
      console.log(`  Memory Files:   ${meta.memoryFiles.join(", ")}`);
      console.log();
    }
  });

program.parse();
