import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import boxen from "boxen";

/**
 * Resolve the output path for RESUME.md.
 * - If path is a directory or ends with `/`, write RESUME.md inside it.
 * - Otherwise treat as a file path.
 */
export function resolveOutputPath(
  outputFlag: string | undefined,
  projectPath: string
): { resumePath: string; sessionDir: string } {
  if (!outputFlag) {
    const handoffDir = join(projectPath, ".handoff");
    return { resumePath: join(handoffDir, "RESUME.md"), sessionDir: handoffDir };
  }

  const isDir =
    outputFlag.endsWith("/") ||
    outputFlag.endsWith("\\") ||
    (existsSync(outputFlag) && lstatSync(outputFlag).isDirectory());

  if (isDir) {
    return { resumePath: join(outputFlag, "RESUME.md"), sessionDir: outputFlag };
  }

  return { resumePath: outputFlag, sessionDir: dirname(outputFlag) };
}

/**
 * Convert an ISO timestamp to a human-friendly relative time string.
 */
export function relativeTime(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = now - then;

  if (Number.isNaN(then)) return "unknown";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;  // "min" works for both singular and plural

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Wrap content in a green-bordered box (success).
 */
export function formatBox(content: string): string {
  return boxen(content, {
    padding: 1,
    borderColor: "green",
    borderStyle: "round",
  });
}

/**
 * Wrap content in a red-bordered box (error).
 */
export function formatErrorBox(content: string): string {
  return boxen(content, {
    padding: 1,
    borderColor: "red",
    borderStyle: "round",
  });
}

/**
 * Format a dimmed hint line.
 */
export function hint(text: string): string {
  return chalk.dim(`Hint: ${text}`);
}

/**
 * Return the CLI banner string.
 */
export function banner(version: string): string {
  const platform = process.platform as string;
  return [
    "",
    `  ${chalk.cyan.bold("braindump")} ${chalk.dim(`v${version}`)}`,
    `  ${chalk.dim("Capture AI agent sessions for seamless handoff")}`,
    "",
    `  ${chalk.dim("Platform:")} ${platform}`,
    "",
  ].join("\n");
}
