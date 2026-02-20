import type { ToolActivitySummary } from "../types/index.js";

/**
 * Collects tool invocations during session parsing and produces
 * aggregated ToolActivitySummary entries.
 *
 * Usage:
 *   const collector = new SummaryCollector();
 *   collector.record("Bash", "npm test -> exit 0");
 *   collector.record("Edit", "edit src/auth.ts (+5 -2)");
 *   session.toolActivity = collector.getSummaries();
 */
export class SummaryCollector {
  private counts = new Map<string, number>();
  private samples = new Map<string, string[]>();
  private static readonly MAX_SAMPLES = 3;

  /**
   * Record a tool invocation.
   * @param category Normalized tool category (e.g. "Bash", "Edit", "Read")
   * @param oneLiner Short description of what was done
   */
  record(category: string, oneLiner: string): void {
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
    const existing = this.samples.get(category) ?? [];
    if (existing.length < SummaryCollector.MAX_SAMPLES) {
      existing.push(oneLiner);
      this.samples.set(category, existing);
    }
  }

  /**
   * Return aggregated summaries sorted by count descending.
   */
  getSummaries(): ToolActivitySummary[] {
    const results: ToolActivitySummary[] = [];
    for (const [name, count] of this.counts) {
      results.push({
        name,
        count,
        samples: this.samples.get(name) ?? [],
      });
    }
    results.sort((a, b) => b.count - a.count);
    return results;
  }
}

// --- Helper formatters for common tool patterns ---

/** Format a shell command summary. */
export function shellSummary(command: string, exitCode?: number): string {
  const cmd = command.length > 60 ? command.slice(0, 57) + "..." : command;
  return exitCode != null ? `$ ${cmd} -> exit ${exitCode}` : `$ ${cmd}`;
}

/** Format a file edit summary. */
export function fileSummary(
  filePath: string,
  action: "edit" | "create" | "read" | "delete",
  stats?: { added?: number; removed?: number },
): string {
  const name = filePath.split("/").pop() ?? filePath;
  const shortPath = filePath.length > 40 ? "..." + filePath.slice(-37) : filePath;
  if (stats?.added != null || stats?.removed != null) {
    return `${action} ${shortPath} (+${stats.added ?? 0} -${stats.removed ?? 0})`;
  }
  return `${action} ${shortPath}`;
}

/** Format a grep/search summary. */
export function grepSummary(pattern: string, path?: string): string {
  const p = pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern;
  return path ? `grep "${p}" ${path}` : `grep "${p}"`;
}

/** Format a glob/find summary. */
export function globSummary(pattern: string): string {
  return `glob ${pattern}`;
}

/** Format an MCP tool summary. */
export function mcpSummary(toolName: string, args?: string): string {
  const short = toolName.replace(/^mcp__/, "").replace(/___/g, ":");
  return args ? `${short}(${args})` : short;
}
