# Troubleshooting

Use this guide when a job gets stuck, fails, or produces an unexpected screenshot.

## Start with logs and screenshots

The server writes all console output to `logs/app.log` and mirrors it to stdout/stderr. Useful runtime endpoints:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/jobs/pending
curl "http://localhost:3000/logs?lines=200"
```

For each generation, the automation saves:

- `outputs/diag-<timestamp>.png` before submitting the prompt.
- `outputs/design-<timestamp>.png` after generation or timeout.

The diagnostic screenshot is often the fastest way to see whether the browser is logged out, stuck behind a challenge, on the wrong page, or missing expected controls.

## Authentication problems

Symptoms:

- Browser lands on a sign-in page.
- Logs show `[auth] Login page detected.`
- Jobs pause waiting for terminal input.

Fixes:

1. Re-export cookies from an active `claude.ai` session and save them to `COOKIE_FILE`.
2. Verify the cookie format is either a Playwright cookie array or j2team/EditThisCookie object with a `cookies` array.
3. Run headed (`HEADLESS=false`) and complete manual login when prompted.
4. Set `SAVE_STORAGE_STATE=true` if you want `auth/storageState.json` written after manual login.
5. Keep `cookies.json`, `.env`, and `auth/storageState.json` out of version control.

## Cloudflare or bot challenges

The automation applies stealth patches and attempts to handle visible Cloudflare Turnstile challenges. If a challenge does not pass:

1. Run headed with `HEADLESS=false`.
2. Watch the browser window and complete any manual verification.
3. Check `outputs/diag-<timestamp>.png` to confirm whether the challenge remains.
4. Reuse the persistent profile in `BROWSER_PROFILE_DIR` so the passed session carries forward.

The app should not be treated as a challenge bypass tool. Some checks may require manual intervention or may block automation entirely.

## Selector breakage

Symptoms:

- Job fails with `Could not find the prompt input field`.
- Logs show repeated selector attempts with no match.
- The diagnostic screenshot shows Claude Design loaded but controls changed.

Fixes:

1. Inspect the current Claude Design DOM in the opened browser.
2. Update `src/automation/selectors.ts`.
3. Prefer resilient selectors such as roles, `contenteditable`, placeholders, and stable `data-testid` values.
4. Keep `isLoginPage()` strict: it should require actual auth form fields, not just visible "Sign in" navigation text.
5. Run `npx tsc --noEmit` after changes.

## Browser crashes or profile locks

The automation reuses a module-level browser context and first tries to reconnect over CDP on port `9222`. It also attempts to recover from Chrome "Aw, Snap!" pages.

If Chrome cannot launch because the profile is locked:

1. Check whether another server process is already using the same `BROWSER_PROFILE_DIR`.
2. Reuse the existing process when possible instead of starting another one.
3. If the profile is stale, stop the exact stale process by PID and restart the server.
4. Avoid deleting the profile unless you are prepared to log in again.

## Jobs stay queued

Check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/jobs/pending
```

If `workerRunning` is `true`, one job is already active. This is expected: jobs are processed serially because the app shares one browser context. If `workerRunning` is `false` but jobs remain queued, inspect `logs/app.log` for an uncaught worker error and restart the server.

## Jobs fail after Claude asks questions

Clarifying questions require Telegram configuration. Without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, the server cannot collect an answer and the job eventually fails.

Fixes:

1. Configure Telegram.
2. Retry the failed job from Telegram or submit a new prompt with more detail.
3. Answer within the 30-minute wait window when Claude Design asks follow-up questions.

## Text extraction returns `null`

This is expected in many cases. `mode: "text"` checks a small set of assistant-response selectors and returns `null` if the DOM does not expose a matching text block. Use `mode: "screenshot"` when you need reliable output.

## Web UI does not show generated results

The static web UI in `src/public/app.js` still expects a synchronous `/generate` response with `success` and `screenshotPath`. The server now returns `202` with a job ID and requires polling `GET /jobs/:id`.

Until the UI is updated, use the REST API directly as shown in [API.md](./API.md).

## Nginx proxy issues

The Compose-managed nginx container proxies:

- `/` to `host.docker.internal:3000`
- `/mcp` to `host.docker.internal:38629/mcp`

If requests do not reach the app:

1. Confirm the Node server is running on `PORT` from `.env`.
2. Confirm Docker can resolve `host.docker.internal` using the Compose `extra_hosts` entry.
3. Update `server_name` in `docker/nginx/default.conf` for your deployed domain.
4. Confirm public DNS points at the machine running nginx.

## Useful verification commands

```bash
npx tsc --noEmit
npm run build
curl http://localhost:3000/health
```
