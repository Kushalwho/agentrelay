# Braindump v1.0 — Kushal's Task Sheet

## Status

v0.5.0 is on main. Prateek has merged (or is merging) the shared infra PR (`feat/v1-infra`) which adds:
- `AgentId` type expanded to 7 agents
- 4 new agent registry entries (copilot, gemini, opencode, droid)
- `ToolActivitySummary` interface + `SummaryCollector` class
- Stub adapters in `src/adapters/index.ts` (return `detect() = false`)
- Zod validation updated for new agent IDs

**Your job:** Replace the 4 stubs with real working adapters.

---

## Quick Start

```bash
git checkout main
git pull origin main
npm install

# First PR: Copilot + Gemini
git checkout -b feat/copilot-gemini

# After that PR merges:
git checkout main && git pull
git checkout -b feat/droid-opencode
```

---

## Architecture Pattern

Every adapter follows the same pattern. Extend `BaseAdapter`, implement 4 methods:

```typescript
import { BaseAdapter } from "../base-adapter.js";
import type { AgentId, CapturedSession, SessionInfo } from "../../types/index.js";

export class CopilotAdapter extends BaseAdapter {
  agentId: AgentId = "copilot";

  async detect(): Promise<boolean> { /* check if storage dir exists */ }
  async listSessions(projectPath?: string): Promise<SessionInfo[]> { /* find sessions */ }
  async capture(sessionId: string): Promise<CapturedSession> { /* parse full session */ }
  async captureLatest(projectPath?: string): Promise<CapturedSession> { /* list + capture first */ }
}
```

Use `validateSession()` from `src/core/validation.ts` before returning any `CapturedSession`.

Use `SummaryCollector` from `src/core/tool-summarizer.ts` to populate `session.toolActivity`:

```typescript
import { SummaryCollector } from "../../core/tool-summarizer.js";

// During capture:
const collector = new SummaryCollector();
collector.record("Bash", "npm test -> exit 0");
collector.record("Edit", "edit src/auth.ts (+5 -2)");
// ...
session.toolActivity = collector.getSummaries();
```

---

## Reference: How `cli-continues` Does It

Repo: **https://github.com/yigitkonur/cli-continues** (npm: `continues`)

Their parsers live in `src/parsers/`. Each exports two functions:
- `parse<Tool>Sessions()` — discover sessions
- `extract<Tool>Context()` — extract conversation

We use the `BaseAdapter` class instead but the parsing logic is similar. Use their parsers as a **format reference** for the data structures, but write our code in the braindump pattern.

---

## Task 1: Copilot Adapter

**File:** `src/adapters/copilot/adapter.ts`

### Storage Format

```
~/.copilot/session-state/<session-id>/
  ├── workspace.yaml    # Session metadata
  └── events.jsonl      # Conversation events
```

### workspace.yaml format

```yaml
sessionId: "abc-123"
repository: "user/repo"
branch: "main"
workingDirectory: "/home/user/project"
summary: |
  Working on implementing auth system...
createdAt: "2026-01-15T10:00:00Z"
updatedAt: "2026-01-15T11:30:00Z"
```

Parse with the `yaml` npm package (already added to dependencies by Prateek).

### events.jsonl format

Each line is a JSON event:

```json
{"type": "session.start", "timestamp": "...", "selectedModel": "gpt-4o"}
{"type": "user.message", "content": "Fix the login bug", "timestamp": "..."}
{"type": "assistant.message", "content": "I'll fix that...", "toolRequests": [...], "timestamp": "..."}
```

Event types to handle:
- `session.start` — extract model info
- `user.message` — extract `content` (or `transformedContent` fallback)
- `assistant.message` — extract `content` + optional `toolRequests[]`

### Implementation Notes

1. **detect():** Check if `~/.copilot/session-state/` exists and has subdirectories with `workspace.yaml`
2. **listSessions():** Iterate dirs, parse each `workspace.yaml` for metadata. Filter by `workingDirectory` if `projectPath` given
3. **capture():** Read `workspace.yaml` for metadata + stream `events.jsonl` for messages. If no messages, synthesize from workspace `summary` field
4. **Tool activity:** Copilot has sparse tool data (only metadata in `toolRequests`). Record what's available
5. **captureLatest():** List sessions sorted by `updatedAt`, capture first

### Test

**File:** `tests/adapters/copilot.test.ts`

Create temp dir structure with `workspace.yaml` + `events.jsonl` fixtures:
- `should detect copilot sessions`
- `should list sessions filtered by project path`
- `should capture session with messages`
- `should handle missing events.jsonl gracefully`
- `should synthesize from workspace summary when no messages`

---

## Task 2: Gemini CLI Adapter

**File:** `src/adapters/gemini/adapter.ts`

### Storage Format

```
~/.gemini/tmp/<project-hash>/chats/session-<timestamp>.json
```

Each file is a single JSON (not JSONL):

```json
{
  "sessionId": "session-1234567890",
  "messages": [
    {
      "role": "user",
      "parts": [{"text": "Fix the login bug"}],
      "toolCalls": [],
      "thoughts": []
    },
    {
      "role": "model",
      "parts": [{"text": "I'll look at the auth code..."}],
      "toolCalls": [
        {
          "name": "write_file",
          "args": {"path": "src/auth.ts", "content": "..."},
          "result": "File written",
          "resultDisplay": {
            "fileName": "auth.ts",
            "filePath": "src/auth.ts",
            "diffStat": {"model_added_lines": 10, "model_removed_lines": 3},
            "isNewFile": false
          }
        }
      ],
      "thoughts": [
        {"subject": "approach", "description": "Using JWT tokens for auth"}
      ]
    }
  ],
  "model": "gemini-2.5-pro",
  "tokenUsage": {"inputTokens": 1234, "outputTokens": 567}
}
```

### Implementation Notes

1. **detect():** Check if `~/.gemini/tmp/` exists and has `*/chats/session-*.json` files
2. **listSessions():** Glob for `*/chats/session-*.json`, parse each JSON for metadata (sessionId, first message preview, timestamps)
3. **capture():**
   - Map `role: "model"` → `"assistant"`
   - Extract text from `parts[].text`
   - Rich tool data: file changes from `toolCalls[].resultDisplay` with `diffStat`, `isNewFile`
   - Extract thoughts → decisions (especially ones with "todo"/"next"/"remaining" keywords → remaining tasks)
   - Token usage from `tokenUsage` field
4. **Tool activity:** Gemini has rich tool data. Use `SummaryCollector`:
   - `write_file` → `collector.record("Edit", "edit src/auth.ts (+10 -3)")`
   - `read_file` → `collector.record("Read", "read src/auth.ts")`
   - MCP tools → `collector.record("MCP", "tool_name(args)")`

### Test

**File:** `tests/adapters/gemini.test.ts`

Create temp JSON fixture files:
- `should detect gemini sessions`
- `should list sessions from multiple project hashes`
- `should capture session with tool calls and thoughts`
- `should extract file changes from diffStat`
- `should handle empty messages array`

---

## Task 3: Droid (Factory) Adapter

**File:** `src/adapters/droid/adapter.ts`

### Storage Format

```
~/.factory/sessions/<workspace-slug>/
  ├── <uuid>.jsonl            # Session events
  └── <uuid>.settings.json    # Session config
```

### JSONL Event Types

```json
{"type": "session_start", "id": "...", "title": "...", "cwd": "/home/user/project"}
{"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "Fix the bug"}]}}
{"type": "message", "message": {"role": "assistant", "content": [
  {"type": "text", "text": "I'll fix that..."},
  {"type": "tool_use", "id": "...", "name": "Bash", "input": {"command": "npm test"}},
  {"type": "thinking", "thinking": "Need to check test results first..."}
]}}
{"type": "message", "message": {"role": "user", "content": [
  {"type": "tool_result", "tool_use_id": "...", "content": "All tests passed"}
]}}
{"type": "todo_state", "todos": "1. [in_progress] Fix auth bug\n2. [pending] Add tests\n3. [completed] Setup project"}
{"type": "compaction_state", "summaryText": "...", "summaryTokens": 500}
```

### settings.json format

```json
{
  "model": "claude-sonnet-4-20250514",
  "reasoningEffort": "medium",
  "autonomyMode": "full",
  "tokenUsage": {
    "inputTokens": 50000,
    "outputTokens": 12000,
    "cacheCreationTokens": 5000
  }
}
```

### Implementation Notes

1. **detect():** Check if `~/.factory/sessions/` exists and has `*/*.jsonl` files
2. **listSessions():** Walk `~/.factory/sessions/*/` for `.jsonl` files. Read first event for metadata
3. **capture():**
   - Parse Anthropic-style content blocks (`text`, `thinking`, `tool_use`, `tool_result`)
   - Known tools: `Create`, `Read`, `Edit`, `Execute`, `Bash`, `ApplyPatch`, `LS`, `Grep`, `Glob`, plus MCP tools (contain `___` or `-` in name)
   - `todo_state` → parse lines like `"1. [in_progress] Do something"` for `task.remaining`/`task.completed`/`task.inProgress`
   - Read companion `.settings.json` for model, tokenUsage
   - `thinking` blocks → extract as decisions
   - CWD from `session_start.cwd` or workspace slug (convert dashes to `/`)
4. **Tool activity:** Use `SummaryCollector` for each tool_use block:
   - `Bash` → `collector.record("Bash", "npm test")`
   - `Edit` → `collector.record("Edit", "edit src/file.ts")`
   - `Read` → `collector.record("Read", "read src/file.ts")`

### Test

**File:** `tests/adapters/droid.test.ts`

Create temp JSONL + settings.json fixtures:
- `should detect droid sessions`
- `should capture session with tool calls`
- `should parse todo_state into task state`
- `should read settings.json for model and token usage`
- `should handle missing settings.json gracefully`
- `should extract thinking blocks as decisions`

---

## Task 4: OpenCode Adapter

**File:** `src/adapters/opencode/adapter.ts`

### Storage Format — Primary: SQLite

```
~/.local/share/opencode/opencode.db
```

SQLite tables:
- `session` — `id, project_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated`
- `project` — `id, worktree`
- `message` — `id, session_id, time_created, data` (data is JSON string)
- `part` — `id, message_id, session_id, time_created, data` (data is JSON string)

Message data JSON: `{ "role": "user" | "assistant" }`

Part data JSON: `{ "type": "text", "text": "..." }` or `{ "type": "tool-invocation", "toolName": "...", "args": {...}, "result": "..." }`

### Storage Format — Fallback: JSON files

```
~/.local/share/opencode/storage/
  ├── session/<project-hash>/ses_<id>.json
  ├── project/<project-id>.json
  ├── message/<session-id>/msg_<id>.json
  └── part/<message-id>/prt_<id>.json
```

### Implementation Notes

1. **detect():** Check if `~/.local/share/opencode/opencode.db` exists OR `~/.local/share/opencode/storage/` exists
2. **listSessions():**
   - Primary: `SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC`
   - Fallback: Read `storage/session/*/*.json` files
3. **capture():**
   - Primary: `SELECT m.id, m.data, m.time_created FROM message m WHERE m.session_id = ? ORDER BY m.time_created`
   - Then for each message: `SELECT p.data, p.time_created FROM part p WHERE p.message_id = ? ORDER BY p.time_created`
   - Part types: `text` → conversation content, `tool-invocation` → tool messages + file changes
   - Fallback: Read individual JSON files
4. **Important:** Use `better-sqlite3` (already in our deps). Do NOT use `node:sqlite` (that's Node 22+ only, we support Node 18+)
5. **Tool activity:** Parse `tool-invocation` parts for SummaryCollector

### Test

**File:** `tests/adapters/opencode.test.ts`

Create temp SQLite DB fixture:
- `should detect opencode via SQLite DB`
- `should detect opencode via JSON fallback`
- `should list sessions from SQLite`
- `should capture session with text and tool parts`
- `should fall back to JSON when SQLite fails`

---

## Files You Create

| File | Action |
|------|--------|
| `src/adapters/copilot/adapter.ts` | **Create** |
| `src/adapters/gemini/adapter.ts` | **Create** |
| `src/adapters/droid/adapter.ts` | **Create** |
| `src/adapters/opencode/adapter.ts` | **Create** |
| `tests/adapters/copilot.test.ts` | **Create** |
| `tests/adapters/gemini.test.ts` | **Create** |
| `tests/adapters/droid.test.ts` | **Create** |
| `tests/adapters/opencode.test.ts` | **Create** |

## Files NOT to Touch

Everything else. Especially:
- `src/types/index.ts` — Prateek already updated
- `src/core/*` — Prateek's domain
- `src/cli/*` — Prateek's domain
- `src/adapters/index.ts` — Prateek already registered your stubs (you just export the class)
- `src/adapters/claude-code/`, `cursor/`, `codex/` — Prateek is modifying these
- `package.json` — Prateek already added `yaml` dep

---

## Dependencies Available

Already in `package.json` (added by Prateek):
- `better-sqlite3` — for OpenCode SQLite DB
- `yaml` — for Copilot workspace.yaml parsing
- `glob` — for file discovery
- `zod` — for validation

---

## Verification

```bash
npx tsc --noEmit                        # Type check
npx vitest run tests/adapters/copilot   # Your tests
npx vitest run tests/adapters/gemini
npx vitest run tests/adapters/droid
npx vitest run tests/adapters/opencode
npx vitest run                          # All tests still pass

braindump detect                        # Should show all 7 agents
braindump list --source copilot         # Your adapter works
```

---

## When Done

```bash
# PR 1: Copilot + Gemini
git add src/adapters/copilot/ src/adapters/gemini/ tests/adapters/copilot.test.ts tests/adapters/gemini.test.ts
git commit -m "feat: add Copilot + Gemini CLI adapters"
git push -u origin feat/copilot-gemini
gh pr create --base main --title "feat: Copilot + Gemini adapters"

# PR 2: Droid + OpenCode
git add src/adapters/droid/ src/adapters/opencode/ tests/adapters/droid.test.ts tests/adapters/opencode.test.ts
git commit -m "feat: add Droid + OpenCode adapters"
git push -u origin feat/droid-opencode
gh pr create --base main --title "feat: Droid + OpenCode adapters"
```
