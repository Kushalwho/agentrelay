import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../types/index.js";

/**
 * Launch commands for each target tool.
 */
const LAUNCH_COMMANDS: Record<string, { cmd: string; promptMode: "positional" | "flag" | "subcommand" | "none"; flag?: string }> = {
  "claude-code": { cmd: "claude", promptMode: "positional" },
  codex: { cmd: "codex", promptMode: "positional" },
  cursor: { cmd: "cursor", promptMode: "none" },
  copilot: { cmd: "copilot", promptMode: "flag", flag: "-i" },
  gemini: { cmd: "gemini", promptMode: "positional" },
  opencode: { cmd: "opencode", promptMode: "flag", flag: "--prompt" },
  droid: { cmd: "droid", promptMode: "subcommand" },
};

const REFERENCE_THRESHOLD = 50_000; // 50KB — auto-switch to reference mode

/**
 * Check if a tool is installed on this system.
 */
export function isToolInstalled(tool: string): boolean {
  try {
    execSync(`which ${tool} 2>/dev/null || where ${tool} 2>nul`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a list of installed agent tools (excluding a given source).
 */
export function getInstalledTools(exclude?: AgentId): { id: AgentId; cmd: string }[] {
  const results: { id: AgentId; cmd: string }[] = [];
  for (const [id, config] of Object.entries(LAUNCH_COMMANDS)) {
    if (id === exclude) continue;
    if (isToolInstalled(config.cmd)) {
      results.push({ id: id as AgentId, cmd: config.cmd });
    }
  }
  return results;
}

/**
 * Launch a target tool with the handoff prompt.
 */
export function launchTool(
  agentId: AgentId,
  prompt: string,
  options: { projectPath?: string; reference?: boolean } = {},
): void {
  const config = LAUNCH_COMMANDS[agentId];
  if (!config) {
    throw new Error(`Unknown target agent: ${agentId}`);
  }

  const useReference = options.reference || prompt.length > REFERENCE_THRESHOLD;

  let effectivePrompt: string;
  if (useReference) {
    const refPath = join(options.projectPath || process.cwd(), ".braindump-handoff.md");
    writeFileSync(refPath, prompt);
    effectivePrompt = `Read the file at ${refPath} and follow the instructions inside. It contains a session handoff from a previous AI coding agent — continue the work described there.`;
  } else {
    effectivePrompt = prompt;
  }

  const args: string[] = [];
  switch (config.promptMode) {
    case "positional":
      args.push(effectivePrompt);
      break;
    case "flag":
      args.push(config.flag!, effectivePrompt);
      break;
    case "subcommand":
      args.push("exec", effectivePrompt);
      break;
    case "none":
      // cursor just opens the project
      if (options.projectPath) {
        args.push(options.projectPath);
      }
      break;
  }

  spawn(config.cmd, args, {
    stdio: "inherit",
    cwd: options.projectPath || process.cwd(),
    detached: false,
  });
}
