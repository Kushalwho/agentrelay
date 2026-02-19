#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgents, autoDetectSource, getAdapter } from "../adapters/index.js";
import { compress } from "../core/compression.js";
import { extractProjectContext } from "../core/project-context.js";
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
      console.log();
      for (const r of results) {
        if (r.detected) {
          console.log(`  ${chalk.green("+")} ${chalk.bold(r.agentId)} ${chalk.dim(r.path)}`);
        } else {
          console.log(`  ${chalk.red("-")} ${chalk.dim(r.agentId)} ${chalk.dim(r.path)}`);
        }
      }
      console.log();
      if (!results.some((r) => r.detected)) {
        console.log(chalk.yellow("No agents detected. Install Claude Code, Cursor, or Codex CLI."));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red("Failed to detect agents:"), (err as Error).message);
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

        console.log(`\n  ${chalk.bold(AGENT_REGISTRY[agentId].name)}:`);
        const toShow = sessions.slice(0, limit - totalShown);
        for (const s of toShow) {
          const idShort = chalk.cyan(s.id.slice(0, 12));
          const date = chalk.dim(s.lastActiveAt || s.startedAt || "unknown");
          const msgs = s.messageCount != null ? chalk.yellow(`(${s.messageCount} msgs)`) : "";
          console.log(`    ${idShort}  ${date}  ${msgs}`);
          if (s.preview) {
            console.log(`    ${chalk.dim("└─")} ${s.preview.substring(0, 80)}`);
          }
          totalShown++;
        }
        if (totalShown >= limit) break;
      }
      console.log();

      if (totalShown === 0) {
        console.log(chalk.yellow("No sessions found."));
      }
    } catch (err) {
      console.error(chalk.red("Failed to list sessions:"), (err as Error).message);
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
        console.error(chalk.red("No agent detected."), "Use --source to specify one.");
        process.exit(1);
      }
      console.log(`Capturing from ${chalk.bold(adapter.agentId)}...`);

      const session = options.session
        ? await adapter.capture(options.session)
        : await adapter.captureLatest(projectPath);

      // Enrich with project context
      const context = await extractProjectContext(projectPath);
      session.project = { ...session.project, ...context };

      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      writeFileSync(join(handoffDir, "session.json"), JSON.stringify(session, null, 2));

      console.log(chalk.green("Captured:"), `${session.conversation.messageCount} messages, ~${session.conversation.estimatedTokens} tokens`);
      console.log(chalk.dim(`Written to ${join(handoffDir, "session.json")}`));
    } catch (err) {
      console.error(chalk.red("Capture error:"), (err as Error).message);
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
          console.error(chalk.red(`Unknown source agent: ${options.source}`));
          process.exit(1);
        }
      } else {
        console.log(chalk.dim("Auto-detecting source agent..."));
        adapter = await autoDetectSource(projectPath);
        if (!adapter) {
          console.error(chalk.red("No source agent detected."), "Use --source to specify one.");
          process.exit(1);
        }
        console.log(`  Source: ${chalk.bold(adapter.agentId)}`);
      }

      // 2. Capture session
      let session;
      console.log(chalk.dim("Capturing session..."));
      try {
        if (options.session) {
          session = await adapter.capture(options.session);
        } else {
          session = await adapter.captureLatest(projectPath);
        }
      } catch (err) {
        console.error(chalk.red("Failed to capture session:"), (err as Error).message);
        process.exit(3);
      }

      // 3. Enrich with project context (git, tree, memory files)
      console.log(chalk.dim("Enriching with project context..."));
      const context = await extractProjectContext(projectPath);
      session.project = { ...session.project, ...context };

      // 4. Compress
      const targetTokens = options.tokens
        ? parseInt(options.tokens, 10)
        : undefined;
      const target = (options.target as AgentId | "clipboard" | "file") || "file";
      console.log(chalk.dim("Compressing..."));
      const compressed = compress(session, { targetTokens, targetAgent: target });

      // 5. Build resume prompt
      const resume = buildResumePrompt(session, compressed);

      // 6. Write to .handoff/
      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      const outputPath = join(handoffDir, "RESUME.md");
      writeFileSync(outputPath, resume);
      writeFileSync(join(handoffDir, "session.json"), JSON.stringify(session, null, 2));

      // 7. Try clipboard copy
      let clipboardOk = false;
      try {
        const { default: clipboard } = await import("clipboardy");
        await clipboard.write(resume);
        clipboardOk = true;
      } catch {
        // Clipboard not available
      }

      // 8. Print results
      const budget = targetTokens || getUsableTokenBudget(target);
      const pct = Math.round((compressed.totalTokens / budget) * 100);
      console.log();
      console.log(chalk.green.bold("  Handoff complete!"));
      console.log();
      console.log(`  ${chalk.dim("Source:")}     ${adapter.agentId}`);
      console.log(`  ${chalk.dim("Session:")}    ${session.sessionId.slice(0, 12)}`);
      console.log(`  ${chalk.dim("Branch:")}     ${session.project.gitBranch || "unknown"}`);
      console.log(`  ${chalk.dim("Messages:")}   ${session.conversation.messageCount}`);
      console.log(`  ${chalk.dim("Tokens:")}     ${compressed.totalTokens} / ${budget} ${chalk.dim(`(${pct}%)`)}`);
      console.log(`  ${chalk.dim("Included:")}   ${compressed.includedLayers.join(", ")}`);
      if (compressed.droppedLayers.length > 0) {
        console.log(`  ${chalk.dim("Dropped:")}    ${chalk.yellow(compressed.droppedLayers.join(", "))}`);
      }
      console.log(`  ${chalk.dim("Output:")}     ${outputPath}`);
      if (clipboardOk) {
        console.log(`  ${chalk.dim("Clipboard:")}  ${chalk.green("copied!")}`);
      }
      console.log();
    } catch (err) {
      console.error(chalk.red("Handoff failed:"), (err as Error).message);
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
      console.log(chalk.dim(`Reading ${filePath}...`));
      const raw = readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);

      const targetTokens = options.tokens ? parseInt(options.tokens, 10) : undefined;
      const target = (options.target || "file") as AgentId | "clipboard" | "file";

      const compressed = compress(session, { targetTokens, targetAgent: target });
      const resume = buildResumePrompt(session, compressed);

      const handoffDir = join(process.cwd(), ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      const outputPath = join(handoffDir, "RESUME.md");
      writeFileSync(outputPath, resume);

      console.log(chalk.green("Resume regenerated:"), `${compressed.totalTokens} tokens`);
      console.log(chalk.dim(`Written to ${outputPath}`));
    } catch (err) {
      console.error(chalk.red("Resume error:"), (err as Error).message);
      process.exit(3);
    }
  });

// --- info ---
program
  .command("info")
  .description("Show agent storage paths, context window sizes, and config")
  .action(async () => {
    const platform = process.platform as string;
    console.log(`\n  ${chalk.bold("AgentRelay")} ${chalk.dim("v0.1.0")} ${chalk.dim(`(${platform})`)}\n`);
    for (const meta of Object.values(AGENT_REGISTRY)) {
      const storagePath = meta.storagePaths[platform] || "N/A";
      console.log(`  ${chalk.bold(meta.name)} ${chalk.dim(`(${meta.id})`)}`);
      console.log(`    ${chalk.dim("Storage:")}        ${storagePath}`);
      console.log(`    ${chalk.dim("Context window:")} ${meta.contextWindow.toLocaleString()} tokens`);
      console.log(`    ${chalk.dim("Usable budget:")}  ${meta.usableTokens.toLocaleString()} tokens`);
      console.log(`    ${chalk.dim("Memory files:")}   ${meta.memoryFiles.join(", ")}`);
      console.log();
    }
  });

program.parse();
