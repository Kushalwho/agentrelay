# Braindump — Collaboration Guide

## Current Status (Updated Feb 20, 2026)

**v0.5.0 is shipped.** All 3 adapters + watcher + CLI working. Moving to **v1.0 Sprint — Feature Parity + CLI Overhaul**.

| Milestone | Status |
|-----------|--------|
| PRs #1–#18 (Core, adapters, watcher, CLI, validation, WSL, global DB) | Merged |
| End-to-end pipeline | **Working (3 agents)** |
| Watch command | **Working** |
| CI (GitHub Actions) | Running on Node 18/20/22 |
| npm published | **v0.5.0** |

### v1.0 Sprint Goal

Reach **feature parity** with the competitor tool [`continues`](https://github.com/yigitkonur/cli-continues) (npm: `continues`) and go beyond. They have 7 agent parsers, interactive TUI, auto-launch, and tool activity summaries. We have better compression, project enrichment, and watch mode. This sprint closes the gap.

**Target:** 7 agents, interactive TUI, auto-launch, tool summaries, `--json` output, session caching, streaming JSONL.

---

## Team

| Who | Role | v1.0 Focus |
|-----|------|------------|
| **Prateek** | Core engine + CLI + infra | Shared infra, TUI, auto-launch, streaming, caching, `--json`, tool summaries, CLAUDE.md |
| **Kushal** | Data layer + adapters | 4 new adapters: Copilot, Gemini, OpenCode, Droid |

Both work in parallel on separate branches. **No file conflicts** — Kushal only touches `src/adapters/<new>/` and `tests/adapters/<new>*`, Prateek only touches `src/cli/`, `src/core/`, and shared infra.

---

## The Contract: `CapturedSession`

Both sides meet at the `CapturedSession` interface in `src/types/index.ts`.

- **Kushal** builds adapters that **produce** `CapturedSession` objects
- **Prateek** builds the engine/CLI that **consumes** them

### New in v1.0: `ToolActivitySummary`

```typescript
// Added to CapturedSession
toolActivity?: ToolActivitySummary[];

export interface ToolActivitySummary {
  name: string;       // e.g. "Bash", "Edit", "Read"
  count: number;      // e.g. 47
  samples: string[];  // Up to 3 one-liner examples
}
```

Use the shared `SummaryCollector` class from `src/core/tool-summarizer.ts` to populate this field.

### New AgentId type

```typescript
export type AgentId = "claude-code" | "cursor" | "codex" | "copilot" | "gemini" | "opencode" | "droid";
```

---

## v1.0 PR Sequence

| # | PR | Owner | Branch | Depends on |
|---|-----|-------|--------|------------|
| 1 | Shared infra (types, registry, tool-summarizer, CLAUDE.md) | Prateek | `feat/v1-infra` | — |
| 2 | Copilot + Gemini adapters | Kushal | `feat/copilot-gemini` | PR #1 |
| 3 | Droid + OpenCode adapters | Kushal | `feat/droid-opencode` | PR #1 |
| 4 | Streaming JSONL + session caching + --json output | Prateek | `feat/streaming-cache` | PR #1 |
| 5 | Interactive TUI + auto-launch | Prateek | `feat/interactive-tui` | PR #4 |
| 6 | Tool activity summaries in existing adapters | Prateek | `feat/tool-activity` | PR #1 |
| 7 | v1.0 polish + README + version bump | Prateek | `feat/v1-release` | All above |

---

## What Prateek Is Building (DO NOT TOUCH these files)

| File | Change |
|------|--------|
| `src/types/index.ts` | Added `ToolActivitySummary`, expanded `AgentId` |
| `src/core/registry.ts` | Added 4 new agent entries |
| `src/core/validation.ts` | Updated Zod `source` enum |
| `src/adapters/index.ts` | Registered 4 new adapter stubs |
| `src/core/tool-summarizer.ts` | **New** — `SummaryCollector` class |
| `src/core/launcher.ts` | **New** — Target tool auto-launcher |
| `src/core/session-cache.ts` | **New** — JSONL session index cache |
| `src/cli/index.ts` | Interactive TUI, `--json`, auto-launch |
| `src/core/prompt-builder.ts` | Tool activity section in RESUME.md |
| `src/core/compression.ts` | Tool activity as priority layer 4.5 |
| `src/adapters/claude-code/adapter.ts` | SummaryCollector integration |
| `src/adapters/codex/adapter.ts` | SummaryCollector integration |
| `src/adapters/cursor/adapter.ts` | SummaryCollector integration |
| `CLAUDE.md` | Architecture doc |
| `package.json` | New deps (`@clack/prompts`, `yaml`) |

## What Kushal Is Building (HIS files)

| File | Action |
|------|--------|
| `src/adapters/copilot/adapter.ts` | **Create** — Copilot parser |
| `src/adapters/gemini/adapter.ts` | **Create** — Gemini CLI parser |
| `src/adapters/droid/adapter.ts` | **Create** — Factory Droid parser |
| `src/adapters/opencode/adapter.ts` | **Create** — OpenCode parser |
| `tests/adapters/copilot.test.ts` | **Create** — Copilot tests |
| `tests/adapters/gemini.test.ts` | **Create** — Gemini tests |
| `tests/adapters/droid.test.ts` | **Create** — Droid tests |
| `tests/adapters/opencode.test.ts` | **Create** — OpenCode tests |

---

## Branch Workflow

```bash
# Always start from latest main (after Prateek merges PR #1)
git checkout main
git pull origin main

# Create your feature branch
git checkout -b feat/copilot-gemini       # (Kushal — first PR)
git checkout -b feat/droid-opencode       # (Kushal — second PR)

# Work, commit frequently
git add <files> && git commit -m "description"

# Push your branch
git push -u origin feat/copilot-gemini

# Create PR to main
gh pr create --base main --title "feat: Copilot + Gemini adapters"
```

## How to Test

```bash
git pull origin main
npm install

npx tsc --noEmit          # Type check
npx vitest run            # All tests
braindump detect          # Should show all 7 agents
braindump list --source copilot  # Your adapter
```

---

## Reference: Competitor (`cli-continues`)

Repo: **https://github.com/yigitkonur/cli-continues** (npm: `continues`)

Their parser architecture (for reference — don't copy code, just use as format reference):
- `src/parsers/copilot.ts` — YAML + JSONL events
- `src/parsers/gemini.ts` — Single JSON per session
- `src/parsers/droid.ts` — JSONL + companion settings.json
- `src/parsers/opencode.ts` — SQLite DB or JSON fallback
- `src/parsers/claude.ts`, `src/parsers/codex.ts`, `src/parsers/cursor.ts`

Key difference: They export `parse<Tool>Sessions()` + `extract<Tool>Context()` functions. We use the `BaseAdapter` class pattern with `detect()`, `listSessions()`, `capture()`, `captureLatest()`.
