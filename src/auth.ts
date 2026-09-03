import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BASE = "https://www.screener.in";

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export function userAgent(): string {
  return process.env.SCREENER_USER_AGENT || DEFAULT_UA;
}

/** Where the session cookie lives. XDG-aware so it survives npx (which keeps no
 * writable install dir of its own). */
export function sessionPath(): string {
  const base =
    process.env.SCREENER_MCP_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "screener-mcp");
  return join(base, "session.json");
}

export interface StoredSession {
  sessionId: string;
  /** Screener account the cookie belongs to, for `screener_auth_status`. Not a secret. */
  username?: string;
  savedAt: string;
}

/** Read the stored cookie. Returns null when absent or unreadable — callers treat
 * "no session" as "anonymous", never as a hard error. */
export function loadSession(): StoredSession | null {
  const envCookie = process.env.SCREENER_SESSION_ID?.trim();
  if (envCookie) return { sessionId: envCookie, savedAt: "(from SCREENER_SESSION_ID)" };
  try {
    const raw = readFileSync(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed.sessionId ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the cookie 0600. We write the file then chmod, and also chmod the
 * directory, so the secret is never group/world readable even briefly. */
export function saveSession(s: StoredSession): string {
  const p = sessionPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  chmodSync(dirname(p), 0o700);
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export function clearSession(): boolean {
  try {
    rmSync(sessionPath());
    return true;
  } catch {
    return false;
  }
}

/** Cookie header for an authenticated request, or undefined when anonymous. */
export function cookieHeader(): string | undefined {
  const s = loadSession();
  return s ? `sessionid=${s.sessionId}` : undefined;
}

function parseSetCookie(res: Response, name: string): string | null {
  // getSetCookie() keeps multiple Set-Cookie headers separate; a plain get() would
  // join them and break on the commas inside cookie Expires dates.
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of all) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

export class LoginError extends Error {}

/**
 * Log in to Screener and return the session cookie.
 *
 * Django's CSRF check on an HTTPS POST needs three things to agree: the
 * csrftoken cookie, the csrfmiddlewaretoken form field, and a same-origin
 * Referer. A successful login answers 302; a wrong password answers 200 with the
 * form re-rendered, which is how we tell them apart.
 *
 * The password is used for this one request and never stored or logged.
 */
export async function login(username: string, password: string): Promise<string> {
  const ua = userAgent();

  const page = await fetch(`${BASE}/login/`, { headers: { "User-Agent": ua } });
  if (!page.ok) throw new LoginError(`Could not load Screener login page (HTTP ${page.status})`);
  const html = await page.text();
  const csrfCookie = parseSetCookie(page, "csrftoken");
  const csrfField = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
  if (!csrfCookie || !csrfField) {
    throw new LoginError(
      "Screener's login page did not return a CSRF token — the page layout may have changed.",
    );
  }

  const body = new URLSearchParams({
    csrfmiddlewaretoken: csrfField,
    next: "",
    username,
    password,
  });

  const res = await fetch(`${BASE}/login/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrfCookie}`,
      Referer: `${BASE}/login/`,
      Origin: BASE,
    },
    body,
  });

  const sessionId = parseSetCookie(res, "sessionid");
  if (sessionId) return sessionId;

  if (res.status === 200) {
    const bodyText = await res.text();
    if (/captcha/i.test(bodyText)) {
      throw new LoginError(
        "Screener is asking for a captcha. Sign in at https://www.screener.in/login/ in a browser, " +
          "then copy the `sessionid` cookie and set SCREENER_SESSION_ID instead.",
      );
    }
    throw new LoginError("Screener rejected those credentials (no session cookie returned).");
  }
  throw new LoginError(`Unexpected response from Screener login: HTTP ${res.status}`);
}

/** Verify a cookie is still live and get the account it belongs to. Screener
 * bounces anonymous requests for /dash/ back to the login page. */
export async function whoami(sessionId: string): Promise<{ valid: boolean; username?: string }> {
  const res = await fetch(`${BASE}/dash/`, {
    redirect: "manual",
    headers: { "User-Agent": userAgent(), Cookie: `sessionid=${sessionId}` },
  });
  if (res.status >= 300 && res.status < 400) return { valid: false };
  if (!res.ok) return { valid: false };
  const html = await res.text();
  if (/\/login\//.test(html) && !/\/logout\//.test(html)) return { valid: false };
  const username = html.match(/\/user\/[^"]*"[^>]*>\s*([^<]+)/)?.[1]?.trim();
  return { valid: true, username };
}
