import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium, BrowserContext, Page } from "playwright";
import { cookieFileExists, loadCookies, injectCookies } from "./cookies.js";
import { findPromptInput, submitPrompt, isLoginPage } from "./selectors.js";

export interface GenerateOptions {
  prompt: string;
  mode: "screenshot" | "text";
}

export interface GenerateResult {
  success: boolean;
  message: string;
  screenshotPath: string;
  text: string | null;
}

// Module-level context so we reuse the browser across requests
let sharedContext: BrowserContext | null = null;

const CDP_PORT = 9222;

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

async function tryConnectExisting(): Promise<BrowserContext | null> {
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 2000 });
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    console.log(`[browser] Reconnected to existing Chrome on port ${CDP_PORT}`);
    return context;
  } catch {
    return null;
  }
}

async function getOrCreateContext(): Promise<BrowserContext> {
  if (sharedContext) return sharedContext;

  // Attach to already-running Chrome before trying to launch a new one
  const existing = await tryConnectExisting();
  if (existing) {
    sharedContext = existing;
    return sharedContext;
  }

  const headless = getEnv("HEADLESS", "false") === "true";
  const profileDir = path.resolve(getEnv("BROWSER_PROFILE_DIR", "./browser-profile"));
  const cookieFile = getEnv("COOKIE_FILE", "./cookies.json");

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  console.log(`[browser] Launching Chromium (headless=${headless})`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "Upgrade-Insecure-Requests": "1",
    },
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  // Comprehensive stealth patches — run before every page load.
  // These mask the signals Cloudflare's Turnstile uses to fingerprint automation.
  await context.addInitScript(() => {
    // 1. Remove the webdriver flag (primary bot signal)
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // 2. Add realistic plugin list (headless has 0 plugins)
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const plugins = [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "", length: 1 },
          { name: "Native Client", filename: "internal-nacl-plugin", description: "", length: 2 },
        ];
        return Object.assign(plugins, { item: (i: number) => plugins[i], namedItem: (n: string) => plugins.find(p => p.name === n) ?? null, refresh: () => {} });
      },
    });

    // 3. Fix languages (empty in some headless configs)
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

    // 4. Add chrome.runtime (missing in automated browsers)
    if (!(window as unknown as Record<string, unknown>)["chrome"]) {
      (window as unknown as Record<string, unknown>)["chrome"] = { runtime: {} };
    }

    // 5. Mask WebGL vendor/renderer (SwiftShader is an automation signal)
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p: number) {
        if (p === 37445) return "Intel Inc.";
        if (p === 37446) return "Intel Iris OpenGL Engine";
        return getParam.call(this, p);
      };
    } catch { /* WebGL not available */ }

    // 6. Permissions API — pretend to be a normal browser
    if (navigator.permissions) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params: PermissionDescriptor) =>
        params.name === "notifications"
          ? Promise.resolve({ state: "prompt", onchange: null } as PermissionStatus)
          : origQuery(params);
    }
  });

  // Inject cookies before any navigation if the file exists
  if (cookieFileExists(cookieFile)) {
    console.log(`[browser] Loading cookies from ${cookieFile}`);
    const cookies = loadCookies(cookieFile);
    await injectCookies(context, cookies);
  } else {
    console.log(
      `[browser] No cookies.json found at ${cookieFile}. Browser will open for manual login.`
    );
  }

  sharedContext = context;
  return context;
}

/**
 * Detects a Cloudflare challenge page ("Performing security verification") and
 * attempts to handle it by: clicking the checkbox in the Turnstile iframe if
 * present, or waiting up to 30s for Cloudflare to auto-pass the challenge.
 * Returns true if a challenge was detected (regardless of whether it passed).
 */
async function handleCloudflareChallenge(page: Page): Promise<boolean> {
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  const isChallenge =
    bodyText.includes("Performing security verification") ||
    bodyText.includes("Verify you are human") ||
    page.url().includes("challenges.cloudflare.com");

  if (!isChallenge) return false;

  console.log("[cloudflare] Challenge page detected. Attempting to handle...");

  // Try clicking the Turnstile checkbox — it lives inside a cross-origin iframe.
  // We try multiple frame-locator patterns since Cloudflare's markup changes.
  let clicked = false;
  const frameSelectors = [
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[title*='Widget containing a Cloudflare']",
    "iframe[title*='cloudflare']",
    "iframe[id^='cf-']",
  ];
  for (const sel of frameSelectors) {
    if (clicked) break;
    try {
      const cfFrame = page.frameLocator(sel).first();
      // Turnstile checkbox selectors (changes with Cloudflare releases)
      const checkboxSelectors = [
        "input[type='checkbox']",
        ".ctp-checkbox-label",
        ".cb-lb",
        "#challenge-stage",
        "[id^='turnstile']",
        "label",
      ];
      for (const cbSel of checkboxSelectors) {
        try {
          const cb = cfFrame.locator(cbSel).first();
          await cb.waitFor({ state: "visible", timeout: 3000 });
          // Simulate real mouse movement before click
          const box = await cb.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2 - 5, { steps: 5 });
            await page.waitForTimeout(200);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
            await page.waitForTimeout(100);
          }
          await cb.click();
          console.log(`[cloudflare] Clicked Turnstile element: frame="${sel}" cb="${cbSel}"`);
          clicked = true;
          break;
        } catch { /* try next */ }
      }
    } catch { /* try next frame selector */ }
  }

  // Also try clicking directly on frames by URL match
  if (!clicked) {
    for (const frame of page.frames()) {
      if (clicked) break;
      const url = frame.url();
      if (url.includes("cloudflare") || url.includes("challenges")) {
        try {
          const cb = frame.locator("input[type='checkbox'], label, .cb-lb").first();
          await cb.waitFor({ state: "visible", timeout: 3000 });
          await cb.click();
          console.log(`[cloudflare] Clicked via frame.url=${url}`);
          clicked = true;
        } catch { /* ignore */ }
      }
    }
  }

  if (!clicked) {
    console.log("[cloudflare] Could not click checkbox — waiting for auto-pass...");
  }

  // Wait up to 30s for the challenge to resolve (page URL/content will change)
  try {
    await page.waitForFunction(
      () =>
        !document.body?.innerText?.includes("Performing security verification") &&
        !document.body?.innerText?.includes("Verify you are human"),
      { timeout: 30000, polling: 1000 }
    );
    console.log("[cloudflare] Challenge passed!");
  } catch {
    console.log("[cloudflare] Challenge did not auto-resolve within 30s");
  }

  return true;
}

/**
 * Waits for a key press in the terminal (used for manual login flow).
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Waits for Claude Design to finish generating a result.
 * This is deliberately resilient — we always take a screenshot regardless.
 */
async function waitForResult(page: Page, previousText: string): Promise<string | null> {
  const timeout = parseInt(getEnv("TIMEOUT_MS", "180000"), 10);
  const deadline = Date.now() + timeout;

  console.log("[automation] Waiting for Claude Design to generate output...");

  // Phase 1 — wait for Claude Design to finish writing (left panel stops animating).
  // The left panel shows status text like "Writing Landing" while generating.
  // We wait for that text to disappear or for a "done" signal.
  try {
    await page.waitForFunction(
      () => {
        const text = document.body.innerText ?? "";
        // Stop-signals: generation complete indicators in Claude Design UI
        const done =
          text.includes("View code") ||
          text.includes("Open in") ||
          text.includes("Preview") ||
          text.includes("New sketch");
        // Fail-safe: generation text gone means it stopped
        const stillWriting =
          text.includes("Writing ") ||
          text.includes("Listing files") ||
          text.includes("Reading ");
        return done || !stillWriting;
      },
      { timeout: Math.min(120000, timeout), polling: 2000 }
    );
    console.log("[automation] Claude Design generation appears complete");
  } catch {
    console.log("[automation] Generation wait timed out — taking screenshot anyway");
  }

  // Phase 2 — wait for the canvas/design preview to render (right panel).
  // The canvas initially says "Creations will appear here" — wait for that to change.
  try {
    await page.waitForFunction(
      () => {
        const text = document.body.innerText ?? "";
        return !text.includes("Creations will appear here");
      },
      { timeout: Math.min(60000, timeout), polling: 1500 }
    );
    console.log("[automation] Design canvas populated");
    // Extra buffer for canvas to fully paint
    await page.waitForTimeout(3000);
  } catch {
    console.log("[automation] Canvas did not populate — taking screenshot of current state");
  }

  // Phase 3 — network idle as a final render-complete signal
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch { /* ignore */ }

  // Phase 4 — fallback: poll for page text growth (catches edge cases)
  const currentText = await page.evaluate(() => document.body.innerText ?? "");
  if (currentText.length <= previousText.length + 50) {
    console.log("[automation] Page text unchanged — waiting additional 10s as fallback");
    await page.waitForTimeout(10000);
  }

  // Extract assistant text if requested
  let extractedText: string | null = null;
  try {
    const textSelectors = [
      '[data-testid*="assistant"]',
      '[data-testid*="response"]',
      ".assistant-message",
      '[role="article"]',
    ];

    for (const sel of textSelectors) {
      const el = page.locator(sel).last();
      try {
        const text = await el.innerText({ timeout: 2000 });
        if (text && text.trim().length > 10) {
          extractedText = text.trim();
          break;
        }
      } catch {
        // Try next
      }
    }
  } catch {
    // Text extraction is best-effort
  }

  return extractedText;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { prompt, mode } = options;
  const claudeUrl = getEnv(
    "CLAUDE_DESIGN_URL",
    "https://claude.ai/design/p/db3a0556-5631-4f14-aae6-9cc01e035db2"
  );
  const outputDir = path.resolve(getEnv("OUTPUT_DIR", "./outputs"));

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let context;
  try {
    context = await getOrCreateContext();
  } catch (err) {
    // Context is stale — reset and try once more
    console.log("[browser] Context init failed, resetting and retrying...");
    sharedContext = null;
    context = await getOrCreateContext();
  }

  // Reuse an existing page or open a new one
  const pages = context.pages();
  const page: Page = pages.length > 0 ? pages[0] : await context.newPage();

  console.log(`[automation] Navigating to ${claudeUrl}`);
  await page.goto(claudeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for the SPA to hydrate before checking auth state
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // networkidle can time out on busy pages — that's fine
  }
  console.log(`[automation] Page settled at: ${page.url()}`);

  // Handle Cloudflare bot challenge if present
  const hadChallenge = await handleCloudflareChallenge(page);
  if (hadChallenge) {
    // Re-settle after challenge resolution
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch { /* ignore */ }
    console.log(`[automation] Post-challenge URL: ${page.url()}`);
  }

  // Check for login wall
  if (await isLoginPage(page)) {
    console.log("\n[auth] Login page detected.");
    console.log(
      "Please log in manually in the opened browser, then press Enter in the terminal to continue.\n"
    );
    await waitForEnter();

    // Navigate back to the target after login
    await page.goto(claudeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Optionally save storage state for next run
    const storageStatePath = path.resolve("./auth/storageState.json");
    const shouldSave = process.env.SAVE_STORAGE_STATE === "true";
    if (shouldSave) {
      await context.storageState({ path: storageStatePath });
      console.log(`[auth] Storage state saved to ${storageStatePath}`);
    }
  }

  // Capture page text before submitting so we can detect change
  const previousText = await page.evaluate(
    () => document.body.innerText ?? ""
  );

  // Take a diagnostic screenshot so we can see the actual page state
  const diagPath = path.join(outputDir, `diag-${Date.now()}.png`);
  await page.screenshot({ path: diagPath, fullPage: true });
  console.log(`[automation] Diagnostic screenshot saved: ${diagPath}`);

  // Log visible interactive elements to help debug selector issues
  const interactiveEls = await page.evaluate(() => {
    const els = document.querySelectorAll(
      'textarea, [contenteditable], [role="textbox"], input[type="text"], input:not([type])'
    );
    return Array.from(els).map((el) => ({
      tag: el.tagName,
      role: el.getAttribute("role"),
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      classes: el.className,
      id: el.id,
    }));
  });
  console.log("[automation] Interactive elements found:", JSON.stringify(interactiveEls, null, 2));

  // Find and fill the prompt input
  console.log("[automation] Looking for prompt input...");
  const input = await findPromptInput(page);

  // Click to focus, then fill the prompt
  await input.click();
  await page.waitForTimeout(300);

  // Use fill() for textareas, type() for contenteditable to trigger React/Vue state
  const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
  if (tagName === "textarea") {
    await input.fill(prompt);
  } else {
    // Clear existing content then type
    await input.selectText().catch(() => {});
    await page.keyboard.press("Control+A");
    await input.type(prompt, { delay: 15 });
  }

  console.log("[automation] Prompt entered. Submitting...");
  await submitPrompt(page);

  // Wait for the result
  const extractedText = await waitForResult(page, previousText);

  // Screenshot
  const timestamp = Date.now();
  const screenshotFilename = `design-${timestamp}.png`;
  const screenshotPath = path.join(outputDir, screenshotFilename);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`[automation] Screenshot saved: ${screenshotPath}`);

  return {
    success: true,
    message: "Generation complete. Screenshot saved.",
    screenshotPath,
    text: mode === "text" ? (extractedText ?? null) : null,
  };
}

/**
 * Cleanly close the shared browser context (call on server shutdown).
 */
export async function closeBrowser(): Promise<void> {
  if (sharedContext) {
    await sharedContext.close();
    sharedContext = null;
    console.log("[browser] Browser context closed");
  }
}
