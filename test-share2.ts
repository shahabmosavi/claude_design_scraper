import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const OUT = path.resolve("./outputs");
const CDP_PORT = 9222;

async function snap(page: import("playwright").Page, name: string) {
  const p = path.join(OUT, `share2-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`[snap] ${name} → ${p}`);
}

(async () => {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  // 1. Click Share
  const shareBtn = page.locator("button, [role='button']").filter({ hasText: /^Share$/i }).first();
  await shareBtn.waitFor({ state: "visible", timeout: 5000 });
  await shareBtn.click();
  await page.waitForTimeout(1000);
  await snap(page, "1-after-share");

  // 2. Click Send to...
  const sendToBtn = page.locator("button, [role='button'], [role='menuitem'], li, a").filter({ hasText: /send to/i }).first();
  await sendToBtn.waitFor({ state: "visible", timeout: 5000 });
  await sendToBtn.click();
  await page.waitForTimeout(1200);
  await snap(page, "2-after-send-to");

  // Dump ALL visible elements with text to find Claude Code
  const allEls = await page.evaluate(() => {
    const results: { tag: string; role: string | null; text: string; html: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.currentNode as Element;
    while (node) {
      const el = node as Element;
      const text = (el as HTMLElement).innerText?.trim() ?? "";
      if (text && text.length < 200 && text.length > 0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({
            tag: el.tagName,
            role: el.getAttribute("role"),
            text: text.slice(0, 100),
            html: el.outerHTML.slice(0, 200),
          });
        }
      }
      node = walker.nextNode() as Element | null;
    }
    return results;
  });

  // Filter for anything mentioning "claude" or "code"
  const relevant = allEls.filter(e => /claude|code|send|option/i.test(e.text));
  console.log("\n=== Elements mentioning claude/code/send/option ===");
  for (const e of relevant) {
    console.log(`  [${e.tag}] role=${e.role} text="${e.text}"`);
    console.log(`    html: ${e.html}`);
  }

  // Also try finding the exact element
  const allTextEls = await page.locator("*").all();
  console.log(`\n=== Scanning ${allTextEls.length} elements for "claude code" text ===`);
  for (const el of allTextEls.slice(0, 300)) {
    try {
      const text = await el.innerText({ timeout: 200 }).catch(() => "");
      if (/claude code/i.test(text) && text.length < 50) {
        const tag = await el.evaluate(e => e.tagName).catch(() => "?");
        const role = await el.getAttribute("role").catch(() => null);
        const outerHtml = await el.evaluate(e => e.outerHTML.slice(0, 300)).catch(() => "");
        console.log(`  FOUND: [${tag}] role=${role} text="${text}"`);
        console.log(`    html: ${outerHtml}`);
      }
    } catch { /* ignore */ }
  }

  await browser.disconnect();
  process.exit(0);
})();
