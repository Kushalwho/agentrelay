import clipboard from "clipboardy";
import type { ResumeProvider, ProviderOptions } from "../types/index.js";

/**
 * Copies the resume prompt to the system clipboard.
 */
export class ClipboardProvider implements ResumeProvider {
  async deliver(content: string, options?: ProviderOptions): Promise<void> {
    try {
      await clipboard.write(content);
    } catch (error) {
      console.warn(
        "Clipboard not available — skipping clipboard copy.",
        error instanceof Error ? error.message : error
      );
    }
  }
}
