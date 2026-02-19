# AgentRelay

A CLI tool that captures your AI coding agent session and generates a portable resume prompt so you can seamlessly continue in a different agent when tokens run out.

## The Problem

AI coding agents are context silos. When your session hits a rate limit or runs out of tokens, you lose all that context. AgentRelay captures it and generates a handoff prompt so a new agent can pick up exactly where the last one left off.

## Supported Agents

| Agent | Status |
|-------|--------|
| Claude Code | Working |
| Cursor | Working |
| Codex CLI | Working |

## Installation

```bash
# From npm
npm install -g agentrelay

# From source
git clone https://github.com/Kushalwho/agentrelay.git
cd agentrelay
npm install
npm run build
npm link
```

## Quick Start

```bash
# Detect installed agents
agentrelay detect

# Full handoff — capture, compress, generate resume prompt
agentrelay handoff

# Target a specific agent for the resume format
agentrelay handoff --target cursor

# Preview without writing files
agentrelay handoff --dry-run

# Watch for rate limits (auto-detects agents)
agentrelay watch

# The resume prompt is in .handoff/RESUME.md and on your clipboard
# Paste it into your target agent and keep working
```

## Commands

```
agentrelay detect                         Scan for installed agents
agentrelay list [--source <agent>]        List recent sessions
agentrelay capture [--source <agent>]     Capture session to .handoff/session.json
agentrelay handoff [options]              Full pipeline: capture -> compress -> resume
agentrelay watch [--agents <csv>]         Watch sessions for changes and rate limits
agentrelay resume [--file <path>]         Re-generate resume from captured session
agentrelay info                           Show agent paths and config
```

### Handoff Options

```
-s, --source <agent>    Source agent (claude-code, cursor, codex). Auto-detected if omitted.
-t, --target <target>   Target agent or "file"/"clipboard". Default: file + clipboard.
--session <id>          Specific session ID. Default: most recent session.
-p, --project <path>    Project path. Default: current directory.
--tokens <n>            Token budget override. Default: based on target agent.
--dry-run               Preview what would be captured without writing files.
--no-clipboard          Skip clipboard copy (useful in CI/headless environments).
-o, --output <path>     Custom output path. Directory or file path.
-v, --verbose           Show detailed debug output.
```

### Watch Options

```
--agents <csv>          Comma-separated agents to watch (claude-code, cursor, codex).
--interval <seconds>    Polling interval in seconds. Default: 30.
-p, --project <path>    Only watch sessions for this project.
```

### Target-Specific Hints

When you specify `--target`, the resume prompt includes agent-specific instructions:

| Target | Hint |
|--------|------|
| `cursor` | "Paste this into Cursor's Composer to continue." |
| `codex` | "Feed this to Codex CLI with `codex resume` or paste it." |
| `claude-code` | "Paste this into a new Claude Code session to continue." |

## How It Works

```
+-----------------+    +--------------+    +-----------------+    +--------------+
|  Agent Session  |    |   Capture    |    |   Compress      |    |  RESUME.md   |
|  (JSONL/SQLite) | -> |  + Analyze   | -> |  (7 priority    | -> |  + clipboard |
|                 |    |  + Enrich    |    |   layers)       |    |              |
+-----------------+    +--------------+    +-----------------+    +--------------+
```

1. **Capture** -- Reads session data from the agent's native storage (JSONL for Claude Code/Codex, SQLite for Cursor)
2. **Analyze** -- Extracts task state, decisions, blockers, and completed steps from the conversation
3. **Enrich** -- Adds project context: git branch/status/log, directory tree, memory files
4. **Compress** -- Priority-layered compression to fit any context window
5. **Generate** -- Builds a self-summarizing resume prompt that tells the new agent to pick up exactly where the last one left off
6. **Deliver** -- Writes to `.handoff/RESUME.md` and copies to clipboard

## Compression Priority Layers

| Priority | Layer | Always included? |
|----------|-------|-----------------|
| 1 | Task state (what's done, in progress, remaining) | Yes |
| 2 | Active files (diffs/content of changed files) | Yes |
| 3 | Decisions and blockers | Yes |
| 4 | Project context (git, directory tree, memory files) | If room |
| 5 | Session overview (stats, first/last message) | If room |
| 6 | Recent messages (last 20) | If room |
| 7 | Full history (older messages) | If room |

## Development

```bash
npm install              # Install dependencies
npm run dev -- detect    # Run in dev mode
npm test                 # Run tests (watch mode)
npm run test:run         # Run tests (single run)
npm run lint             # Type check
npm run build            # Build to dist/
```

## Project Structure

```
src/
├── adapters/                  # Agent-specific session readers
│   ├── claude-code/adapter.ts # JSONL parser for ~/.claude/projects/
│   ├── cursor/adapter.ts      # SQLite reader for Cursor workspaceStorage
│   └── codex/adapter.ts       # JSONL parser for ~/.codex/sessions/
├── core/
│   ├── compression.ts         # Priority-layered compression engine
│   ├── conversation-analyzer.ts # Extracts tasks, decisions, blockers
│   ├── prompt-builder.ts      # RESUME.md template assembly
│   ├── token-estimator.ts     # Character-based token estimation
│   ├── project-context.ts     # Git info, directory tree, memory files
│   ├── registry.ts            # Agent metadata (paths, context windows)
│   └── watcher.ts             # Polling-based session watcher
├── providers/
│   ├── file-provider.ts       # Writes .handoff/RESUME.md
│   └── clipboard-provider.ts  # Copies to system clipboard
├── types/index.ts             # All TypeScript interfaces
└── cli/index.ts               # Commander.js CLI entry point
```

## Tests

70 tests passing across 8 test files:
- Adapter tests (Claude Code, Cursor, Codex) with real JSONL/SQLite parsing
- Compression engine tests across all priority layers
- Conversation analyzer tests
- Prompt builder tests including target-agent hints
- Watcher tests with mocked adapters and fake timers
- End-to-end handoff flow integration tests

## CI

GitHub Actions runs on every PR and push to main:
- TypeScript type check
- Tests (vitest)
- Build
- Node.js 18, 20, 22

## License

MIT
