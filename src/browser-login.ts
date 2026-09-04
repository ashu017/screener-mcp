/**
 * Sign in by driving a real browser window.
 *
 * Screener has no OAuth or device-code flow for third parties, so there is no link
 * it can redirect back to us with a token. What it does have is `/login/google/`
 * and `/login/apple/` alongside the password form — and for a Google or Apple
 * sign-up there is no password to POST at all, which is why the form-based
 * `login` cannot serve every account.
 *
 * So we open Screener in a browser the user drives themselves, let them sign in
 * however they normally do, and watch the cookie jar until `sessionid` appears.
 * We never see the password, and no credential passes through this process.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionPath } from "./auth.js";

const BASE = "https://www.screener.in";

export class BrowserLoginError extends Error {}

/**
 * Chromium profile directory. Persisting it means a Google/Apple sign-in survives
 * between logins, so refreshing an expired cookie is one click rather than a full
 * re-auth. It holds live credentials, hence 0700.
 */
export function browserProfilePath(): string {
  return join(dirname(sessionPath()), "browser-profile");
}

export function clearBrowserProfile(): boolean {
  try {
    rmSync(browserProfilePath(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Playwright is deliberately not a dependency of this package: it pulls a
 * several-hundred-megabyte browser, and almost everyone who installs
 * `screener-mcp` only ever runs the MCP server. We load it on demand and explain
 * how to get it when it is absent.
 */
async function loadChromium(): Promise<any> {
  // The server itself runs on Node 18, but Playwright hard-exits below Node 20 with
  // a message that says nothing about screener-mcp. Say it ourselves instead.
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 20) {
    throw new BrowserLoginError(
      `Browser login needs Node 20 or newer (you are on ${process.versions.node}), because Playwright does.\n` +
        "The MCP server itself still runs fine on Node 18 — this limit only applies to --browser.\n" +
        "Either upgrade Node, or sign in with `npx screener-mcp login` (email + password).",
    );
  }

  const tried: string[] = [];
  for (const pkg of ["playwright", "playwright-core"]) {
    for (const specifier of resolveCandidates(pkg)) {
      try {
        const mod: any = await import(specifier);
        const chromium = (mod.default ?? mod).chromium;
        if (chromium) return chromium;
        tried.push(`${specifier} (no chromium export)`);
      } catch (e: any) {
        const code = e?.code;
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw e;
        tried.push(specifier);
      }
    }
  }
  throw new BrowserLoginError(
    `Browser login needs Playwright, which could not be found.\n\n` +
      "Install it next to wherever you run this from:\n" +
      "  npm install playwright && npx playwright install chromium\n\n" +
      "Or install it anywhere and point at it:\n" +
      "  SCREENER_PLAYWRIGHT_PATH=/path/to/node_modules/playwright npx screener-mcp login --browser\n\n" +
      "Or, to reuse a Chrome you already have rather than downloading one, install\n" +
      "`playwright-core` and set SCREENER_BROWSER_EXECUTABLE=/path/to/chrome.\n\n" +
      `Tried: ${tried.join(", ")}`,
  );
}

/**
 * Where to look for Playwright. A bare specifier only resolves relative to *this*
 * file, which under npx is a throwaway directory that will never contain Playwright
 * — so a bare import alone would make the feature uninstallable. We also try the
 * user's working directory and the global npm root, importing by absolute path.
 */
function resolveCandidates(pkg: string): string[] {
  const out: string[] = [pkg];
  const override = process.env.SCREENER_PLAYWRIGHT_PATH?.trim();
  if (override) out.unshift(pathToFileURL(join(override, "index.js")).href, pathToFileURL(override).href);

  const require = createRequire(join(process.cwd(), "package.json"));
  for (const dir of [process.cwd(), globalNodeModules()]) {
    if (!dir) continue;
    try {
      out.push(pathToFileURL(require.resolve(pkg, { paths: [dir] })).href);
    } catch {
      // Not installed there; the aggregate error below reports everything we tried.
    }
  }
  return [...new Set(out)];
}

/** `<node>/../lib/node_modules`, which is where `npm install -g` puts things. */
function globalNodeModules(): string | null {
  try {
    return join(dirname(dirname(process.execPath)), "lib", "node_modules");
  } catch {
    return null;
  }
}

/**
 * Headless is opt-in and only useful once the persistent profile already holds a
 * sign-in: Screener's cookie outlives the browser profile's, so a headless run can
 * silently mint a fresh `sessionid` with no interaction. You cannot complete a
 * first-time sign-in this way, because there is no window to type into.
 */
function headless(): boolean {
  const v = process.env.SCREENER_BROWSER_HEADLESS?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * A headed browser needs somewhere to draw. Failing here with an explanation beats
 * letting Chromium die with "Missing X server or $DISPLAY" several seconds later.
 */
function assertDisplay(): void {
  if (headless()) return;
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  throw new BrowserLoginError(
    "No DISPLAY or WAYLAND_DISPLAY set — this is a headless Linux host, so no browser\n" +
      "window can be shown. Two ways round it:\n\n" +
      "  1. Run `npx screener-mcp login --browser` on a machine with a desktop.\n" +
      "  2. Sign in with the browser you already use, copy the `sessionid` cookie from\n" +
      "     DevTools -> Application -> Cookies -> screener.in, and pass it through:\n" +
      "       SCREENER_SESSION_ID=<cookie>\n" +
      "     (set it in your MCP client's `env` block, or export it before starting the server)\n\n" +
      "SCREENER_BROWSER_HEADLESS=1 skips this check, but it can only refresh a profile\n" +
      "that is already signed in — not complete a first-time sign-in.",
  );
}

export interface BrowserLoginResult {
  sessionId: string;
  csrfToken?: string;
}

function pickCookies(cookies: any[]): BrowserLoginResult | null {
  const mine = cookies.filter((c) => String(c?.domain ?? "").endsWith("screener.in"));
  const sessionId = mine.find((c) => c.name === "sessionid")?.value;
  if (!sessionId) return null;
  return { sessionId, csrfToken: mine.find((c) => c.name === "csrftoken")?.value };
}

export interface BrowserLoginOptions {
  /** How long to wait for the user to finish signing in. */
  timeoutMs?: number;
  /** Called roughly once a second with the seconds remaining, for progress output. */
  onWait?: (secondsLeft: number) => void;
}

export async function browserLogin(opts: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  assertDisplay();
  const chromium = await loadChromium();

  const profile = browserProfilePath();
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);

  let context: any;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: headless(),
      viewport: null,
      args: ["--window-size=1100,940"],
      executablePath: process.env.SCREENER_BROWSER_EXECUTABLE || undefined,
    });
  } catch (e) {
    throw new BrowserLoginError(
      `Could not launch Chromium: ${e instanceof Error ? e.message : String(e)}\n` +
        "If the browser itself is missing, run: npx playwright install chromium",
    );
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${BASE}/login/`, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      let cookies: any[];
      try {
        cookies = await context.cookies();
      } catch {
        // The context is gone, which means the window was closed.
        throw new BrowserLoginError("Browser closed before sign-in completed.");
      }
      if (context.pages().length === 0) {
        throw new BrowserLoginError("Browser closed before sign-in completed.");
      }
      const found = pickCookies(cookies);
      if (found) return found;
      opts.onWait?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new BrowserLoginError("Timed out waiting for sign-in. Re-run with --timeout <seconds> for longer.");
  } finally {
    await context?.close?.().catch?.(() => {});
  }
}
