import fs from "node:fs";
import path from "node:path";
import type { ResumeProvider, ProviderOptions } from "../types/index.js";

/**
 * Writes the resume prompt to .handoff/RESUME.md in the project directory.
 */
export class FileProvider implements ResumeProvider {
  async deliver(content: string, options?: ProviderOptions): Promise<void> {
    const projectPath = options?.projectPath ?? process.cwd();
    const handoffDir = path.join(projectPath, ".handoff");
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, "RESUME.md"), content, "utf-8");
  }
}
