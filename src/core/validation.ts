import { z } from "zod";

export const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolName: z.string().optional(),
  timestamp: z.string().optional(),
  tokenCount: z.number().optional(),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  changeType: z.enum(["created", "modified", "deleted"]),
  diff: z.string().optional(),
  language: z.string().optional(),
});

export const TaskStateSchema = z.object({
  description: z.string(),
  completed: z.array(z.string()),
  remaining: z.array(z.string()),
  inProgress: z.string().optional(),
  blockers: z.array(z.string()),
});

export const ProjectContextSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  gitBranch: z.string().optional(),
  gitStatus: z.string().optional(),
  gitLog: z.array(z.string()).optional(),
  structure: z.string().optional(),
  memoryFileContents: z.string().optional(),
});

export const CapturedSessionSchema = z.object({
  version: z.literal("1.0"),
  source: z.enum(["claude-code", "cursor", "codex", "copilot", "gemini", "opencode", "droid"]),
  capturedAt: z.string(),
  sessionId: z.string(),
  sessionStartedAt: z.string().optional(),
  project: ProjectContextSchema,
  conversation: z.object({
    messageCount: z.number(),
    estimatedTokens: z.number(),
    summary: z.string().optional(),
    messages: z.array(ConversationMessageSchema),
  }),
  filesChanged: z.array(FileChangeSchema),
  decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  task: TaskStateSchema,
  toolActivity: z.array(z.object({
    name: z.string(),
    count: z.number(),
    samples: z.array(z.string()),
  })).optional(),
});

/**
 * Validate a CapturedSession object. Throws ZodError if invalid.
 */
export function validateSession(data: unknown) {
  return CapturedSessionSchema.parse(data);
}

/**
 * Safe validation - returns { success, data, error } without throwing.
 */
export function safeValidateSession(data: unknown) {
  return CapturedSessionSchema.safeParse(data);
}
