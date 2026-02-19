# AgentRelay — Collaboration Guide

## Current Status (Updated Feb 19, 2026)

**v0.2 Multi-Agent is complete.** All adapters working. Moving to **Round 4 (Watch + Polish)**.

| Milestone | Status |
|-----------|--------|
| PR #1 — Core engine (Prateek) | Merged |
| PR #2 — Data layer (Kushal) | Merged |
| PR #3 — Enrich pipeline (Prateek) | Merged |
| PR #4 — Smart extraction (Kushal) | Merged |
| PR #5 — E2E tests, ora spinners, agent hints (Prateek) | Merged |
| PR #6 — Cursor & Codex adapters (Kushal) | Merged |
| End-to-end `handoff` command | Working (all 3 agents) |
| CI (GitHub Actions) | Running on Node 18/20/22 |
| Tests | **63 passing** |

### What's working (v0.2 complete)

- **All 3 adapters:** Claude Code, Cursor (SQLite), Codex (JSONL)
- Conversation analyzer — task description, decisions, blockers, completed steps
- Project context enrichment — git branch/status/log, directory tree, memory files
- Compression engine — 7 priority layers, budget-aware packing
- Prompt builder — self-summarizing RESUME.md with agent-specific target hints
- CLI — all commands with ora spinners: `detect`, `list`, `capture`, `handoff`, `resume`, `info`
- File + clipboard delivery
- Agent-specific resume footer (cursor/codex/claude-code)
- E2E integration tests (4 tests)
- npm link works as global `agentrelay` command

### What's next (Round 4)

| Task | Owner | Branch |
|------|-------|--------|
| Watcher implementation (chokidar-based) | **Kushal** | `feat/watcher` |
| Watcher tests | **Kushal** | `feat/watcher` |
| Watcher CLI integration + spinner | **Prateek** | `feat/watch-cli` |
| `--dry-run` flag for handoff | **Prateek** | `feat/watch-cli` |
| Bump version to v0.2.0 + npm publish prep | **Prateek** | `feat/watch-cli` |

---

## Team

| Who | Role | Current Focus |
|-----|------|---------------|
| **Prateek** | Core engine + CLI + E2E tests | Watch CLI, dry-run, version bump |
| **Kushal** | Data layer + adapters + watcher | Watcher core implementation |

## The Contract: `CapturedSession`

Both sides meet at the `CapturedSession` interface in `src/types/index.ts`.

- **Kushal** builds adapters/watcher that **produce** `CapturedSession` objects and monitor agent data
- **Prateek** builds the engine/CLI that **consumes** `CapturedSession` objects and outputs RESUME.md

## Branch Workflow

```bash
# Always start from latest main
git checkout main
git pull origin main

# Create your feature branch
git checkout -b feat/watcher          # (Kushal)
git checkout -b feat/watch-cli        # (Prateek)

# Work, commit frequently
git add <files> && git commit -m "description"

# Push your branch
git push -u origin feat/watcher
git push -u origin feat/watch-cli

# Create PR to main
gh pr create --base main --title "feat: description"

# Before merging second PR, rebase on main
git pull origin main --rebase
```

## File Ownership (Round 4)

These files are **shared** — coordinate before editing:
- `src/types/index.ts` — if you need to change an interface, tell the other person
- `package.json` — if you need a new dependency, add it and tell the other person

| Prateek's files (don't touch) | Kushal's files (don't touch) |
|-------------------------------|------------------------------|
| `src/core/compression.ts` | `src/adapters/claude-code/adapter.ts` |
| `src/core/token-estimator.ts` | `src/adapters/cursor/adapter.ts` |
| `src/core/prompt-builder.ts` | `src/adapters/codex/adapter.ts` |
| `src/core/conversation-analyzer.ts` | `src/adapters/base-adapter.ts` |
| `src/cli/index.ts` | `src/adapters/index.ts` |
| `tests/core/*` | `src/core/project-context.ts` |
| `tests/e2e/*` | `src/core/watcher.ts` |
| | `tests/adapters/*` |
| | `tests/fixtures/*` |
| | `tests/watcher/*` |

## How to Test

```bash
# Pull latest
git pull origin main
npm install

# Run all tests
npm test

# Smoke test all commands
npx tsx src/cli/index.ts detect
npx tsx src/cli/index.ts info
npx tsx src/cli/index.ts list
npx tsx src/cli/index.ts handoff --source claude-code
npx tsx src/cli/index.ts handoff --source claude-code --target cursor --tokens 5000

# Check output quality
cat .handoff/RESUME.md
# Verify: git branch correct, decisions populated, task description makes sense

# Test built version
npm run build
node dist/cli/index.js detect
```
