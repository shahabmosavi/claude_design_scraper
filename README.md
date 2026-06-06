# Claude Design Automation

A local Express and Playwright service that sends prompts to [Claude Design](https://claude.ai/design), waits for generated UI work, saves screenshots, and optionally posts completion updates to Telegram and Jira.

The service is built around an asynchronous job queue: requests enqueue work, a single browser worker processes one job at a time, and clients poll for completion.

## Documentation

- [API reference](./docs/API.md) - REST endpoints, request/response examples, and polling flow.
- [Integrations](./docs/INTEGRATIONS.md) - Telegram notifications/retry buttons and Jira webhook/task setup.
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - login, selectors, browser, logs, and known limitations.
- [CLAUDE.md](./CLAUDE.md) - maintainer notes for AI coding agents working in this repo.

## Project structure

```text
src/server.ts                 Express server, queue worker, REST API, Telegram/Jira hooks
src/automation/claudeDesign.ts Playwright browser automation and Claude Design flow
src/automation/selectors.ts    Resilient DOM selector helpers
src/automation/cookies.ts      Cookie loading and injection
src/public/                    Static vanilla HTML/CSS/JS web UI
docker/nginx/default.conf      Optional nginx reverse proxy
logs/                          Runtime logs and failed-job retry cache (gitignored)
outputs/                       Diagnostic and result screenshots (gitignored except .gitkeep)
```

## How it works

1. A client sends a prompt to `POST /generate`.
2. The server validates the prompt, creates a job, and immediately returns `202` with `{ jobId, status }`.
3. A serial worker opens or reuses a Chromium context, navigates to `CLAUDE_DESIGN_URL`, starts a new sketch, switches to Sonnet, submits the prompt, and waits for Claude Design to finish.
4. The worker saves a diagnostic screenshot before submit and a final screenshot after generation to `OUTPUT_DIR`.
5. If Claude Design asks clarifying questions, the job moves to `awaiting_answer` and waits up to 30 minutes for a Telegram reply.
6. On success, the job result includes `/outputs/<filename>` and, when available, the Claude Code share command used by the Jira integration.
7. Clients poll `GET /jobs/:id` until the job is `done` or `failed`.

## Installation

```bash
# Install Node.js dependencies
npm install

# Download the Playwright Chromium browser
npm run playwright:install
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_DESIGN_URL` | project URL | Claude Design project to open |
| `HEADLESS` | `false` | Run Chromium headlessly (`true`/`false`) |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent Chromium profile directory |
| `OUTPUT_DIR` | `./outputs` | Where diagnostic and result screenshots are saved |
| `COOKIE_FILE` | `./cookies.json` | Path to session cookies file |
| `TIMEOUT_MS` | `180000` | Max milliseconds to wait for generation |
| `PORT` | `3000` | Express server port |
| `TELEGRAM_BOT_TOKEN` | unset | Enables Telegram bot API calls when paired with `TELEGRAM_CHAT_ID` |
| `TELEGRAM_CHAT_ID` | unset | Chat that receives queue, completion, failure, retry, and question messages |
| `JIRA_BASE_URL` | unset | Jira Cloud base URL used by the webhook/task integration |
| `JIRA_EMAIL` | unset | Jira account email for API authentication |
| `JIRA_API_TOKEN` | unset | Jira API token |
| `JIRA_PROJECT_KEY` | unset | Jira project key for follow-up implementation tasks |
| `SAVE_STORAGE_STATE` | unset | Set to `true` to save `auth/storageState.json` after manual login |

## Providing cookies (recommended)

Cookies let the automation log in without manual interaction.

1. Log in to [claude.ai](https://claude.ai) in your browser.
2. Open DevTools -> Application -> Cookies -> `https://claude.ai`.
3. Export cookies as either a plain Playwright cookie array or the j2team/EditThisCookie format.
4. Save them to the file configured by `COOKIE_FILE` (default `./cookies.json`).

Example Playwright cookie array:

```json
[
  {
    "name": "sessionKey",
    "value": "YOUR_VALUE",
    "domain": ".claude.ai",
    "path": "/",
    "httpOnly": true,
    "secure": true,
    "sameSite": "Lax"
  }
]
```

See `cookies.example.json` for a full template.

> Security: `cookies.json`, `.env`, browser profiles, `auth/storageState.json`, logs, and generated screenshots are gitignored. Treat cookie and token values like passwords and never paste them into logs or screenshots.

## Manual login

If cookies are missing or expired, the browser opens in headed mode and the terminal prints:

```text
Please log in manually in the opened browser, then press Enter in the terminal to continue.
```

Log in to claude.ai in the browser window, then press Enter in the terminal. To persist the session for later runs, set `SAVE_STORAGE_STATE=true`; the storage state is saved to `./auth/storageState.json`.

## Running the project

```bash
# Development (auto-reloads with tsx)
npm run dev

# Production build
npm run build
npm start
```

The server listens on [http://localhost:3000](http://localhost:3000) by default.

> Web UI caveat: `src/public/app.js` currently expects an older synchronous `/generate` response shape. The REST API documented in [docs/API.md](./docs/API.md) is the canonical interface until the web UI is updated to poll jobs.

## Running a generation from the command line

Create a job:

```bash
curl -i -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A minimal SaaS pricing page with three tiers", "mode": "screenshot"}'
```

Poll the returned job ID:

```bash
curl http://localhost:3000/jobs/<jobId>
```

When the job is `done`, the final screenshot is available at the `result.screenshotPath` URL.

## Nginx reverse proxy

The optional Docker Compose setup runs nginx on port 80 and proxies:

- `/` to the Express app on `host.docker.internal:3000`
- `/mcp` to `host.docker.internal:38629/mcp`

Start it with:

```bash
docker compose up -d
```

The nginx server block lives in [`docker/nginx/default.conf`](./docker/nginx/default.conf). Update `server_name` and DNS records for the domain where you deploy it.

## Known limitations

- The queue is in memory, so queued/running/done jobs reset on restart. Failed jobs are cached in `logs/failed-jobs.json` for Telegram retry buttons.
- Claude's UI can change and break selectors. Update `src/automation/selectors.ts` when prompt input or submit behavior changes.
- Cookie sessions expire. Re-export cookies or use manual login when auth fails.
- CAPTCHA and bot challenges may require headed manual intervention.
- `mode: "screenshot"` is the reliable path. `mode: "text"` is best-effort and may return `null`.
- The browser context is shared and jobs are processed serially; concurrent requests queue behind each other.
