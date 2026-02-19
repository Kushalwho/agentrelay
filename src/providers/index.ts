import type { ResumeProvider, AgentId } from "../types/index.js";
import { FileProvider } from "./file-provider.js";
import { ClipboardProvider } from "./clipboard-provider.js";
import { AgentProvider } from "./agent-provider.js";

/**
 * Get the appropriate provider(s) for a given target.
 */
export function getProviders(
  target: AgentId | "clipboard" | "file"
): ResumeProvider[] {
  switch (target) {
    case "file":
      return [new FileProvider()];
    case "clipboard":
      return [new ClipboardProvider()];
    default:
      // Agent ID target — use both file and clipboard (belt and suspenders)
      return [new FileProvider(), new ClipboardProvider()];
  }
}

export { FileProvider, ClipboardProvider, AgentProvider };
