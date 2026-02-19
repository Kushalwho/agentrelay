#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detectAgents, autoDetectSource, getAdapter } from "../adapters/index.js";
import { compress } from "../core/compression.js";
import { extractProjectContext } from "../core/project-context.js";
import { buildResumePrompt } from "../core/prompt-builder.js";
import { AGENT_REGISTRY, getUsableTokenBudget } from "../core/registry.js";
import { Watcher } from "../core/watcher.js";
import type { AgentId, WatcherEvent } from "../types/index.js";

// --- verbose logger ---
let verbose = false;
function debug(...args: unknown[]) {
  if (verbose) {
    console.log(chalk.dim("[debug]"), ...args);
  }
}

/**
 * Resolve the output path for RESUME.md.
 * - If path is a directory or ends with `/`, write RESUME.md inside it.
 * - Otherwise treat as a file path.
 */
function resolveOutputPath(outputFlag: string | undefined, projectPath: string): { resumePath: string; sessionDir: string } {
  if (!outputFlag) {
    const handoffDir = join(projectPath, ".handoff");
    return { resumePath: join(handoffDir, "RESUME.md"), sessionDir: handoffDir };
  }

  const isDir = outputFlag.endsWith("/") || outputFlag.endsWith("\\") ||
    (existsSync(outputFlag) && lstatSync(outputFlag).isDirectory());

  if (isDir) {
    return { resumePath: join(outputFlag, "RESUME.md"), sessionDir: outputFlag };
  }

  return { resumePath: outputFlag, sessionDir: dirname(outputFlag) };
}

const program = new Command();

program
  .name("agentrelay")
  .description(
    "Capture your AI coding agent session and continue in a different agent."
  )
  .version("0.3.0");

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
  .option("-v, --verbose", "Show detailed debug output")
  .action(async (options) => {
    try {
      if (options.verbose) verbose = true;
      const projectPath = options.project || process.cwd();

      // 1. Detect source
      let spinner = ora("Detecting source agent...").start();
      const adapter = options.source
        ? getAdapter(options.source as AgentId)
        : await autoDetectSource(projectPath);

      if (!adapter) {
        spinner.fail("No agent detected.");
        console.error("Use --source to specify one.");
        process.exit(1);
      }
      spinner.succeed(`Source: ${adapter.agentId}`);

      // 2. Capture session
      spinner = ora("Capturing session...").start();
      const session = options.session
        ? await adapter.capture(options.session)
        : await adapter.captureLatest(projectPath);
      spinner.succeed(`Captured ${session.conversation.messageCount} messages`);

      // 3. Enrich with project context
      spinner = ora("Enriching with project context...").start();
      const context = await extractProjectContext(projectPath);
      session.project = { ...session.project, ...context };
      spinner.succeed("Project context enriched");

      // 4. Write output
      spinner = ora("Writing session file...").start();
      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      writeFileSync(join(handoffDir, "session.json"), JSON.stringify(session, null, 2));
      spinner.succeed(`Written to ${join(handoffDir, "session.json")}`);

      console.log();
      console.log(`  ${chalk.dim("Messages:")}  ${session.conversation.messageCount}`);
      console.log(`  ${chalk.dim("Tokens:")}    ~${session.conversation.estimatedTokens}`);
      console.log();
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
  .option("--dry-run", "Preview what would be captured without writing files")
  .option("--no-clipboard", "Skip clipboard copy")
  .option("-o, --output <path>", "Custom output path for RESUME.md")
  .option("-v, --verbose", "Show detailed debug output")
  .action(async (options) => {
    try {
      if (options.verbose) verbose = true;
      const projectPath = options.project || process.cwd();
      debug("Project path:", projectPath);

      // 1. Determine source adapter
      let spinner = ora("Detecting source agent...").start();
      let adapter;
      if (options.source) {
        debug("Using explicit source:", options.source);
        adapter = getAdapter(options.source as AgentId);
        if (!adapter) {
          spinner.fail(`Unknown source agent: ${options.source}`);
          process.exit(1);
        }
        spinner.succeed(`Source: ${adapter.agentId}`);
      } else {
        debug("Auto-detecting source agent...");
        adapter = await autoDetectSource(projectPath);
        if (!adapter) {
          spinner.fail("No source agent detected.");
          console.error("Use --source to specify one.");
          process.exit(1);
        }
        spinner.succeed(`Source: ${adapter.agentId}`);
      }

      // 2. Capture session
      let session;
      spinner = ora("Capturing session...").start();
      try {
        if (options.session) {
          session = await adapter.capture(options.session);
        } else {
          session = await adapter.captureLatest(projectPath);
        }
        spinner.succeed(`Captured ${session.conversation.messageCount} messages`);
        debug("Session ID:", session.sessionId);
        debug("Estimated tokens:", session.conversation.estimatedTokens);
      } catch (err) {
        spinner.fail("Failed to capture session");
        console.error((err as Error).message);
        process.exit(3);
      }

      // 3. Enrich with project context (git, tree, memory files)
      spinner = ora("Enriching with project context...").start();
      const context = await extractProjectContext(projectPath);
      session.project = { ...session.project, ...context };
      debug("Git branch:", context.gitBranch || "none");
      debug("Memory files:", context.memoryFileContents ? "found" : "none");
      spinner.succeed("Project context enriched");

      // 4. Compress
      const targetTokens = options.tokens
        ? parseInt(options.tokens, 10)
        : undefined;
      const target = (options.target as AgentId | "clipboard" | "file") || "file";
      debug("Target:", target, "| Token budget:", targetTokens || "auto");
      spinner = ora("Compressing...").start();
      const compressed = compress(session, { targetTokens, targetAgent: target });
      spinner.succeed(`Compressed to ${compressed.totalTokens} tokens`);
      debug("Included layers:", compressed.includedLayers.join(", "));
      if (compressed.droppedLayers.length > 0) {
        debug("Dropped layers:", compressed.droppedLayers.join(", "));
      }

      // 5. Build resume prompt
      const resume = buildResumePrompt(session, compressed, target);

      // 6. Print results
      const budget = targetTokens || getUsableTokenBudget(target);
      const pct = Math.round((compressed.totalTokens / budget) * 100);

      if (options.dryRun) {
        console.log();
        console.log(chalk.yellow.bold("  Dry run — no files written"));
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
        console.log(`  ${chalk.dim("Target:")}     ${target}`);
        console.log(`  ${chalk.dim("Resume:")}     ${resume.length} chars`);
        console.log();
        return;
      }

      // 7. Write to .handoff/ (or custom --output path)
      spinner = ora("Writing handoff files...").start();
      const { resumePath: outputPath, sessionDir } = resolveOutputPath(options.output, projectPath);
      mkdirSync(sessionDir, { recursive: true });
      debug("Output path:", outputPath);
      debug("Session dir:", sessionDir);
      writeFileSync(outputPath, resume);
      writeFileSync(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

      // 8. Try clipboard copy (unless --no-clipboard)
      let clipboardOk = false;
      if (options.clipboard !== false) {
        try {
          const { default: clipboard } = await import("clipboardy");
          await clipboard.write(resume);
          clipboardOk = true;
        } catch {
          debug("Clipboard not available — skipping copy");
        }
      } else {
        debug("Clipboard copy skipped (--no-clipboard)");
      }
      spinner.succeed(`Written to ${outputPath}`);

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
      if (options.clipboard === false) {
        console.log(`  ${chalk.dim("Clipboard:")}  ${chalk.dim("skipped")}`);
      } else if (clipboardOk) {
        console.log(`  ${chalk.dim("Clipboard:")}  ${chalk.green("copied!")}`);
      } else {
        console.log(`  ${chalk.dim("Clipboard:")}  ${chalk.yellow("unavailable")} ${chalk.dim("(copy .handoff/RESUME.md manually)")}`);
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
  .description("Watch agent sessions for changes and rate limits")
  .option("--agents <csv>", "Comma-separated list of agents to watch")
  .option("--interval <seconds>", "Polling interval in seconds", "30")
  .option("-p, --project <path>", "Only watch sessions for this project")
  .action(async (options) => {
    const watcher = new Watcher();

    const agents = options.agents
      ? (options.agents.split(",").map((s: string) => s.trim()) as AgentId[])
      : undefined;
    const interval = parseInt(options.interval, 10) * 1000;

    const formatEvent = (event: WatcherEvent) => {
      const time = chalk.dim(new Date(event.timestamp).toLocaleTimeString());
      const agent = chalk.cyan(event.agentId);
      const sid = event.sessionId ? chalk.dim(` ${event.sessionId.slice(0, 12)}`) : "";
      switch (event.type) {
        case "new-session":
          console.log(`  ${time} ${chalk.green("+")} ${agent}${sid} new session`);
          break;
        case "session-update":
          console.log(`  ${time} ${chalk.blue("~")} ${agent}${sid} ${chalk.dim(event.details || "updated")}`);
          break;
        case "rate-limit":
          console.log(`  ${time} ${chalk.red("!")} ${agent}${sid} ${chalk.red("possible rate limit")} — run ${chalk.bold("agentrelay handoff")} to switch`);
          break;
        case "idle":
          break; // Don't spam idle events
      }
    };

    let spinner = ora("Starting watcher...").start();
    try {
      await watcher.start({
        agents,
        interval,
        projectPath: options.project,
        onEvent: formatEvent,
      });

      const state = watcher.getState()!;
      const sessionCount = Object.keys(state.activeSessions).length;
      spinner.succeed(`Watching ${state.agents.join(", ")} (${sessionCount} sessions, ${options.interval}s interval)`);
      console.log(chalk.dim("  Press Ctrl+C to stop.\n"));

      const shutdown = async () => {
        console.log();
        spinner = ora("Stopping watcher...").start();
        await watcher.stop();
        spinner.succeed("Watcher stopped.");
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());

      // Keep the process alive
      await new Promise(() => {});
    } catch (err) {
      spinner.fail("Watcher failed");
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
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
      if (!existsSync(filePath)) {
        console.error(chalk.red("File not found:"), filePath);
        console.error(chalk.dim("Run 'agentrelay capture' first, or use --file to specify a path."));
        process.exit(1);
      }
      console.log(chalk.dim(`Reading ${filePath}...`));
      const raw = readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);

      const targetTokens = options.tokens ? parseInt(options.tokens, 10) : undefined;
      const target = (options.target || "file") as AgentId | "clipboard" | "file";

      const compressed = compress(session, { targetTokens, targetAgent: target });
      const resume = buildResumePrompt(session, compressed, target);

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
    console.log(`\n  ${chalk.bold("AgentRelay")} ${chalk.dim("v0.3.0")} ${chalk.dim(`(${platform})`)}\n`);
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
