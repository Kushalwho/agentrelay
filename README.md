# Braindump

A CLI tool that captures your AI coding agent session and generates a portable resume prompt so you can seamlessly continue in a different agent when tokens run out.

## The Problem

AI coding agents are context silos. When your session hits a rate limit or runs out of tokens, you lose all that context. Braindump captures it and generates a handoff prompt so a new agent can pick up exactly where the last one left off.

## Supported Agents

| Agent | Storage Format | Status |
|-------|---------------|--------|
| Claude Code | JSONL (`~/.claude/projects/`) | Working |
| Cursor | SQLite (`workspaceStorage/`) + global DB | Working |
| Codex CLI | JSONL (`~/.codex/sessions/`) | Working |
| GitHub Copilot CLI | YAML + JSONL (`~/.copilot/session-state/`) | Working |
| Gemini CLI | JSON (`~/.gemini/tmp/`) | Working |
| OpenCode | SQLite (`opencode.db`) + JSON fallback | Working |
| Factory Droid | JSONL + settings (`~/.factory/sessions/`) | Working |

## Installation

```bash
# From npm
npm install -g braindump

# From source
git clone https://github.com/Kushalwho/braindump.git
cd braindump
npm install
npm run build
npm link
```

## Quick Start

```bash
# Interactive mode — gradient logo, agent dashboard, arrow-key menu
braindump

# Detect installed agents
braindump detect

# Full handoff — capture, compress, generate resume prompt
braindump handoff

# Shortcut — handoff a specific session (no subcommand needed)
braindump --session <id>

# Target a specific agent for the resume format
braindump handoff --target cursor

# Handoff and auto-launch the target tool
braindump handoff --target claude-code --launch

# Preview without writing files
braindump handoff --dry-run

# List sessions as JSON (for scripting)
braindump list --json

# Watch for rate limits (auto-detects agents)
braindump watch

# The resume prompt is in .handoff/RESUME.md and on your clipboard
# Paste it into your target agent and keep working
```

## Interactive TUI

Run `braindump` with no arguments in a terminal to get the interactive dashboard:

```
    __               _           __
   / /_  _________ _(_)___  ____/ /_  ______ ___  ____       ← violet
  / __ \/ ___/ __ `/ / __ \/ __  / / / / __ `__ \/ __ \
 / /_/ / /  / /_/ / / / / / /_/ / /_/ / / / / / / /_/ /
/_.___/_/   \__,_/_/_/ /_/\__,_/\__,_/_/ /_/ /_/ .___/      ← blue
                                               /_/

  braindump v1.1.1 | Seamless AI agent handoffs

  Agents
  ● Claude Code    12 sessions   2m ago
  ● Cursor          3 sessions   1h ago
  ○ Codex          installed
  × Copilot        not found

  What would you like to do?

  ❯ Handoff session       Transfer to another agent
    List sessions         Browse all captured sessions
    Detect agents         Scan system for AI tools
    Watch mode            Monitor for rate limits
    Help                  Show commands & options
```

Features:
- Gradient ASCII logo (violet → blue)
- Live agent dashboard — scans all 7 agents for sessions, shows counts and recency
- Arrow-key and vim (j/k) navigation with scroll indicators
- Custom purple-themed `--help` output
- No external TUI dependencies — raw ANSI escape codes

## Commands

```
braindump                                Interactive TUI (when run in a terminal)
braindump detect                         Scan for installed agents
braindump list [--source <agent>]        List recent sessions
braindump capture [--source <agent>]     Capture session to .handoff/session.json
braindump handoff [options]              Full pipeline: capture -> compress -> resume
braindump watch [--agents <csv>]         Watch sessions for changes and rate limits
braindump resume [--file <path>]         Re-generate resume from captured session
braindump info                           Show agent paths and config
```

### Handoff Options

These flags work both as `braindump handoff --flag` and as top-level shortcuts `braindump --flag`:

```
-s, --source <agent>    Source agent. Auto-detected if omitted.
-t, --target <target>   Target agent or "file"/"clipboard". Default: file + clipboard.
--session <id>          Specific session ID. Default: most recent session.
-p, --project <path>    Project path. Default: current directory.
--tokens <n>            Token budget override. Default: based on target agent.
--dry-run               Preview what would be captured without writing files.
--no-clipboard          Skip clipboard copy (useful in CI/headless environments).
-o, --output <path>     Custom output path. Directory or file path.
--launch                Auto-launch the target tool with the handoff prompt.
-v, --verbose           Show detailed debug output.
```

Supported agents: `claude-code`, `cursor`, `codex`, `copilot`, `gemini`, `opencode`, `droid`

### List Options

```
--source <agent>        Filter by agent.
--json                  Output as JSON array.
--jsonl                 Output as JSONL (one object per line).
```

### Watch Options

```
--agents <csv>          Comma-separated agents to watch.
--interval <seconds>    Polling interval in seconds. Default: 30.
-p, --project <path>    Only watch sessions for this project.
```

### Auto-Launch

When using `--launch`, braindump spawns the target tool with the handoff prompt:

| Target | Launch command |
|--------|---------------|
| `claude-code` | `claude <prompt>` |
| `codex` | `codex <prompt>` |
| `cursor` | `cursor <cwd>` (opens project) |
| `copilot` | `copilot -i <prompt>` |
| `gemini` | `gemini <prompt>` |
| `opencode` | `opencode --prompt <prompt>` |
| `droid` | `droid exec <prompt>` |

For large prompts (>50KB), braindump writes a `.braindump-handoff.md` reference file and sends a compact "read this file" prompt instead.

## How It Works

```
+-----------------+    +--------------+    +-----------------+    +--------------+
|  Agent Session  |    |   Capture    |    |   Compress      |    |  RESUME.md   |
|  (JSONL/SQLite/ | -> |  + Analyze   | -> |  (8 priority    | -> |  + clipboard |
|   YAML/JSON)    |    |  + Enrich    |    |   layers)       |    |  + launch    |
+-----------------+    +--------------+    +-----------------+    +--------------+
```

1. **Capture** -- Reads session data from the agent's native storage (JSONL, SQLite, YAML, or JSON)
2. **Analyze** -- Extracts task state, decisions, blockers, and completed steps from the conversation
3. **Enrich** -- Adds project context: git branch/status/log, directory tree, memory files
4. **Compress** -- Priority-layered compression to fit any context window
5. **Generate** -- Builds a self-summarizing resume prompt with tool activity summaries
6. **Deliver** -- Writes to `.handoff/RESUME.md`, copies to clipboard, and optionally launches target

## Compression Priority Layers

| Priority | Layer | Always included? |
|----------|-------|-----------------|
| 1 | Task state (what's done, in progress, remaining) | Yes |
| 2 | Active files (diffs/content of changed files) | Yes |
| 3 | Decisions and blockers | Yes |
| 4 | Project context (git, directory tree, memory files) | If room |
| 4.5 | Tool activity (what tools were used, how often) | If room |
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
│   ├── codex/adapter.ts       # JSONL parser for ~/.codex/sessions/
│   ├── copilot/adapter.ts     # YAML + JSONL parser for ~/.copilot/
│   ├── gemini/adapter.ts      # JSON parser for ~/.gemini/tmp/
│   ├── opencode/adapter.ts    # SQLite + JSON fallback for opencode
│   └── droid/adapter.ts       # JSONL parser for ~/.factory/sessions/
├── core/
│   ├── compression.ts         # Priority-layered compression engine
│   ├── conversation-analyzer.ts # Extracts tasks, decisions, blockers
│   ├── prompt-builder.ts      # RESUME.md template assembly
│   ├── token-estimator.ts     # Character-based token estimation
│   ├── project-context.ts     # Git info, directory tree, memory files
│   ├── registry.ts            # Agent metadata (paths, context windows)
│   ├── tool-summarizer.ts     # Tool activity tracking (SummaryCollector)
│   ├── launcher.ts            # Auto-launch target tools
│   ├── session-cache.ts       # JSONL session index cache
│   ├── validation.ts          # Zod schema validation
│   └── watcher.ts             # Polling-based session watcher
├── providers/
│   ├── file-provider.ts       # Writes .handoff/RESUME.md
│   └── clipboard-provider.ts  # Copies to system clipboard
├── types/index.ts             # All TypeScript interfaces
└── cli/
    ├── index.ts               # Commander.js CLI entry point
    ├── tui.ts                 # Custom ANSI select prompt (no deps)
    └── utils.ts               # Colors, gradient logo, dashboard, helpers
```

## Tests

139 tests passing across 13 test files:
- Adapter tests for all 7 agents with real JSONL/SQLite/YAML/JSON parsing
- Compression engine tests across all priority layers
- Conversation analyzer tests
- Prompt builder tests including target-agent hints
- Watcher tests with mocked adapters and fake timers
- End-to-end handoff flow integration tests
- TUI tests for key parsing and option rendering

## CI

GitHub Actions runs on every PR and push to main:
- TypeScript type check
- Tests (vitest)
- Build
- Node.js 18, 20, 22

Auto-publishes to npm on `v*` tags with provenance.

## License

MIT
