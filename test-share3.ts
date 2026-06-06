// Quick test: just run the share flow on the currently open Claude Design page
import { chromium } from "playwright";
import path from "path";

const OUT = path.resolve("./outputs");
const CDP_PORT = 9222;

(async () => {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  console.log("[test] Current URL:", page.url());

  // Intercept clipboard
  await page.evaluate(() => {
    (window as any).__clipboardCapture = null;
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      (window as any).__clipboardCapture = text;
      console.log("[clipboard intercepted]", text.slice(0, 200));
      return orig(text).catch(() => {});
    };
  });

  // Dismiss any open popover
  const backdrop = page.locator("[data-popover-backdrop]");
  if (await backdrop.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    console.log("[test] Dismissed open popover");
  }

  // 1. Share
  const shareBtn = page.locator("button, [role='button']").filter({ hasText: /^Share$/i }).first();
  await shareBtn.waitFor({ state: "visible", timeout: 10000 });
  await shareBtn.click();
  await page.waitForTimeout(800);
  console.log("[test] Clicked Share");

  // 2. Send to… tab
  const sendToTab = page.locator("[role='tab']").filter({ hasText: /send to/i }).first();
  await sendToTab.waitFor({ state: "visible", timeout: 5000 });
  await sendToTab.click();
  await page.waitForTimeout(800);
  console.log("[test] Clicked Send to… tab");

  // 3. Claude Code row → Send
  const claudeCodeRow = page.locator("div").filter({ hasText: /claude code/i }).filter({
    has: page.locator("button").filter({ hasText: /^Send$/i }),
  }).first();
  const sendBtn = claudeCodeRow.locator("button").filter({ hasText: /^Send$/i }).first();
  await sendBtn.waitFor({ state: "visible", timeout: 5000 });
  console.log("[test] Found Claude Code Send button, clicking...");

  const [newPage] = await Promise.all([
    context.waitForEvent("page", { timeout: 8000 }).catch(() => null) as Promise<import("playwright").Page | null>,
    sendBtn.click(),
  ]);
  await page.waitForTimeout(1500);
  console.log("[test] newPage opened:", newPage ? newPage.url() : "no new page");

  const targetPage = newPage ?? page;

  if (newPage) {
    await newPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await newPage.evaluate(() => {
      (window as any).__clipboardCapture = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text: string) => {
        (window as any).__clipboardCapture = text;
        return orig(text).catch(() => {});
      };
    }).catch(() => {});
  }

  await targetPage.screenshot({ path: path.join(OUT, "share3-after-send.png") });
  console.log("[test] Screenshot: share3-after-send.png");

  // List all buttons on target page
  const buttons = await targetPage.locator("button").all();
  console.log("[test] Buttons on target page:");
  for (const btn of buttons) {
    const text = await btn.innerText().catch(() => "");
    if (text.trim()) console.log("  -", JSON.stringify(text.trim()));
  }

  // Try Copy command
  const copyBtn = targetPage.locator("button").filter({ hasText: /copy command/i }).first();
  const isCopyVisible = await copyBtn.isVisible().catch(() => false);
  if (isCopyVisible) {
    await copyBtn.click();
    await targetPage.waitForTimeout(600);
    console.log("[test] Clicked Copy command");
  } else {
    console.log("[test] Copy command button not visible");
  }

  const captured = await targetPage.evaluate(() => (window as any).__clipboardCapture).catch(() => null);
  console.log("[test] Captured command:", captured ?? "(none)");

  if (newPage && !newPage.isClosed()) await newPage.close().catch(() => {});

  process.exit(0);
})();
