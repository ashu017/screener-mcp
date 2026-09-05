/**
 * Sign in by driving the Chrome the user already has, over the DevTools protocol.
 *
 * Same idea as `browser-login.ts` — open Screener, let the user sign in however
 * they like, watch the cookie jar — but with nothing to install. `browser-login`
 * needs Playwright, which means a several-hundred-megabyte browser download and
 * Node 20+; both are real reasons people give up before they ever get signed in.
 *
 * Chrome already speaks a protocol that can read cookies, and Node already has a
 * WebSocket client, so the whole thing is a few hundred lines and zero
 * dependencies. We talk to the browser, never to the user's credentials: the only
 * thing we ask Chrome for is the cookie it hands out *after* a sign-in we never see.
 *
 * The one thing we cannot do is attach to the Chrome the user already has open.
 * Since Chrome 136 (April 2025) `--remote-debugging-port` is refused outright when
 * Chrome is running on its default profile directory — a deliberate protection
 * against exactly the kind of cookie theft this file would otherwise resemble. So
 * we launch our own Chrome against our own profile directory and let the user sign
 * in there once; the profile persists, so it only happens once. We do not try to
 * disable that protection, and you should not either.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  assertDisplay,
  assertProfileUnlocked,
  BrowserLoginError,
  browserProfilePath,
  headlessRequested,
  pickCookies,
  profileLockedError,
  type BrowserLoginOptions,
  type BrowserLoginResult,
} from "./browser-login.js";

const BASE = "https://www.screener.in";

/**
 * Extends BrowserLoginError so the CLI can keep a single catch clause for "a
 * browser-driven sign-in failed, and the message is already written for a human".
 */
export class CdpLoginError extends BrowserLoginError {}

/** No Chrome-shaped browser anywhere on this machine. Distinct because the remedy
 * (install one, or fall back to --browser) is specific. */
export class ChromeNotFoundError extends CdpLoginError {}

/** This Node has no global WebSocket, so the CDP path cannot work at all. */
export class NodeTooOldForCdpError extends CdpLoginError {}

// ---------------------------------------------------------------------------
// Finding a browser
// ---------------------------------------------------------------------------

/**
 * Where Chrome installs itself, per platform. Ordered by preference: real Chrome
 * first because it is what "use my Chrome" means to most people and it is where
 * their Google sign-in is most likely to just work, then Chromium, then the other
 * Chromium-based browsers, which all speak the same protocol.
 */
function installLocations(): string[] {
  const env = process.env;
  if (process.platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    // Per-user installs under ~/Applications are as common as system-wide ones.
    return apps.flatMap((a) => [join("/Applications", a), join(homedir(), "Applications", a)]);
  }

  if (process.platform === "win32") {
    const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
      (p): p is string => Boolean(p),
    );
    const suffixes = [
      "\\Google\\Chrome\\Application\\chrome.exe",
      "\\Google\\Chrome Beta\\Application\\chrome.exe",
      "\\Google\\Chrome Dev\\Application\\chrome.exe",
      "\\Google\\Chrome SxS\\Application\\chrome.exe",
      "\\Chromium\\Application\\chrome.exe",
      "\\Microsoft\\Edge\\Application\\msedge.exe",
      "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return prefixes.flatMap((p) => suffixes.map((s) => p + s));
  }

  return [
    "/opt/google/chrome/chrome",
    "/opt/google/chrome-beta/chrome",
    "/opt/google/chrome-unstable/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/lib/chromium/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/microsoft/msedge/msedge",
    "/opt/brave.com/brave/brave",
    // Flatpak wrappers. chrome-launcher parses .desktop files to find these; naming
    // the handful that exist is cheaper and covers the same installs.
    "/var/lib/flatpak/exports/bin/com.google.Chrome",
    join(homedir(), ".local/share/flatpak/exports/bin/com.google.Chrome"),
    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    "/var/lib/flatpak/exports/bin/com.brave.Browser",
  ];
}

/** Names to look for on PATH, for distro packages that live somewhere unusual. */
const PATH_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "microsoft-edge",
  "brave-browser",
];

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command name against PATH ourselves — shelling out to `which`
 * would not work on Windows and would cost a process we do not need. */
function onPath(name: string): string[] {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    const p = join(dir, name);
    if (isExecutableFile(p)) out.push(p);
  }
  return out;
}

/**
 * Every browser we can find, best first. Exported because "which browser would you
 * use?" is a question worth being able to answer without attempting a login.
 */
export function browserCandidates(): string[] {
  const found = installLocations().filter(isExecutableFile);
  for (const name of PATH_NAMES) found.push(...onPath(name));
  return [...new Set(found)];
}

/**
 * The browser we will actually drive. `SCREENER_BROWSER_EXECUTABLE` is the same
 * variable the Playwright path uses, so whatever a user set for one works for both.
 */
export function findBrowserExecutable(): string {
  const override = process.env.SCREENER_BROWSER_EXECUTABLE?.trim();
  if (override) {
    if (!isExecutableFile(override)) {
      throw new ChromeNotFoundError(
        `SCREENER_BROWSER_EXECUTABLE is set to a file that is not there, or not runnable:\n  ${override}\n\n` +
          "Point it at the Chrome program itself, not the folder it lives in. For example:\n" +
          '  macOS:   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
          "  Linux:   /opt/google/chrome/chrome\n" +
          "  Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n\n" +
          "Or unset it and let screener-mcp find Chrome by itself.",
      );
    }
    return override;
  }

  const candidates = browserCandidates();
  if (candidates.length > 0) return candidates[0];

  throw new ChromeNotFoundError(
    "Could not find Chrome (or Chromium, Edge, or Brave) on this computer.\n\n" +
      "This sign-in method works by opening a browser you already have, so it needs one\n" +
      "of those installed. Three ways forward:\n\n" +
      "  1. Install Google Chrome, then run this again:\n" +
      "     https://www.google.com/chrome/\n\n" +
      "  2. If you do have Chrome but it is somewhere unusual, point at it:\n" +
      "     SCREENER_BROWSER_EXECUTABLE=/path/to/chrome npx screener-mcp login --chrome\n\n" +
      "  3. Use the Playwright-based sign-in instead, which downloads its own browser:\n" +
      "     npm install playwright && npx playwright install chromium\n" +
      "     npx screener-mcp login --browser",
  );
}

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

/**
 * Only the parts of WebSocket we use. We reach through `globalThis` and describe
 * the shape ourselves rather than leaning on the ambient DOM/undici types, because
 * the type existing says nothing about the runtime having it — `@types/node`
 * declares both `WebSocket` and `CloseEvent`, but Node has no `CloseEvent`
 * constructor before v23, so anything that named it would compile and then crash.
 */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
type WebSocketCtor = new (url: string) => MinimalWebSocket;

function webSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    throw new NodeTooOldForCdpError(
      `Signing in through your own Chrome needs Node 22 or newer (you are on ${process.versions.node}).\n` +
        "Older versions of Node have no built-in WebSocket, which is how this talks to Chrome.\n\n" +
        "The MCP server itself runs fine on Node 18 — this limit only applies to --chrome. Either:\n" +
        "  * upgrade Node (https://nodejs.org/), or\n" +
        "  * run `npx screener-mcp login --browser` (needs Playwright and Node 20+), or\n" +
        "  * run `npx screener-mcp login` and sign in with your email and password.",
    );
  }
  return ctor as WebSocketCtor;
}

interface CdpReply {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Request/reply over one browser-level socket.
 *
 * CDP is JSON in text frames: we send `{id, method, params}` and get back a frame
 * with the same `id` plus either `result` or `error`. Frames with no `id` are
 * events, which we have no use for and drop. A Map keyed by id is the whole
 * correlator.
 */
class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closedReason: string | null = null;

  private constructor(private readonly ws: MinimalWebSocket) {
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => this.fail("Chrome closed the debugging connection.");
  }

  static async open(url: string): Promise<CdpSession> {
    const Ctor = webSocketCtor();
    const ws = new Ctor(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      // The error event carries nothing useful in Node, so say what is worth saying.
      ws.onerror = () =>
        reject(
          new CdpLoginError(
            "Chrome started, but refused the debugging connection.\n" +
              "If this keeps happening, `npx screener-mcp login --browser` uses a different route.",
          ),
        );
      ws.onclose = () => reject(new CdpLoginError("Chrome closed the debugging connection during start-up."));
    });
    return new CdpSession(ws);
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: CdpReply;
    try {
      msg = JSON.parse(data) as CdpReply;
    } catch {
      return;
    }
    if (msg.id == null) return; // An event. We only do request/reply.
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new CdpLoginError(`Chrome rejected ${msg.id}: ${msg.error.message ?? "unknown error"}`));
    else waiter.resolve(msg.result);
  }

  /** Reject everything outstanding; used when the socket dies under us. */
  private fail(reason: string): void {
    this.closedReason ??= reason;
    for (const [, waiter] of this.pending) waiter.reject(new CdpLoginError(reason));
    this.pending.clear();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closedReason) return Promise.reject(new CdpLoginError(this.closedReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(new CdpLoginError(`Could not send ${method} to Chrome: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  close(): void {
    this.closedReason ??= "Connection closed.";
    try {
      this.ws.close();
    } catch {
      // Already gone; nothing to do.
    }
  }
}

// ---------------------------------------------------------------------------
// Launching and discovery
// ---------------------------------------------------------------------------

/** Chrome writes exactly two lines, no trailing newline: the port, then the
 * browser WebSocket *path*. */
function parseDevToolsActivePort(raw: string): { port: number; path: string } | null {
  const lines = raw.split("\n");
  if (lines.length < 2) return null; // Still being written.
  const port = Number(lines[0].trim());
  const path = lines[1].trim();
  if (!Number.isInteger(port) || port <= 0 || !path.startsWith("/")) return null;
  return { port, path };
}

/**
 * Wait for Chrome to tell us which port it picked.
 *
 * We asked for port 0, so the port is assigned at start-up and reported two ways:
 * the `DevToolsActivePort` file in the profile, and a line on stderr. We prefer the
 * file — it is the documented contract — and keep stderr for diagnostics and as a
 * fallback in case something downstream swallows it.
 *
 * If Chrome exits before writing it, that is nearly always the profile lock: a
 * Chrome is already running on this directory. Say so by name rather than dumping
 * an exit code.
 */
async function waitForDebuggerPort(
  profile: string,
  child: ChildProcess,
  stderr: () => string,
  spawnError: () => Error | null,
  deadline: number,
): Promise<{ port: number; path: string }> {
  const portFile = join(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    try {
      const parsed = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
      if (parsed) return parsed;
    } catch {
      // Not written yet.
    }

    // The process never started at all (missing file, not executable, wrong arch).
    // Reported here rather than after the timeout so the message matches the cause.
    const failed = spawnError();
    if (failed) {
      throw new CdpLoginError(
        `Could not start the browser: ${failed.message}\n` +
          "Check SCREENER_BROWSER_EXECUTABLE if you set it, or run\n" +
          "`npx screener-mcp login --browser` to use Playwright's browser instead.",
      );
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      const err = stderr();
      // Chrome 151 exits 21 with "Failed to create a ProcessSingleton" when another
      // instance holds the directory. Exit code alone is not documented, so match on
      // either signal.
      if (child.exitCode === 21 || /ProcessSingleton|SingletonLock/i.test(err)) {
        throw profileLockedError(profile);
      }
      throw new CdpLoginError(
        `Chrome stopped straight away (exit code ${child.exitCode ?? child.signalCode}) without opening a window.\n` +
          (err.trim() ? `Chrome said:\n${indent(lastLines(err, 6))}\n\n` : "") +
          "If Chrome will not start this way, `npx screener-mcp login --browser` uses a different route.",
      );
    }

    // Fallback: Chrome also prints "DevTools listening on ws://127.0.0.1:PORT/path".
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)(\/\S*)/.exec(stderr());
    if (m) return { port: Number(m[1]), path: m[2] };

    await sleep(100);
  }
  throw new CdpLoginError("Chrome did not open a debugging connection in time.");
}

/** Ask the HTTP endpoint for the browser socket URL. This doubles as proof the
 * endpoint is actually up, which the file on its own does not tell us. */
async function browserWebSocketUrl(port: number, fallbackPath: string): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) {
      const info = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    }
  } catch {
    // Fall through to the path from DevToolsActivePort, which is the same URL.
  }
  return `ws://127.0.0.1:${port}${fallbackPath}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastLines(s: string, n: number): string {
  return s.trimEnd().split("\n").slice(-n).join("\n");
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

interface CdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  httpOnly?: boolean;
}

interface TargetInfo {
  type?: string;
}

// ---------------------------------------------------------------------------
// The login itself
// ---------------------------------------------------------------------------

/**
 * Open Screener in the user's own Chrome and wait for them to sign in.
 *
 * Deliberately the same signature and the same result shape as `browserLogin`, so
 * the CLI can treat the two as interchangeable.
 */
export async function cdpLogin(opts: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  // Checked first, and before spawning anything: no WebSocket means nothing about
  // this path can work, so that message beats any other complaint we might make.
  webSocketCtor();
  assertDisplay("--chrome");
  const executable = findBrowserExecutable();

  const profile = browserProfilePath();
  assertProfileUnlocked(profile);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);

  // A stale port file from a previous run would send us to a dead port, and we would
  // blame Chrome for it. Remove it so the file we read can only be this run's.
  try {
    rmSync(join(profile, "DevToolsActivePort"));
  } catch {
    // Absent, which is the normal case.
  }

  const args = [
    `--user-data-dir=${profile}`,
    // Port 0 means "pick a free one and tell me", so two logins never collide and we
    // never guess a port that belongs to something else.
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,940",
  ];
  if (headlessRequested()) args.push("--headless=new");
  // Chrome opens a command-line URL in its first window, which saves us a round trip
  // and means the user is looking at the login page before we have even connected.
  args.push(`${BASE}/login/`);

  let child: ChildProcess;
  try {
    child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new CdpLoginError(
      `Could not start ${executable}: ${e instanceof Error ? e.message : String(e)}\n` +
        "Check that it is really a browser program, or unset SCREENER_BROWSER_EXECUTABLE.",
    );
  }

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  // Chrome is chatty on stderr; keep only enough to explain a failure.
  child.stderr?.on("data", (d: string) => {
    stderrBuf = (stderrBuf + d).slice(-8000);
  });
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  let cdp: CdpSession | null = null;
  try {
    // Chrome has 30s to come up. The user's own deadline is for signing in, which is
    // the part that legitimately takes minutes.
    const startupDeadline = Math.min(Date.now() + 30_000, deadline);
    const { port, path } = await waitForDebuggerPort(
      profile,
      child,
      () => stderrBuf,
      (): Error | null => spawnError,
      startupDeadline,
    );

    cdp = await CdpSession.open(await browserWebSocketUrl(port, path));

    let sawAPage = false;
    let sawScreener = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || cdp.closed) {
        throw new CdpLoginError("Browser closed before sign-in completed.");
      }

      // Storage.getCookies is a browser-level call: no target to attach to, no
      // session id, and — the reason this works at all — it returns HttpOnly
      // cookies, which `sessionid` is.
      const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>("Storage.getCookies");
      const found = pickCookies(cookies);
      if (found) return found;
      // Screener sets a CSRF cookie just for showing the login page, so "not one
      // cookie from screener.in in five minutes" almost always means the page never
      // loaded, which is worth saying instead of blaming the user for being slow.
      if (cookies.some((c) => String(c.domain ?? "").endsWith("screener.in"))) sawScreener = true;

      // On macOS closing the last window leaves Chrome running, so waiting for the
      // process to exit would hang. No pages left means the user is done with it.
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      const pages = targetInfos.filter((t) => t.type === "page").length;
      if (pages > 0) sawAPage = true;
      else if (sawAPage) throw new CdpLoginError("Browser closed before sign-in completed.");

      opts.onWait?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
      await sleep(1000);
    }
    throw new CdpLoginError(
      "Timed out waiting for sign-in. Re-run with --timeout <seconds> for longer." +
        (sawScreener
          ? ""
          : "\n\nThe browser never received anything from screener.in, so the login page probably\n" +
            "never loaded. Check this computer's internet connection, then try again."),
    );
  } finally {
    cdp?.close();
    // Close the browser we opened. SIGTERM lets Chrome flush the profile so the
    // sign-in it now holds survives; SIGKILL is only a backstop.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const gone = await Promise.race([
        new Promise<boolean>((r) => child.once("exit", () => r(true))),
        sleep(5000).then(() => false),
      ]);
      if (!gone) child.kill("SIGKILL");
    }
  }
}
