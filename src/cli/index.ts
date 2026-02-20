#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgents, autoDetectSource, getAdapter, getAllAdapters } from "../adapters/index.js";
import { compress } from "../core/compression.js";
import { extractProjectContext } from "../core/project-context.js";
import { buildResumePrompt } from "../core/prompt-builder.js";
import { AGENT_REGISTRY, getUsableTokenBudget } from "../core/registry.js";
import { Watcher } from "../core/watcher.js";
import { launchTool, getInstalledTools } from "../core/launcher.js";
import { getCachedIndex, writeCachedIndex, type CachedSessionEntry } from "../core/session-cache.js";
import type { AgentId, SessionInfo, WatcherEvent } from "../types/index.js";
import {
  resolveOutputPath,
  relativeTime,
  formatBox,
  formatErrorBox,
  hint,
  banner,
  intro,
} from "./utils.js";

// --- verbose logger ---
let verbose = false;
function debug(...args: unknown[]) {
  if (verbose) {
    console.log(chalk.dim("[debug]"), ...args);
  }
}

const program = new Command();

program
  .name("braindump")
  .description(
    "Capture your AI coding agent session and continue in a different agent."
  )
  .version("1.0.0");

// --- supported agents list for error messages ---
function supportedAgentsList(): string {
  return Object.values(AGENT_REGISTRY)
    .map((m) => `  ${chalk.dim("•")} ${m.name} ${chalk.dim(`(${m.storagePaths[process.platform] || m.id})`)}`)
    .join("\n");
}

// --- runHandoff (extracted for default command) ---
async function runHandoff(options: {
  source?: string;
  target?: string;
  session?: string;
  project?: string;
  tokens?: string;
  dryRun?: boolean;
  clipboard?: boolean;
  output?: string;
  verbose?: boolean;
  launch?: boolean;
}) {
  try {
    if (options.verbose) verbose = true;
    const projectPath = options.project || process.cwd();
    debug("Project path:", projectPath);

    // 1. Determine source adapter
    let spinner = ora("Finding your AI agent...").start();
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
        spinner.fail("No agent detected");
        console.log();
        console.log(
          formatErrorBox(
            [
              `${chalk.red.bold("No agent detected")}`,
              "",
              "Braindump couldn't find any AI",
              "coding agents on your system.",
              "",
              "Supported agents:",
              supportedAgentsList(),
              "",
              "Install one and try again.",
            ].join("\n")
          )
        );
        process.exit(1);
      }
      spinner.succeed(`Source: ${adapter.agentId}`);
    }

    if (adapter.agentId === "cursor") {
      console.log(`  ${hint("Close Cursor and run from your project folder for best results.")}`);
    }

    // 2. Capture session
    let session;
    spinner = ora("Reading conversation history...").start();
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
    spinner = ora("Adding project context (git, files)...").start();
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
    spinner = ora("Optimizing for target agent...").start();
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
      const lines = [
        `${chalk.yellow.bold("Dry run — no files written")}`,
        "",
        `${chalk.dim("Source:")}     ${adapter.agentId}`,
        `${chalk.dim("Session:")}    ${session.sessionId.slice(0, 12)}`,
        `${chalk.dim("Branch:")}     ${session.project.gitBranch || "unknown"}`,
        `${chalk.dim("Messages:")}   ${session.conversation.messageCount}`,
        `${chalk.dim("Tokens:")}     ${compressed.totalTokens} / ${budget} ${chalk.dim(`(${pct}%)`)}`,
        `${chalk.dim("Included:")}   ${compressed.includedLayers.join(", ")}`,
      ];
      if (compressed.droppedLayers.length > 0) {
        lines.push(
          `${chalk.dim("Dropped:")}    ${chalk.yellow(compressed.droppedLayers.join(", "))}`
        );
      }
      lines.push(`${chalk.dim("Target:")}     ${target}`);
      lines.push(`${chalk.dim("Resume:")}     ${resume.length} chars`);
      if (session.toolActivity && session.toolActivity.length > 0) {
        lines.push(`${chalk.dim("Tools:")}      ${session.toolActivity.map((t) => `${t.name}(${t.count})`).join(", ")}`);
      }
      console.log();
      console.log(
        formatBox(lines.join("\n"))
      );
      console.log();
      return;
    }

    // 7. Write to .handoff/ (or custom --output path)
    spinner = ora("Saving handoff files...").start();
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

    // Build summary lines
    const summaryLines = [
      `${chalk.green.bold("Handoff complete!")}`,
      "",
      `${chalk.dim("Source:")}     ${adapter.agentId}`,
      `${chalk.dim("Session:")}    ${session.sessionId.slice(0, 12)}`,
      `${chalk.dim("Branch:")}     ${session.project.gitBranch || "unknown"}`,
      `${chalk.dim("Messages:")}   ${session.conversation.messageCount}`,
      `${chalk.dim("Tokens:")}     ${compressed.totalTokens} / ${budget} ${chalk.dim(`(${pct}%)`)}`,
    ];
    if (session.toolActivity && session.toolActivity.length > 0) {
      summaryLines.push(
        `${chalk.dim("Tools:")}      ${session.toolActivity.map((t) => `${t.name}(${t.count})`).join(", ")}`
      );
    }
    if (verbose && compressed.includedLayers.length > 0) {
      summaryLines.push(
        `${chalk.dim("Included:")}   ${compressed.includedLayers.join(", ")}`
      );
    }
    if (verbose && compressed.droppedLayers.length > 0) {
      summaryLines.push(
        `${chalk.dim("Dropped:")}    ${chalk.yellow(compressed.droppedLayers.join(", "))}`
      );
    }
    summaryLines.push(`${chalk.dim("Output:")}     ${outputPath}`);
    if (options.clipboard === false) {
      summaryLines.push(`${chalk.dim("Clipboard:")}  ${chalk.dim("skipped")}`);
    } else if (clipboardOk) {
      summaryLines.push(`${chalk.dim("Clipboard:")}  ${chalk.green("copied!")}`);
    } else {
      summaryLines.push(
        `${chalk.dim("Clipboard:")}  ${chalk.yellow("unavailable")} ${chalk.dim("(copy .handoff/RESUME.md manually)")}`
      );
    }

    console.log();
    console.log(formatBox(summaryLines.join("\n")));
    console.log();

    // 9. Auto-launch target tool if --launch
    if (options.launch && target !== "clipboard" && target !== "file") {
      console.log(`  ${chalk.cyan("Launching")} ${target}...`);
      try {
        launchTool(target as AgentId, resume, { projectPath });
      } catch (err) {
        console.log(`  ${chalk.yellow("Could not launch:")} ${(err as Error).message}`);
      }
    } else {
      console.log(`  ${hint("Paste the clipboard into your target agent to continue")}`);
    }
    console.log();
  } catch (err) {
    console.log();
    console.log(
      formatErrorBox(
        [
          `${chalk.red.bold("Handoff failed")}`,
          "",
          (err as Error).message,
        ].join("\n")
      )
    );
    process.exit(3);
  }
}

// --- interactive TUI ---
async function runInteractiveTUI() {
  let clack: typeof import("@clack/prompts");
  try {
    clack = await import("@clack/prompts");
  } catch {
    // @clack/prompts not installed — fall back to intro
    console.log(intro());
    return;
  }

  clack.intro(chalk.cyan.bold("braindump"));

  const spinner = ora("Loading sessions...").start();

  // Gather sessions from all adapters in parallel
  const allSessions: CachedSessionEntry[] = [];
  const cached = getCachedIndex();
  if (cached) {
    allSessions.push(...cached);
    spinner.succeed(`Found ${allSessions.length} sessions (cached)`);
  } else {
    const adapters = getAllAdapters();
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const detected = await adapter.detect();
        if (!detected) return [];
        const sessions = await adapter.listSessions();
        return sessions.map((s) => ({ ...s, agentId: adapter.agentId }));
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        allSessions.push(...result.value);
      }
    }
    // Sort by recency
    allSessions.sort((a, b) => {
      const aTime = a.lastActiveAt || a.startedAt || "";
      const bTime = b.lastActiveAt || b.startedAt || "";
      return bTime.localeCompare(aTime);
    });
    // Cache for next time
    if (allSessions.length > 0) {
      writeCachedIndex(allSessions);
    }
    spinner.succeed(`Found ${allSessions.length} sessions`);
  }

  if (allSessions.length === 0) {
    clack.outro("No sessions found. Run an AI coding agent first.");
    return;
  }

  // CWD sessions
  const cwd = process.cwd();
  const cwdSessions = allSessions.filter(
    (s) => s.projectPath && s.projectPath.replace(/[\\/]+$/, "") === cwd.replace(/[\\/]+$/, ""),
  );

  if (cwdSessions.length > 0) {
    console.log(`  ${chalk.green(`Found ${cwdSessions.length} sessions in this directory`)}`);
  }

  // Filter step
  const filterChoice = await clack.select({
    message: "Which sessions?",
    options: [
      ...(cwdSessions.length > 0
        ? [{ value: "cwd" as const, label: `This directory (${cwdSessions.length})` }]
        : []),
      { value: "all" as const, label: `All sessions (${allSessions.length})` },
    ],
  });

  if (clack.isCancel(filterChoice)) {
    clack.cancel("Cancelled.");
    return;
  }

  const filteredSessions = filterChoice === "cwd" ? cwdSessions : allSessions;
  const displaySessions = filteredSessions.slice(0, 20);

  // Session picker
  const sessionChoice = await clack.select({
    message: "Pick a session",
    options: displaySessions.map((s) => ({
      value: s,
      label: `[${s.agentId}] ${s.lastActiveAt ? relativeTime(s.lastActiveAt) : "unknown"} ${s.id.slice(0, 12)}`,
      hint: s.preview ? s.preview.slice(0, 60) : undefined,
    })),
  });

  if (clack.isCancel(sessionChoice)) {
    clack.cancel("Cancelled.");
    return;
  }

  const selected = sessionChoice as CachedSessionEntry;

  // Target picker — show installed tools (excluding source)
  const installedTools = getInstalledTools(selected.agentId);
  const targetOptions = [
    { value: "file" as const, label: "File (.handoff/RESUME.md)" },
    { value: "clipboard" as const, label: "Clipboard" },
    ...installedTools.map((t) => ({
      value: t.id,
      label: `${AGENT_REGISTRY[t.id].name} (auto-launch)`,
    })),
  ];

  const targetChoice = await clack.select({
    message: "Target",
    options: targetOptions,
  });

  if (clack.isCancel(targetChoice)) {
    clack.cancel("Cancelled.");
    return;
  }

  const target = targetChoice as string;
  const shouldLaunch = target !== "file" && target !== "clipboard" && installedTools.some((t) => t.id === target);

  // Run handoff
  await runHandoff({
    source: selected.agentId,
    target,
    session: selected.id,
    project: selected.projectPath || cwd,
    launch: shouldLaunch,
  });
}

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
        console.log(
          formatErrorBox(
            [
              `${chalk.red.bold("No agent detected")}`,
              "",
              "Braindump couldn't find any AI",
              "coding agents on your system.",
              "",
              "Supported agents:",
              supportedAgentsList(),
              "",
              "Install one and try again.",
            ].join("\n")
          )
        );
        process.exit(1);
      }
      console.log(`  ${hint("Run 'braindump handoff' to create a handoff")}`);
      console.log();
    } catch (err) {
      console.log();
      console.log(
        formatErrorBox(
          [
            `${chalk.red.bold("Failed to detect agents")}`,
            "",
            (err as Error).message,
          ].join("\n")
        )
      );
      process.exit(1);
    }
  });

// --- list ---
program
  .command("list")
  .description("List recent sessions across detected agents")
  .option("-s, --source <agent>", "Filter by agent")
  .option("-l, --limit <n>", "Max sessions to show", "10")
  .option("--json", "Output as JSON array")
  .option("--jsonl", "Output as JSONL (one JSON object per line)")
  .action(async (options) => {
    try {
      const limit = parseInt(options.limit, 10) || 10;
      const agentIds: AgentId[] = options.source
        ? [options.source as AgentId]
        : (Object.keys(AGENT_REGISTRY) as AgentId[]);

      const allSessions: CachedSessionEntry[] = [];

      for (const agentId of agentIds) {
        const adapter = getAdapter(agentId);
        if (!adapter) continue;

        let sessions: SessionInfo[];
        try {
          sessions = await adapter.listSessions();
        } catch {
          continue;
        }

        for (const s of sessions) {
          allSessions.push({ ...s, agentId });
        }
      }

      // Sort by recency
      allSessions.sort((a, b) => {
        const aTime = a.lastActiveAt || a.startedAt || "";
        const bTime = b.lastActiveAt || b.startedAt || "";
        return bTime.localeCompare(aTime);
      });

      const limited = allSessions.slice(0, limit);

      // JSON output modes
      if (options.json) {
        console.log(JSON.stringify(limited, null, 2));
        return;
      }

      if (options.jsonl) {
        for (const s of limited) {
          console.log(JSON.stringify(s));
        }
        return;
      }

      // Cache for TUI
      if (allSessions.length > 0) {
        writeCachedIndex(allSessions);
      }

      // Human-readable output
      if (limited.length === 0) {
        console.log(chalk.yellow("No sessions found."));
        return;
      }

      console.log();
      console.log(`  ${chalk.bold("Recent Sessions")}`);
      console.log();

      let currentAgent = "";
      for (let i = 0; i < limited.length; i++) {
        const s = limited[i];
        if (s.agentId !== currentAgent) {
          currentAgent = s.agentId;
          console.log(`  ${chalk.bold(AGENT_REGISTRY[s.agentId].name)}`);
        }
        const isLast = i === limited.length - 1 || limited[i + 1]?.agentId !== currentAgent;
        const prefix = isLast ? "  └─" : "  ├─";
        const idShort = chalk.cyan(s.id.slice(0, 12));
        const time = s.lastActiveAt || s.startedAt
          ? chalk.dim(relativeTime(s.lastActiveAt || s.startedAt || ""))
          : chalk.dim("unknown");
        const msgs = s.messageCount != null ? chalk.yellow(`${s.messageCount} msgs`) : "";
        console.log(`  ${prefix} ${idShort}  ${time}   ${msgs}`);
      }
      console.log();
      console.log(`  ${hint("Run 'braindump --session <id>' to handoff a specific session")}`);
      console.log();
    } catch (err) {
      console.log();
      console.log(
        formatErrorBox(
          [
            `${chalk.red.bold("Failed to list sessions")}`,
            "",
            (err as Error).message,
          ].join("\n")
        )
      );
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
      let spinner = ora("Finding your AI agent...").start();
      const adapter = options.source
        ? getAdapter(options.source as AgentId)
        : await autoDetectSource(projectPath);

      if (!adapter) {
        spinner.fail("No agent detected");
        console.log();
        console.log(
          formatErrorBox(
            [
              `${chalk.red.bold("No agent detected")}`,
              "",
              "Use --source to specify one.",
            ].join("\n")
          )
        );
        process.exit(1);
      }
      spinner.succeed(`Source: ${adapter.agentId}`);

      if (adapter.agentId === "cursor") {
        console.log(`  ${hint("Close Cursor and run from your project folder for best results.")}`);
      }

      // 2. Capture session
      spinner = ora("Reading conversation history...").start();
      const session = options.session
        ? await adapter.capture(options.session)
        : await adapter.captureLatest(projectPath);
      spinner.succeed(`Captured ${session.conversation.messageCount} messages`);

      // 3. Enrich with project context
      spinner = ora("Adding project context (git, files)...").start();
      const context = await extractProjectContext(projectPath);
      session.project = { ...session.project, ...context };
      spinner.succeed("Project context enriched");

      // 4. Write output
      spinner = ora("Saving session file...").start();
      const handoffDir = join(projectPath, ".handoff");
      mkdirSync(handoffDir, { recursive: true });
      writeFileSync(join(handoffDir, "session.json"), JSON.stringify(session, null, 2));
      spinner.succeed(`Written to ${join(handoffDir, "session.json")}`);

      const summaryLines = [
        `${chalk.green.bold("Capture complete!")}`,
        "",
        `${chalk.dim("Messages:")}  ${session.conversation.messageCount}`,
        `${chalk.dim("Tokens:")}    ~${session.conversation.estimatedTokens}`,
      ];

      console.log();
      console.log(formatBox(summaryLines.join("\n")));
      console.log();
      console.log(`  ${hint("Run 'braindump resume' to generate RESUME.md")}`);
      console.log();
    } catch (err) {
      console.log();
      console.log(
        formatErrorBox(
          [
            `${chalk.red.bold("Capture failed")}`,
            "",
            (err as Error).message,
          ].join("\n")
        )
      );
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
  .option("--launch", "Auto-launch target tool after handoff")
  .option("-v, --verbose", "Show detailed debug output")
  .action(async (options) => {
    await runHandoff(options);
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
          console.log(`  ${time} ${chalk.red("!")} ${agent}${sid} ${chalk.red("possible rate limit")} — run ${chalk.bold("braindump handoff")} to switch`);
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
        console.log();
        console.log(
          formatErrorBox(
            [
              `${chalk.red.bold("File not found")}`,
              "",
              filePath,
              "",
              "Run 'braindump capture' first,",
              "or use --file to specify a path.",
            ].join("\n")
          )
        );
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

      const summaryLines = [
        `${chalk.green.bold("Resume regenerated!")}`,
        "",
        `${chalk.dim("Tokens:")}  ${compressed.totalTokens}`,
        `${chalk.dim("Output:")}  ${outputPath}`,
      ];

      console.log();
      console.log(formatBox(summaryLines.join("\n")));
      console.log();
      console.log(`  ${hint("Paste RESUME.md into your target agent to continue")}`);
      console.log();
    } catch (err) {
      console.log();
      console.log(
        formatErrorBox(
          [
            `${chalk.red.bold("Resume failed")}`,
            "",
            (err as Error).message,
          ].join("\n")
        )
      );
      process.exit(3);
    }
  });

// --- info ---
program
  .command("info")
  .description("Show agent storage paths, context window sizes, and config")
  .action(async () => {
    console.log(banner("1.0.0"));
    for (const meta of Object.values(AGENT_REGISTRY)) {
      const storagePath = meta.storagePaths[process.platform] || "N/A";
      console.log(`  ${chalk.bold(meta.name)} ${chalk.dim(`(${meta.id})`)}`);
      console.log(`    ${chalk.dim("Storage:")}        ${storagePath}`);
      console.log(`    ${chalk.dim("Context window:")} ${meta.contextWindow.toLocaleString()} tokens`);
      console.log(`    ${chalk.dim("Usable budget:")}  ${meta.usableTokens.toLocaleString()} tokens`);
      console.log(`    ${chalk.dim("Memory files:")}   ${meta.memoryFiles.join(", ") || "none"}`);
      console.log();
    }
  });

// --- default: interactive TUI when no subcommand given in TTY ---
const args = process.argv.slice(2);
const subcommands = [...program.commands.map((c) => c.name()), "help"];
const hasSubcommand = args.length > 0 && subcommands.includes(args[0]);
const hasHelpOrVersion = args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-V");

if (args.length === 0) {
  if (process.stdout.isTTY) {
    // Interactive TUI
    runInteractiveTUI().catch((err) => {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    });
  } else {
    // Non-TTY — show intro text
    console.log(intro());
  }
} else if (!hasSubcommand && !hasHelpOrVersion) {
  program.parse();
} else {
  program.parse();
}
