# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Run with tsx (no build step, hot-reload)
npm run build            # Compile TypeScript → dist/
npm start                # Run compiled dist/server.js
npm run playwright:install  # Download Chromium for Playwright
npx tsc --noEmit         # Type-check without emitting (no test suite exists)
```

## Environment

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_DESIGN_URL` | (hardcoded project URL) | Claude Design project to automate — change this to your own project |
| `HEADLESS` | `false` | Run Chromium headlessly |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent Chromium profile (keeps login session) |
| `COOKIE_FILE` | `./cookies.json` | Session cookies (j2team or plain Playwright array format) |
| `OUTPUT_DIR` | `./outputs` | Where screenshots land |
| `TIMEOUT_MS` | `1800000` | Max ms to wait for Claude Design to finish generating |
| `PORT` | `3000` | Express server port |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | _(unset)_ | Enables job notifications and retry-via-button |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | _(unset)_ | Enables Jira task creation on job completion |
| `SAVE_STORAGE_STATE` | _(unset)_ | Set `true` to save `auth/storageState.json` after manual login |

## Architecture

**Entry point:** `src/server.ts` — Express server. All logs are written to `logs/app.log` and tee'd to stdout/stderr. All console output goes through the log wrapper at the top.

**Job queue (`src/server.ts`):**
Jobs are processed serially by a single async worker (`runWorker`). The queue is in-memory (`Map<string, Job>` + `string[]`), so it resets on restart. Failed jobs are persisted to `logs/failed-jobs.json` so the Telegram retry button works across restarts. Job statuses: `queued → running → (awaiting_answer →) done | failed`.

**Automation layer:**
- `src/automation/claudeDesign.ts` — Core Playwright logic. Manages a **single shared `BrowserContext`** (module-level singleton). On init, tries to reconnect to an existing Chrome via CDP on port 9222 before launching a new one. Applies comprehensive stealth init scripts on every context to defeat Cloudflare bot detection. Key exports: `generate()`, `submitAnswer()`, `refreshPage()`, `closeBrowser()`, `onBrowserCrash()`.
- `src/automation/selectors.ts` — DOM-selector helpers: `findPromptInput()` tries 8 strategies, `submitPrompt()` tries 5 button strategies then falls back to Enter, `isLoginPage()` requires an actual form field (not just nav text).
- `src/automation/cookies.ts` — Cookie file I/O and injection. Accepts plain Playwright array or j2team/EditThisCookie format.

**Frontend:** `src/public/` — vanilla HTML/CSS/JS, no build step.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/generate` | Enqueue a design job. Body: `{ prompt, mode: "screenshot"\|"text" }`. Returns `{ jobId, status }`. |
| `POST` | `/jira` | Jira webhook — enqueues a job from `issue.description` (or `summary`). |
| `GET` | `/jobs/:id` | Poll job status and result. |
| `GET` | `/jobs` | List all jobs (summary). |
| `GET` | `/jobs/pending` | List queued/running jobs. |
| `GET` | `/health` | Queue length and worker state. |
| `GET` | `/logs?lines=N` | Tail the last N lines of `logs/app.log`. |

## Generation flow

1. `generate()` navigates to `CLAUDE_DESIGN_URL`, handles Cloudflare challenges, checks for login wall, clicks "New sketch" to start a fresh conversation, switches the model to Sonnet (hardcoded in `selectModel()` call inside `generate()`), finds the prompt input, submits.
2. Before submitting, a diagnostic screenshot (`diag-<timestamp>.png`) is saved to `OUTPUT_DIR` to capture the page state.
3. `waitForResult()` polls for Claude Design's completion signals (`"View code"`, `"Preview"`, etc.) in 4 phases: stop-writing signal → canvas populated → network idle → fallback text-growth check.
4. If Claude Design asks clarifying questions instead of generating, `questions` is returned. The server pauses the job, sends questions via Telegram, waits up to **30 min** for a reply, then calls `submitAnswer()` to continue.
5. On success: screenshot is saved, then `getShareCommand()` clicks Share → Send to Claude Code → Copy command and captures the clipboard text.
6. If `JIRA_*` vars are set, a Jira task is created with the screenshot URL and share command.
7. `refreshPage()` reloads the design URL to give the next job a clean slate.

`mode: "text"` attempts best-effort extraction of the assistant's response text via DOM selectors — it often returns `null` if the selectors don't match. `mode: "screenshot"` is the reliable path.

Interrupted generations (no success/question signal after `waitForResult`) are retried up to `MAX_RETRIES = 3` times, clicking the "Retry" button if visible or reloading and re-submitting.

## Auth flow

1. If `COOKIE_FILE` exists → inject cookies into the context before navigation.
2. If login page detected → print message, wait for terminal Enter (manual login).
3. `SAVE_STORAGE_STATE=true` → save `auth/storageState.json` after manual login.
4. Browser profile at `BROWSER_PROFILE_DIR` persists sessions across server restarts.

## Docker / nginx

`docker-compose.yml` runs an nginx reverse proxy (`docker/nginx/default.conf`) that forwards external HTTP traffic to the Express server on `host.docker.internal`. Used to expose the `/jira` webhook endpoint publicly without putting the Node server on port 80 directly.

## Key constraints

- `cookies.json` and `auth/storageState.json` are gitignored secrets — never log or expose their values.
- The shared context must be closed on `SIGINT`/`SIGTERM` via `closeBrowser()`.
- `waitForResult()` is intentionally resilient — always takes a screenshot even on timeout.
- `tsconfig.json` includes `"DOM"` in lib because `page.evaluate()` callbacks run in browser context.
- The Telegram callback poller (`startCallbackPoller`) runs as an infinite background loop — it uses long-polling (20 s timeout) and is started once at server boot.
- There is no test suite. Use `npx tsc --noEmit` to verify types.
