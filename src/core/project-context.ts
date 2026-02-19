import type { ProjectContext } from "../types/index.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Build a directory tree string recursively, excluding common non-essential directories.
 * Limited to maxDepth levels and maxLines output lines.
 */
function buildDirectoryTree(
  dirPath: string,
  prefix: string = "",
  depth: number = 0,
  maxDepth: number = 2,
  lines: string[] = []
): string[] {
  if (depth > maxDepth || lines.length >= 40) {
    return lines;
  }

  const excludeDirs = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".venv"]);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return lines;
  }

  // Sort: directories first, then files, both alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length && lines.length < 40; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "\u2514\u2500 " : "\u251C\u2500 ";
    const childPrefix = isLast ? "   " : "\u2502  ";

    if (entry.isDirectory() && excludeDirs.has(entry.name)) {
      continue;
    }

    const suffix = entry.isDirectory() ? "/" : "";
    lines.push(`${prefix}${connector}${entry.name}${suffix}`);

    if (entry.isDirectory() && depth < maxDepth) {
      buildDirectoryTree(
        path.join(dirPath, entry.name),
        prefix + childPrefix,
        depth + 1,
        maxDepth,
        lines
      );
    }
  }

  return lines;
}

/**
 * Extract project context from the filesystem.
 * Gathers git info, directory tree, and memory file contents.
 */
export async function extractProjectContext(
  projectPath: string
): Promise<ProjectContext> {
  const context: ProjectContext = {
    path: projectPath,
  };

  // Name: try package.json first, fall back to directory basename
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const packageJson = fs.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(packageJson) as { name?: string };
    context.name = parsed.name ?? path.basename(projectPath);
  } catch {
    context.name = path.basename(projectPath);
  }

  // Git branch
  try {
    context.gitBranch = execSync("git branch --show-current", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    // Git not available or not a git repo
  }

  // Git status
  try {
    context.gitStatus = execSync("git status --short", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    // Git not available or not a git repo
  }

  // Git log (last 10 commits)
  try {
    const logOutput = execSync("git log --oneline -10", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (logOutput) {
      context.gitLog = logOutput.split("\n");
    }
  } catch {
    // Git not available or not a git repo
  }

  // Directory structure (recursive, max depth 2, capped at 40 lines)
  try {
    const lines = buildDirectoryTree(projectPath);
    if (lines.length > 0) {
      context.structure = lines.join("\n");
    }
  } catch {
    // Unable to read directory
  }

  // Memory file contents (CLAUDE.md and .claude/CLAUDE.md)
  try {
    const memoryFiles = ["CLAUDE.md", ".claude/CLAUDE.md"];
    const contents: string[] = [];

    for (const file of memoryFiles) {
      try {
        const filePath = path.join(projectPath, file);
        const content = fs.readFileSync(filePath, "utf-8");
        if (content) {
          contents.push(content);
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    if (contents.length > 0) {
      const combined = contents.join("\n\n");
      context.memoryFileContents = combined.length > 2000
        ? combined.substring(0, 2000)
        : combined;
    }
  } catch {
    // Unable to read memory files
  }

  return context;
}
