# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bitbucket AI Code Review — Node.js + Express web tool that automates code review using Claude CLI. Fetches PR diffs from Bitbucket API 2.0, sends them to Claude for analysis, displays review suggestions in a browser SPA, and publishes approved comments back to Bitbucket.

## Commands

```bash
# Run
node index.js                    # Starts server on port 5177, auto-opens browser
node index.js --port 3000        # Custom port

# Test (Node built-in test runner)
npm test                         # All tests
npm run test:parser              # Diff parser only
npm run test:bitbucket           # Bitbucket API client only
npm run test:claude              # Claude prompt building & JSON parsing only
npm run test:server              # Express API endpoints only
```

No build step, no linter configured.

## Architecture

**ES Modules** (`"type": "module"` in package.json). No frontend framework — vanilla JS SPA in `public/index.html`.

### Core flow

1. Frontend sends `POST /api/start-review` with Bitbucket credentials + PR info
2. Server runs async pipeline: fetch PR info → fetch raw diff → parse diff → spawn `claude -p` subprocess → parse JSON from stdout
3. Progress broadcasted to frontend via **SSE** (`GET /api/stream`)
4. User approves/rejects each comment; approved ones posted to Bitbucket via REST API

### Key modules

- **`src/server.js`** — Express routes + SSE broadcasting + in-memory state (`currentReview`, `sseClients`, `activeProcess`). Single review at a time (new review kills previous subprocess).
- **`src/bitbucket.js`** — Bitbucket API 2.0 client. Credentials passed as params (never stored in module). Basic Auth. `testConnection()` never throws; API operations throw on HTTP errors.
- **`src/claude.js`** — Spawns `claude -p --add-dir <repoPath>` subprocess with stdin prompt. 10-minute timeout. Diff truncated to 80k chars. JSON extraction tries: `` ```json ``` `` block → first `{` to last `}` → error.
- **`src/parser.js`** — Unified diff parser (line-by-line state machine). Tracks new-file line numbers per hunk. `getDiffContext()` returns surrounding lines for UI display.
- **`review-agent.md`** — System prompt for Claude during code review (Polish, Laravel/Vue specific rules). This is the core review instruction set.

### State & persistence

- **No database** — review logs saved as `logs/{prId}_{timestamp}.json`
- **In-memory server state** — not persisted across restarts
- **Credentials** — stored in browser localStorage, sent per-request

### API response pattern

All endpoints return `{ ok: true/false, error?: string }`.

## Testing

Tests use Node's built-in `node:test` module + `node:assert`. HTTP calls are mocked in tests. No test framework dependencies.
