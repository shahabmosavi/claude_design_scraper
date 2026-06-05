import fs from "fs";
import path from "path";
import { BrowserContext } from "playwright";

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

export function cookieFileExists(cookiePath: string): boolean {
  const resolved = path.resolve(cookiePath);
  return fs.existsSync(resolved);
}

const SAME_SITE_MAP: Record<string, "Strict" | "Lax" | "None"> = {
  strict: "Strict", lax: "Lax", unspecified: "None", no_restriction: "None", none: "None",
};

function normalizeJ2team(raw: Record<string, unknown>[]): PlaywrightCookie[] {
  return raw.map((c) => {
    const sameSiteRaw = ((c.sameSite as string) ?? "lax").toLowerCase();
    const cookie: PlaywrightCookie = {
      name: c.name as string,
      value: c.value as string,
      domain: c.domain as string,
      path: (c.path as string) ?? "/",
      httpOnly: (c.httpOnly as boolean) ?? false,
      secure: (c.secure as boolean) ?? true,
      sameSite: SAME_SITE_MAP[sameSiteRaw] ?? "Lax",
      expires: c.session ? -1 : c.expirationDate ? Math.floor(c.expirationDate as number) : -1,
    };
    return cookie;
  });
}

export function loadCookies(cookiePath: string): PlaywrightCookie[] {
  const resolved = path.resolve(cookiePath);
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  // Plain Playwright array
  if (Array.isArray(parsed)) return parsed as PlaywrightCookie[];

  // j2team / EditThisCookie format: { url, cookies: [...] }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).cookies)) {
    return normalizeJ2team((parsed as Record<string, unknown>).cookies as Record<string, unknown>[]);
  }

  throw new Error("cookies.json format not recognised. Export as j2team or plain Playwright array.");
}

export async function injectCookies(
  context: BrowserContext,
  cookies: PlaywrightCookie[]
): Promise<void> {
  // Mask values in logs — never print actual cookie values
  const names = cookies.map((c) => c.name).join(", ");
  console.log(`[cookies] Injecting ${cookies.length} cookie(s): ${names}`);

  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite ?? "Lax",
      expires: c.expires,
    }))
  );
}

export async function saveStorageState(
  context: BrowserContext,
  outputPath: string
): Promise<void> {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await context.storageState({ path: resolved });
  console.log(`[cookies] Storage state saved to ${resolved}`);
}
