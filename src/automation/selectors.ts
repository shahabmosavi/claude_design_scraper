import { Page, Locator } from "playwright";

/**
 * Tries multiple selector strategies to find the prompt input in the Claude UI.
 * Claude's DOM changes over time, so we fall back through several approaches.
 */
export async function findPromptInput(page: Page): Promise<Locator> {
  const strategies: Array<() => Locator> = [
    () => page.locator('div.ProseMirror').first(),
    () => page.locator('[contenteditable="true"]').first(),
    () => page.locator('[role="textbox"]').first(),
    () => page.locator('textarea').first(),
    () => page.locator('[placeholder*="message" i]').first(),
    () => page.locator('[aria-label*="message" i]').first(),
    () => page.locator('[data-testid*="input" i]').first(),
    () => page.locator('[data-testid*="prompt" i]').first(),
  ];

  for (const strategy of strategies) {
    const locator = strategy();
    try {
      // Give each strategy a short timeout to avoid long stalls
      await locator.waitFor({ state: "visible", timeout: 3000 });
      console.log(`[selectors] Found prompt input via: ${locator}`);
      return locator;
    } catch {
      // Try next strategy
    }
  }

  throw new Error(
    "Could not find the prompt input field. The Claude Design UI may have changed."
  );
}

/**
 * Tries multiple strategies to click the submit/send button.
 * Falls back to keyboard shortcuts if no button is found.
 */
export async function submitPrompt(page: Page): Promise<void> {
  const buttonStrategies: Array<() => Locator> = [
    () => page.locator('button[type="submit"]').first(),
    () => page.locator('button[aria-label*="Send" i]').first(),
    () => page.locator('button[aria-label*="Submit" i]').first(),
    () => page.locator('button[data-testid*="send" i]').first(),
    () => page.locator('button[data-testid*="submit" i]').first(),
  ];

  for (const strategy of buttonStrategies) {
    const btn = strategy();
    try {
      await btn.waitFor({ state: "visible", timeout: 2000 });
      const enabled = await btn.isEnabled();
      if (enabled) {
        console.log("[selectors] Submitting via button click");
        await btn.click();
        return;
      }
    } catch {
      // Try next
    }
  }

  // Fallback: keyboard shortcut
  console.log("[selectors] No submit button found — using Enter key");
  await page.keyboard.press("Enter");
}

/**
 * Detects whether we landed on a login/auth page rather than the design project.
 * Strict check: requires a login form field to be present, not just nav links.
 * Claude's UI shows "Sign in" links in the nav even when logged in, so we must
 * not trigger on text alone.
 */
export async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url();

  // Hard redirect to a dedicated auth route is a definitive signal
  if (url.includes("/login") || url.includes("/auth/signin")) {
    return true;
  }

  // Must see an actual form input — nav "Sign in" links are not enough
  const formFieldSelectors = [
    'input[type="email"]',
    'input[type="password"]',
    'input[name="email"]',
    'input[name="password"]',
  ];

  for (const sel of formFieldSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 2000 });
      if (visible) return true;
    } catch {
      // Not found
    }
  }

  return false;
}
