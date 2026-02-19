# AgentRelay — Kushal's Task Sheet (Round 4)

## Status

Rounds 1-3 are merged (PRs #2, #4, #6). All 3 adapters working, 63 tests passing. The core pipeline is complete.

**Round 4 goal:** Implement the `watch` command — a background watcher that monitors agent session directories for changes (new messages, rate limit signals) and can trigger automatic handoffs. This is the last major feature before v0.2.0 ships.

## Your Branch: `feat/watcher`

```bash
git checkout main
git pull origin main
npm install
git checkout -b feat/watcher
```

---

## Context: What exists now

- `src/core/watcher.ts` — Stub class with `start()`, `stop()`, `getState()` methods (all throw "Not implemented")
- `src/types/index.ts` — Has `WatcherState` interface: `{ timestamp, agents, activeSessions }`
- `chokidar` is already in `package.json` dependencies
- `src/cli/index.ts` — Has stub `watch` command that prints "not implemented yet" (Prateek will wire it up after you build the core)
- All 3 adapters have `detect()` and `listSessions()` methods you can use to discover what to watch

---

## Tasks (in order)

### Task 1: Design the watcher event system

**File:** `src/types/index.ts`

Add these interfaces (coordinate with Prateek — this is a shared file):

```typescript
export interface WatcherEvent {
  type: "session-update" | "new-session" | "rate-limit" | "idle";
  agentId: AgentId;
  sessionId?: string;
  timestamp: string;
  details?: string;
}

export interface WatcherOptions {
  agents?: AgentId[];
  interval?: number;       // polling interval in ms (default: 30000)
  projectPath?: string;    // only watch sessions for this project
  onEvent?: (event: WatcherEvent) => void;
}
```

Update `WatcherState` to track more detail:

```typescript
export interface WatcherState {
  timestamp: string;
  agents: AgentId[];
  activeSessions: Record<string, {
    messageCount: number;
    lastCheckedAt: string;
    lastChangedAt?: string;
  }>;
  running: boolean;
}
```

### Task 2: Implement the watcher core

**File:** `src/core/watcher.ts`

The watcher does NOT use chokidar's file-change events directly (agent session files update unpredictably). Instead, use a **polling approach**:

1. `start(options)` —
   - Determine which agents to watch (default: all detected agents)
   - Set up a `setInterval` that runs every `options.interval` ms (default 30s)
   - Each tick: call `adapter.listSessions(projectPath)` for each agent
   - Compare with previous snapshot: detect new sessions, message count changes
   - Emit events via `options.onEvent` callback
   - Rate limit detection: if a session's message count stops growing AND the last message was from the assistant (mid-response), emit a `"rate-limit"` event. Use a simple heuristic: if 2+ consecutive checks show the same message count, consider it potentially rate-limited.

2. `stop()` —
   - Clear the interval
   - Set `running = false`
   - Update state timestamp

3. `getState()` — Return current `WatcherState`

4. `takeSnapshot()` — Public method. Capture current session counts for all watched agents and return a `WatcherState`. The polling loop calls this internally, but the CLI can also call it for a one-shot check.

Key implementation notes:
- Use `getAdapter()` and `adapter.listSessions()` from `src/adapters/index.ts`
- Store previous snapshot to diff against
- Handle errors gracefully — if an adapter throws, log it and continue watching other agents
- The watcher should be a singleton-style class (only one instance running at a time)

### Task 3: Add rate limit detection heuristics

**File:** `src/core/watcher.ts`

Simple heuristics for detecting when an agent has hit a rate limit:

1. **Stale session:** Message count unchanged across 2+ polling intervals
2. **Session growth then stop:** Session was actively growing (message count increasing), then stopped
3. **Agent-specific signals (stretch goal):**
   - Claude Code: Check if last JSONL entry contains rate limit keywords ("exceeded", "rate limit", "429")
   - Cursor: Check if SQLite has a rate limit indicator
   - Codex: Check JSONL for rate limit entries

For now, implement heuristics 1 and 2. Emit `WatcherEvent` with `type: "rate-limit"`.

### Task 4: Write watcher tests

**File:** `tests/watcher/watcher.test.ts`

Tests to write:
- `should start watching and detect session updates` — mock adapter.listSessions to return changing message counts
- `should detect new sessions` — second poll returns more sessions than first
- `should emit rate-limit event when session goes stale` — message count unchanged after 2 intervals
- `should handle adapter errors gracefully` — one adapter throws, others still work
- `should stop watching and clear interval` — verify cleanup
- `should only watch specified agents` — pass `agents: ["claude-code"]`, verify others not polled
- `should filter by project path` — pass `projectPath`, verify it's forwarded to adapters

Testing approach:
- Mock adapters using `vi.spyOn` on `getAdapter()` from `src/adapters/index.ts`
- Use `vi.useFakeTimers()` to control polling intervals
- Collect events via the `onEvent` callback
- No real file system needed — mock at the adapter layer

### Task 5: Export watcher from barrel files

**Files:**
- `src/core/watcher.ts` — make sure the class and types are properly exported
- Verify `src/types/index.ts` exports the new interfaces

---

## Files you'll create or edit

| File | Action |
|------|--------|
| `src/types/index.ts` | **Edit** — add WatcherEvent, WatcherOptions, update WatcherState |
| `src/core/watcher.ts` | **Rewrite** (replace stub with full implementation) |
| `tests/watcher/watcher.test.ts` | **Create new** |

## Files NOT to touch

- `src/cli/index.ts` — Prateek will wire the CLI after your core is done
- `src/core/compression.ts` — Prateek owns this
- `src/core/prompt-builder.ts` — Prateek owns this
- `tests/core/*` — Prateek owns these
- `tests/e2e/*` — Prateek owns these

---

## Reference: How adapters expose session data

```typescript
// Get an adapter instance
import { getAdapter } from "../adapters/index.js";
const adapter = getAdapter("claude-code");

// List sessions (returns SessionInfo[])
const sessions = await adapter.listSessions(projectPath);
// Each session has: id, startedAt, lastActiveAt, messageCount, projectPath, preview

// Detect if agent is installed
const detected = await adapter.detect();
```

The watcher should call `listSessions()` periodically and diff against the previous result.

## Cross-platform note

Your Cursor adapter tests had a bug where `APPDATA` was used to redirect paths — that only works on Windows. On Linux, the adapter uses `os.homedir() + .config/...`. I fixed this in PR #6 by mocking `os.homedir()` instead. **Follow the same pattern in watcher tests** — mock at the adapter layer, not the filesystem.

## When You're Done

```bash
# Verify
npx tsc --noEmit
npx vitest run

# Push
git add -A
git commit -m "feat: watcher core with polling and rate-limit detection"
git push -u origin feat/watcher
gh pr create --base main --title "feat: watcher with rate-limit detection"
```

Tell Prateek so he can review, merge, and wire up the CLI.
