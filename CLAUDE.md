# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Run with tsx (no build step, hot-reload)
npm run build            # Compile TypeScript → dist/
npm start                # Run compiled dist/server.js
npm run playwright:install  # Download Chromium for Playwright
```

## Architecture

**Entry point:** `src/server.ts` — Express server with a single `POST /generate` endpoint and static file serving for the frontend.

**Automation layer:**
- `src/automation/claudeDesign.ts` — Core Playwright logic. Manages a **single shared `BrowserContext`** (module-level singleton) that persists across requests to avoid relaunching the browser. Contains `generate()` (main export) and `closeBrowser()`.
- `src/automation/selectors.ts` — DOM-selector helpers: `findPromptInput()` tries 8 strategies in order, `submitPrompt()` tries 5 button strategies then falls back to Enter, `isLoginPage()` detects login walls by URL pattern and DOM.
- `src/automation/cookies.ts` — Cookie file I/O and injection into the Playwright context. Never logs cookie values.

**Frontend:** `src/public/` — vanilla HTML/CSS/JS served as static files. No build step for the frontend.

**Auth flow:**
1. If `COOKIE_FILE` exists → inject cookies before first navigation.
2. If login page is detected → pause and wait for terminal Enter (manual login).
3. `SAVE_STORAGE_STATE=true` → saves `auth/storageState.json` after manual login.
4. Browser profile persisted at `BROWSER_PROFILE_DIR` across runs.

## Key constraints

- `cookies.json` and `auth/storageState.json` are gitignored secrets — never log or expose their values.
- The shared browser context must be closed on `SIGINT`/`SIGTERM` via `closeBrowser()`.
- `waitForResult()` is intentionally resilient — it always takes a screenshot even if result detection fails.
- `tsconfig.json` includes `"DOM"` in lib because `page.evaluate()` callbacks use `document`/`window`.
