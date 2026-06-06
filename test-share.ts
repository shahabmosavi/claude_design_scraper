import { chromium } from "playwright";
import path from "path";

const OUT = path.resolve("./outputs");
const CDP_PORT = 9222;

async function snap(page: import("playwright").Page, name: string) {
  const p = path.join(OUT, `share-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`[snap] ${name} → ${p}`);
}

(async () => {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  await snap(page, "0-before");

  // 1. Click Share
  const shareBtn = page.locator("button, [role='button']").filter({ hasText: /^Share$/i }).first();
  await shareBtn.waitFor({ state: "visible", timeout: 5000 });
  await shareBtn.click();
  await page.waitForTimeout(1000);
  await snap(page, "1-after-share");

  // 2. Click Send to...
  const sendToBtn = page.locator("button, [role='button'], [role='menuitem']").filter({ hasText: /send to/i }).first();
  await sendToBtn.waitFor({ state: "visible", timeout: 5000 });
  await sendToBtn.click();
  await page.waitForTimeout(1000);
  await snap(page, "2-after-send-to");

  // 3. Log all visible options
  const items = await page.locator("[role='option'], [role='menuitem'], li, button").all();
  for (const item of items) {
    const text = await item.innerText().catch(() => "");
    if (text.trim()) console.log(`[option] "${text.trim()}"`);
  }

  await browser.close();
})();
