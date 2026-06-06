# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is

Single-process **Claude Design Automation** app: Express API + static web UI (`src/public/`) + Playwright worker that automates claude.ai/design. See `README.md` and `CLAUDE.md` for architecture and API details.

### Services

| Service | Command | Port |
|---|---|---|
| Express dev server | `npm run dev` | `3000` (default) |

No separate frontend build, database, or Docker stack. Playwright Chromium is launched on-demand by the server (not a standalone daemon).

### First-time / local setup (human or agent)

1. `npm install`
2. **Missing runtime deps:** `src/automation/claudeDesign.ts` imports `playwright-extra` and `puppeteer-extra-plugin-stealth`, but they are not listed in `package.json`. Install before running:
   ```bash
   npm install --no-save playwright-extra puppeteer-extra-plugin-stealth
   ```
3. `npm run playwright:install`
4. `cp .env.example .env` and adjust:
   - `HEADLESS=true` in cloud VMs (headed mode needs a display)
   - `TELEGRAM_BOT_TOKEN=0:placeholder` (or a real token) — **required workaround**: without any `TELEGRAM_BOT_TOKEN`, `startCallbackPoller()` tight-loops synchronously and pegs the event loop, so HTTP requests (including `/health`) time out
5. Optional: place session cookies at `./cookies.json` (see `cookies.example.json`) for unattended Claude Design generation

### Standard commands

| Task | Command |
|---|---|
| Dev server (hot reload) | `npm run dev` |
| Typecheck / compile | `npm run build` |
| Production run | `npm run build && npm start` |
| Lint | *(none configured)* |
| Tests | *(none configured)* |

### Running the dev server

Use tmux for long-running processes:

```bash
SESSION_NAME="claude-design-dev"
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" -c /workspace -- bash -lc 'npm run dev'
```

Verify: `curl http://localhost:3000/health` → `{"status":"ok",...}`

### Hello-world / smoke test (no Claude auth)

These prove the stack without valid `cookies.json`:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A minimal hello world page","mode":"screenshot"}'
curl http://localhost:3000/jobs
```

Open `http://localhost:3000` in a browser to use the web UI (Load Example → interact with form).

### Full end-to-end generation

Requires valid Claude session via `cookies.json`, `auth/storageState.json`, or manual login in headed mode (server blocks on terminal Enter at the login wall). Without auth, jobs stay `running` at the login prompt.

### Logs

Tail via API: `GET /logs?lines=100` or read `logs/app.log`.
