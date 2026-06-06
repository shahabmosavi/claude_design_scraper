# Claude Design Automation

A local browser automation tool that sends design prompts to [Claude Design](https://claude.ai/design) using Playwright and captures the results as screenshots.

## How it works

1. You submit a design prompt through a local web UI.
2. The server launches Chromium via Playwright, navigates to your Claude Design project, enters the prompt, waits for generation, and saves a full-page screenshot to `./outputs/`.
3. The screenshot is displayed in the web UI and available for download.

---

## Installation

```bash
# 1. Install Node.js dependencies
npm install

# 2. Install the Playwright Chromium browser
npm run playwright:install
```

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_DESIGN_URL` | (project URL) | The Claude Design project to open |
| `HEADLESS` | `false` | Run browser headlessly (`true`/`false`) |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent Chromium profile directory |
| `OUTPUT_DIR` | `./outputs` | Where screenshots are saved |
| `COOKIE_FILE` | `./cookies.json` | Path to your session cookies file |
| `TIMEOUT_MS` | `180000` | Max ms to wait for generation (3 min) |
| `PORT` | `3000` | Local server port |
| `SAVE_STORAGE_STATE` | _(unset)_ | Set to `true` to save auth state after manual login |

---

## Providing cookies (recommended)

Cookies let the automation log in without manual interaction.

**How to get your cookies:**

1. Log in to [claude.ai](https://claude.ai) in your browser.
2. Open DevTools → Application → Cookies → `https://claude.ai`.
3. Export the relevant session cookies in the format below.

**Format (`cookies.json`):**

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

See `cookies.example.json` for the full template.

> **Security:** `cookies.json` is listed in `.gitignore` and must never be committed. Treat it like a password. The app only passes cookies to the local Playwright browser — they are never logged, forwarded, or exposed to the frontend.

---

## Manual login (if cookies are missing or expired)

If `cookies.json` does not exist, the browser opens in headed mode and the terminal prints:

```
Please log in manually in the opened browser, then press Enter in the terminal to continue.
```

Log in to claude.ai in the browser window, then press **Enter** in the terminal. The automation resumes on the design project page.

To save your session for next time, set `SAVE_STORAGE_STATE=true` in `.env`. The storage state is saved to `./auth/storageState.json` (also gitignored).

---

## Running the project

```bash
# Development (auto-reloads on save)
npm run dev

# Production build
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Nginx reverse proxy

This repo now includes a minimal nginx container that proxies `shahab.dctm.dev` to the app running on `localhost:3000`.

Start it with:

```bash
docker compose up -d
```

The nginx server block lives in [`docker/nginx/default.conf`](./docker/nginx/default.conf) and is already set to `server_name shahab.dctm.dev`.

For the domain to work publicly, `shahab.dctm.dev` still needs an A or CNAME record pointing at this machine's public IP.

---

## Running a single generation from the command line

Use `curl` to call the API directly:

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A minimal SaaS pricing page with three tiers", "mode": "screenshot"}'
```

---

## Known limitations

- **Selector fragility** — Claude's UI can change at any time and break the input/button selectors. The app tries multiple strategies, but a major redesign may require updating `src/automation/selectors.ts`.
- **Session expiry** — Cookie sessions expire. When they do, re-export fresh cookies or use manual login.
- **CAPTCHA / bot challenges** — If Anthropic adds bot detection, you will need to handle it manually in headed mode. The app does not bypass restrictions.
- **Result capture** — Output is primarily screenshot-based. Text extraction is best-effort and may be empty if the DOM structure changes.
- **Concurrency** — The app reuses a single browser context. Concurrent `/generate` requests will queue behind each other.
