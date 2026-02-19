# AgentRelay — Complete Usage Guide

## What AgentRelay Does

When your AI coding agent (Claude Code, Cursor, Codex) hits a rate limit or runs out of tokens, your entire context is trapped. AgentRelay captures that context and generates a portable **RESUME.md** prompt that a new agent can read to pick up exactly where the last one stopped.

```
Claude Code (rate limited) → agentrelay handoff → RESUME.md → Paste into Cursor → Continue working
```

## Installation

### From Source (recommended for now)

```bash
git clone https://github.com/Kushalwho/agentrelay.git
cd agentrelay
npm install
npm run build
npm link          # Makes 'agentrelay' available globally
```

### From npm (after publish)

```bash
npm install -g agentrelay
```

### Verify

```bash
agentrelay --version    # Should print 0.3.0
agentrelay detect       # Shows which agents are installed
```

---

## Commands Reference

### 1. `agentrelay detect`

Scans your system for installed AI coding agents.

```bash
agentrelay detect
```

**Output:**
```
  + claude-code ~/.claude/projects/            # Detected
  - cursor ~/.config/Cursor/User/...           # Not found
  + codex ~/.codex/sessions/                   # Detected
```

**What it checks:** Looks for each agent's session storage directory on disk.

---

### 2. `agentrelay info`

Shows detailed info about each supported agent.

```bash
agentrelay info
```

**Output:**
```
  AgentRelay v0.3.0 (linux)

  Claude Code (claude-code)
    Storage:        ~/.claude/projects/
    Context window: 200,000 tokens
    Usable budget:  120,000 tokens
    Memory files:   CLAUDE.md, .claude/CLAUDE.md
  ...
```

**Usable budget** = how many tokens AgentRelay targets when compressing for that agent. It's less than the full context window to leave room for the agent's own system prompt.

---

### 3. `agentrelay list`

Lists recent sessions across all detected agents.

```bash
agentrelay list                          # All agents, last 10 sessions
agentrelay list --source claude-code     # Only Claude Code sessions
agentrelay list --limit 5                # Show max 5 sessions
```

**Output:**
```
  Claude Code:
    feecba38-045  2026-02-19T18:14:55Z  (247 msgs)
    2eb1fea8-880  2026-02-19T12:25:52Z  (876 msgs)
```

Each line shows: session ID (truncated), last active timestamp, message count.

---

### 4. `agentrelay capture`

Captures a session into `.handoff/session.json` without compressing or generating a resume.

```bash
agentrelay capture                           # Auto-detect agent, latest session
agentrelay capture --source claude-code      # Explicit agent
agentrelay capture --session feecba38-045    # Specific session ID
agentrelay capture --project /path/to/repo   # For a specific project
```

**Output files:**
- `.handoff/session.json` — Raw captured session data (conversation, files changed, decisions, task state)

**When to use:** When you want to inspect the raw data before generating a resume, or save a snapshot without the compression step.

---

### 5. `agentrelay handoff` (the main command)

Full pipeline: capture → analyze → enrich → compress → generate resume → deliver.

```bash
# Basic usage (auto-detects everything)
agentrelay handoff

# Specify source and target
agentrelay handoff --source claude-code --target cursor

# Custom token budget
agentrelay handoff --target codex --tokens 50000

# Preview without writing files
agentrelay handoff --dry-run

# Skip clipboard copy
agentrelay handoff --no-clipboard

# Custom output location
agentrelay handoff --output /tmp/my-resume.md
agentrelay handoff --output /tmp/handoff-dir/     # Writes RESUME.md inside

# Debug mode
agentrelay handoff --verbose

# Combine flags
agentrelay handoff --source claude-code --target cursor --dry-run --verbose
```

**Output files:**
- `.handoff/RESUME.md` — The resume prompt to paste into the target agent
- `.handoff/session.json` — Raw captured session data
- Clipboard — RESUME.md is also copied to clipboard (unless `--no-clipboard`)

**All flags:**

| Flag | Description |
|------|-------------|
| `-s, --source <agent>` | Source agent (`claude-code`, `cursor`, `codex`). Auto-detected if omitted. |
| `-t, --target <target>` | Target agent or `file`/`clipboard`. Default: `file`. |
| `--session <id>` | Specific session ID. Default: most recent. |
| `-p, --project <path>` | Project path. Default: current directory. |
| `--tokens <n>` | Override token budget. Default: based on target agent. |
| `--dry-run` | Preview without writing files. |
| `--no-clipboard` | Don't copy to clipboard. |
| `-o, --output <path>` | Custom output path (file or directory). |
| `-v, --verbose` | Show debug output. |

---

### 6. `agentrelay resume`

Re-generates RESUME.md from a previously captured `session.json`. Useful when you want to retarget a different agent or change the token budget.

```bash
agentrelay resume                            # Use .handoff/session.json
agentrelay resume --target cursor            # Retarget for Cursor
agentrelay resume --tokens 10000             # Smaller budget
agentrelay resume --file /path/session.json  # Custom input file
```

---

### 7. `agentrelay watch`

Monitors agent sessions in real-time. Detects new sessions, message growth, and possible rate limits.

```bash
agentrelay watch                             # Watch all detected agents
agentrelay watch --agents claude-code        # Watch specific agent
agentrelay watch --agents claude-code,codex  # Watch multiple
agentrelay watch --interval 15               # Poll every 15 seconds (default: 30)
agentrelay watch --project /path/to/repo     # Only this project's sessions
```

**Output (live):**
```
✔ Watching claude-code (3 sessions, 30s interval)
  Press Ctrl+C to stop.

  12:05:30 + claude-code feecba38-045 new session
  12:06:00 ~ claude-code feecba38-045 Message count 10 -> 15
  12:07:00 ! claude-code feecba38-045 possible rate limit — run agentrelay handoff to switch
```

**Event types:**
- `+` (green) — New session detected
- `~` (blue) — Session updated (message count changed)
- `!` (red) — Possible rate limit (session stopped growing after 2+ polls)

Press `Ctrl+C` to stop gracefully.

---

## The Handoff Workflow (Step by Step)

### Scenario: Claude Code hits rate limit, switch to Cursor

1. **You're working in Claude Code** and it hits a rate limit / runs out of tokens

2. **Run the handoff:**
   ```bash
   cd /your/project
   agentrelay handoff --target cursor
   ```

3. **Output:**
   ```
   ✔ Source: claude-code
   ✔ Captured 247 messages
   ✔ Project context enriched
   ✔ Compressed to 15000 tokens
   ✔ Written to /your/project/.handoff/RESUME.md

     Handoff complete!
     Tokens: 15000 / 38000 (39%)
     Clipboard: copied!
   ```

4. **Open Cursor** and paste the clipboard content (or open `.handoff/RESUME.md`)

5. **Cursor reads the context** and picks up where Claude Code left off — same task, same decisions, same files

### Scenario: Quick preview before handoff

```bash
agentrelay handoff --dry-run --verbose
```

This shows you what would be captured without writing any files. Check the token count, included/dropped layers, and session details.

### Scenario: Watch and auto-detect rate limits

```bash
# Terminal 1: Work normally in your agent
# Terminal 2:
agentrelay watch
# When it prints "possible rate limit", run:
agentrelay handoff --target cursor
```

---

## What's Inside RESUME.md

The generated resume prompt contains these sections:

1. **Header** — Source agent, capture time, project, branch, target agent
2. **Instructions** — Tells the new agent to read context silently and continue
3. **Current Task** — What's done, what's in progress, what's remaining
4. **Key Decisions** — Decisions made in the previous session
5. **Blockers** — Known issues or blockers
6. **Active Files** — Files changed with diffs
7. **Project Context** — Git branch, status, directory tree
8. **Session Overview** — Stats and message count
9. **Recent Messages** — Last 20 conversation turns
10. **Resume Now** — Instruction to continue immediately

### Compression

If the resume is too large for the target agent's context window, AgentRelay drops layers in reverse priority order:

| Priority | Layer | Dropped first? |
|----------|-------|----------------|
| 1 (highest) | Task state | Never dropped |
| 2 | Active files | Never dropped |
| 3 | Decisions & blockers | Never dropped |
| 4 | Project context | If needed |
| 5 | Session overview | If needed |
| 6 | Recent messages | If needed |
| 7 (lowest) | Full history | Dropped first |

---

## npm Publish Setup (for maintainers)

### 1. Generate npm token

Go to [npmjs.com](https://www.npmjs.com) → Profile → Access Tokens → Generate New Token

**Important settings:**
- Type: **Granular Access Token**
- Packages and scopes: **Read and write** (NOT "No access")
- Expiration: **90 days** (or longer)

### 2. Add token to GitHub

Go to your repo → Settings → Secrets and variables → Actions → New repository secret

- Name: `NPM_TOKEN`
- Value: (paste your token)

### 3. Publish

```bash
git tag v0.3.0
git push --tags
```

The GitHub Actions workflow (`.github/workflows/publish.yml`) will:
1. Run type check
2. Run all 91 tests
3. Build
4. Publish to npm with provenance

### 4. Verify

```bash
npm view agentrelay          # Should show package info
npm install -g agentrelay    # Test global install
agentrelay --version         # 0.3.0
```

### For future releases

```bash
# 1. Bump version in package.json
# 2. Commit
# 3. Tag and push
git tag v0.4.0
git push --tags
# CI auto-publishes
```

---

## Development

```bash
npm install              # Install dependencies
npm run dev -- detect    # Run in dev mode (uses tsx, no build needed)
npm test                 # Run tests (watch mode)
npm run test:run         # Run tests (single run)
npm run lint             # Type check (tsc --noEmit)
npm run build            # Build to dist/
```

### Project Structure

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
│   ├── validation.ts          # Zod schema validation for CapturedSession
│   └── watcher.ts             # Polling-based session watcher
├── providers/
│   ├── file-provider.ts       # Writes .handoff/RESUME.md
│   └── clipboard-provider.ts  # Copies to system clipboard
├── cli/
│   ├── index.ts               # Commander.js CLI entry point
│   └── utils.ts               # CLI utility functions
└── types/index.ts             # All TypeScript interfaces
```

### Test Structure

```
tests/
├── adapters/
│   ├── claude-code.test.ts    # 14 tests
│   ├── cursor.test.ts         # 9 tests
│   └── codex.test.ts          # 8 tests
├── core/
│   ├── compression.test.ts    # 12 tests
│   ├── conversation-analyzer.test.ts  # 6 tests
│   ├── prompt-builder.test.ts # 16 tests
│   └── validation.test.ts     # 8 tests
├── cli/
│   └── cli.test.ts            # 7 tests
├── e2e/
│   └── handoff-flow.test.ts   # 4 tests
└── watcher/
    └── watcher.test.ts        # 7 tests

Total: 91 tests across 10 files
```
