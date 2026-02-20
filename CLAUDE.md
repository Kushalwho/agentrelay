# Braindump — Architecture & Dev Guide

## What is Braindump?

A CLI tool that captures AI coding agent sessions and generates a portable resume prompt so you can seamlessly continue in a different agent. Supports 7 agents: Claude Code, Cursor, Codex, Copilot, Gemini CLI, OpenCode, Factory Droid.

## Build & Test

```bash
npm install
npm run build          # tsc → dist/
npm run lint           # tsc --noEmit
npm test               # vitest (watch mode)
npm run test:run       # vitest run (CI mode)
npm run dev            # tsx src/cli/index.ts (dev mode)
```

## Architecture

```
src/
├── adapters/              # Agent-specific session parsers
│   ├── base-adapter.ts    # Abstract base class (detect, list, capture, captureLatest)
│   ├── index.ts           # Adapter registry + auto-detection
│   ├── claude-code/       # JSONL parser (~/.claude/projects/)
│   ├── cursor/            # SQLite parser (~/.config/Cursor/...)
│   ├── codex/             # JSONL parser (~/.codex/sessions/)
│   ├── copilot/           # YAML+JSONL parser (~/.copilot/session-state/)
│   ├── gemini/            # JSON parser (~/.gemini/tmp/)
│   ├── opencode/          # SQLite+JSON parser (~/.local/share/opencode/)
│   └── droid/             # JSONL parser (~/.factory/sessions/)
├── cli/
│   ├── index.ts           # CLI commands (commander-based)
│   └── utils.ts           # Formatting helpers (boxen, chalk, relativeTime)
├── core/
│   ├── compression.ts     # 7-layer priority packing engine
│   ├── conversation-analyzer.ts  # NLP extraction (decisions, blockers, steps)
│   ├── project-context.ts # Git + directory tree + memory file reader
│   ├── prompt-builder.ts  # RESUME.md generator
│   ├── registry.ts        # Agent metadata (paths, context windows, memory files)
│   ├── session-cache.ts   # JSONL session index cache (5-min TTL)
│   ├── token-estimator.ts # ~chars/4 token estimate
│   ├── tool-summarizer.ts # SummaryCollector for tool activity
│   ├── launcher.ts        # Target tool auto-launcher
│   ├── validation.ts      # Zod schemas for CapturedSession
│   └── watcher.ts         # Polling-based session monitor
├── providers/
│   ├── index.ts           # Provider factory
│   ├── clipboard-provider.ts
│   └── file-provider.ts
└── types/
    └── index.ts           # All TypeScript interfaces
```

## Data Flow

```
Adapter.capture() → CapturedSession → compress() → buildResumePrompt() → RESUME.md
     ↑                    ↑
  agent storage      enriched with
  (JSONL/SQLite)     project context
```

## Key Interfaces

```typescript
// The core contract — adapters produce this, engine consumes it
interface CapturedSession {
  version: "1.0";
  source: AgentId;
  sessionId: string;
  project: ProjectContext;
  conversation: Conversation;
  filesChanged: FileChange[];
  decisions: string[];
  blockers: string[];
  task: TaskState;
  toolActivity?: ToolActivitySummary[];
}

type AgentId = "claude-code" | "cursor" | "codex" | "copilot" | "gemini" | "opencode" | "droid";
```

## How to Add a New Adapter

1. **`src/types/index.ts`** — Add your agent to the `AgentId` union type
2. **`src/core/registry.ts`** — Add an `AgentMeta` entry with storage paths, context window, memory files
3. **`src/core/validation.ts`** — Add to the Zod `source` enum
4. **`src/adapters/<name>/adapter.ts`** — Create adapter extending `BaseAdapter`:
   - `detect()` — Check if agent storage exists
   - `listSessions(projectPath?)` — Return `SessionInfo[]` sorted by recency
   - `capture(sessionId)` — Parse full session → `CapturedSession`
   - `captureLatest(projectPath?)` — List + capture first
   - Use `validateSession()` before returning
   - Use `SummaryCollector` for `toolActivity`
5. **`src/adapters/index.ts`** — Import and register the adapter

## Conventions

- **ESM-only** — all imports use `.js` extensions (`import { x } from "./foo.js"`)
- **Node 18+** — no `node:sqlite`, use `better-sqlite3` for SQLite
- **Streaming** — use `readline.createInterface` + `createReadStream` for JSONL files
- **Validation** — call `validateSession()` in every adapter before returning a session
- **Tool activity** — use `SummaryCollector` from `src/core/tool-summarizer.ts`

## Compression Layers (priority order)

1. Task State (always included)
2. Active Files (file changes + diffs)
3. Decisions & Blockers
4. Project Context (git, structure, memory files)
4.5. Tool Activity (tool usage summaries)
5. Session Overview (message count, first/last user message)
6. Recent Messages (last 20)
7. Full History (older messages — dropped first)
