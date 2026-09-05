import { createInterface } from "node:readline";
import { clearSession, login, LoginError, saveSession, sessionPath, sessionState, whoami } from "./auth.js";
import {
  browserLogin,
  BrowserLoginError,
  browserProfilePath,
  clearBrowserProfile,
  type BrowserLoginOptions,
  type BrowserLoginResult,
} from "./browser-login.js";
import { cdpLogin } from "./cdp-login.js";

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (a) => (rl.close(), resolve(a.trim()))));
}

/** Read a secret without echoing it to the terminal. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      reject(
        new Error(
          "Not a TTY, so the password cannot be read without echoing it. " +
            "Run `npx screener-mcp login` in an interactive terminal, or set SCREENER_SESSION_ID.",
        ),
      );
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let secret = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          resolve(secret);
          return;
        }
        if (c === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") secret = secret.slice(0, -1);
        else secret += c;
      }
    };
    stdin.on("data", onData);
  });
}

/** Shared tail of both login paths: verify the cookie, persist it, report. */
async function persistLogin(sessionId: string, csrfToken: string | undefined, fallbackName: string): Promise<number> {
  const who = await whoami(sessionId);
  if (!who.valid) {
    process.stderr.write(
      "\nScreener returned a session cookie but then rejected it. Nothing was saved.\nTry again, or sign in at https://www.screener.in/ first.\n",
    );
    return 1;
  }
  const path = saveSession({
    sessionId,
    csrfToken,
    username: who.username || fallbackName || undefined,
    savedAt: new Date().toISOString(),
  });
  process.stderr.write(`\nSigned in as ${who.username || fallbackName || "(unknown)"}.\n`);
  process.stderr.write(`Session saved to ${path} (mode 0600).\n`);
  process.stderr.write("\nAuthenticated tools are now available to any MCP client running this server.\n");
  return 0;
}

/**
 * Open a browser and wait for the user to sign in. Either path works for
 * Google/Apple accounts, which have no password to post; they differ only in where
 * the browser comes from.
 */
async function cmdLoginBrowser(
  how: "--browser" | "--chrome",
  timeoutMs: number,
): Promise<number> {
  const run: (o: BrowserLoginOptions) => Promise<BrowserLoginResult> =
    how === "--chrome" ? cdpLogin : browserLogin;

  process.stderr.write(
    (how === "--chrome"
      ? "Opening Screener in a new window of the Chrome you already have. Sign in however\n" +
        "you normally do — Google, Apple, or email and password. Nothing you type passes\n" +
        "through this process.\n\n" +
        "Chrome will open with a profile of its own, so your usual tabs, bookmarks and\n" +
        "history are untouched — and it will ask you to sign in even if you are already\n" +
        "signed in elsewhere. It only asks once; the profile is remembered after that.\n\n"
      : "Opening Screener in a browser window. Sign in however you normally do — Google,\n" +
        "Apple, or email and password. Nothing you type passes through this process.\n\n"),
  );
  const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let tick = 0;
  const progress = process.stderr.isTTY
    ? (left: number) => {
        process.stderr.write(`\r  ${spin[tick++ % spin.length]} waiting for sign-in… ${left}s left `);
      }
    : undefined;

  try {
    const { sessionId, csrfToken } = await run({ timeoutMs, onWait: progress });
    if (progress) process.stderr.write("\r  ✔ session cookie captured                    \n");
    return persistLogin(sessionId, csrfToken, "");
  } catch (e) {
    if (progress) process.stderr.write("\r                                              \r");
    process.stderr.write(`\n${e instanceof BrowserLoginError ? e.message : `Browser login failed: ${String(e)}`}\n`);
    return 1;
  }
}

async function cmdLogin(): Promise<number> {
  process.stderr.write(
    "Sign in to Screener.in. Your password is used once to obtain a session cookie and is never stored.\n\n",
  );
  const username = process.env.SCREENER_USERNAME || (await ask("Email or username: "));
  if (!username) {
    process.stderr.write("No username given.\n");
    return 1;
  }
  // Supported for CI/headless use; interactive prompt is preferred.
  const password = process.env.SCREENER_PASSWORD || (await askHidden("Password: "));
  if (!password) {
    process.stderr.write("No password given.\n");
    return 1;
  }

  try {
    return await persistLogin(await login(username, password), undefined, username);
  } catch (e) {
    process.stderr.write(`\nLogin failed: ${e instanceof LoginError ? e.message : String(e)}\n`);
    process.stderr.write(
      "\nIf you signed up with Google or Apple there is no password to use here —\n" +
        "run `npx screener-mcp login --chrome` instead.\n",
    );
    return 1;
  }
}

/** The three states are worth distinguishing here for the same reason they are worth
 * distinguishing in the MCP tool: "expired" and "never signed in" need different words. */
async function cmdStatus(): Promise<number> {
  const st = await sessionState();
  switch (st.state) {
    case "anonymous":
      process.stderr.write(`Not signed in. No session at ${st.sessionFile}.\n\n${st.instruction}\n`);
      return 1;
    case "expired":
      process.stderr.write(
        `Signed in previously${st.account ? ` as ${st.account}` : ""} (saved ${st.savedAt}), but that\n` +
          `session has expired — Screener no longer accepts it.\n\n${st.instruction}\n`,
      );
      return 1;
    case "unknown":
      process.stderr.write(
        `Could not check the saved sign-in: ${st.reason}\n\n${st.instruction}\n`,
      );
      return 1;
    case "active":
      process.stderr.write(
        `Signed in as ${st.account ?? "(unknown)"}. Session saved ${st.savedAt}.\n`,
      );
      return 0;
  }
}

function cmdLogout(): number {
  const removedSession = clearSession();
  process.stderr.write(removedSession ? `Removed ${sessionPath()}.\n` : "No stored session to remove.\n");
  // The browser profile holds a live sign-in of its own, so "log out" has to take
  // that with it — otherwise `login --browser` would silently re-use the account.
  if (clearBrowserProfile()) process.stderr.write(`Removed browser profile ${browserProfilePath()}.\n`);
  return 0;
}

const USAGE = `screener-mcp — MCP server for Screener.in

Usage:
  screener-mcp                    Run the MCP server on stdio (default; for MCP clients)
  screener-mcp login              Sign in with email + password, store a session cookie
  screener-mcp login --chrome     Sign in in the Chrome you already have (Google/Apple too)
  screener-mcp login --browser    Sign in in a Playwright browser (Google/Apple too)
  screener-mcp status             Show whether the stored session is still valid
  screener-mcp logout             Delete the stored session and browser profile

Options:
  --chrome                Open the Chrome (or Chromium/Edge/Brave) already installed
                          on this computer and wait for you to sign in. Nothing to
                          download. Works for Google/Apple accounts, which have no
                          password to post. Needs Node 22+ and a display.
  --browser               The same thing through Playwright, which downloads its own
                          browser. Needs Playwright and Node 20+, and a display.
                          Use this if --chrome cannot find a browser.
  --timeout <seconds>     How long --chrome/--browser waits for sign-in (default 300)

Both browser options open a browser profile of their own, kept separate from your
everyday one, so you sign in there once. Neither ever sees your password.

Environment:
  SCREENER_SESSION_ID          Use this sessionid cookie instead of the stored one.
                               Note it overrides a saved sign-in, so \`login\` cannot
                               replace an expired value here.
  SCREENER_MCP_CONFIG_DIR      Override where the session and profile are stored
  SCREENER_BROWSER_EXECUTABLE  Path to the browser to use for --chrome or --browser
  SCREENER_PLAYWRIGHT_PATH     Path to a playwright module dir, if not in cwd
  SCREENER_BROWSER_HEADLESS    Run --chrome/--browser headless; only refreshes a
                               profile that is already signed in
`;

/** Returns an exit code when it handled a subcommand, or null to run the server. */
export async function runCli(argv: string[]): Promise<number | null> {
  const cmd = argv[0];
  const flags = argv.slice(1);
  switch (cmd) {
    case "login": {
      const known = new Set(["--browser", "--chrome", "--timeout"]);
      const unknown = flags.filter((a, i) => a.startsWith("-") && !known.has(a) && flags[i - 1] !== "--timeout");
      if (unknown.length) {
        process.stderr.write(`Unknown option(s) for login: ${unknown.join(", ")}\n\n${USAGE}`);
        return 1;
      }
      const wantsChrome = flags.includes("--chrome");
      const wantsPlaywright = flags.includes("--browser");
      if (wantsChrome && wantsPlaywright) {
        process.stderr.write(
          "Pick one of --chrome or --browser, not both.\n" +
            "  --chrome  uses the browser already on this computer (nothing to download)\n" +
            "  --browser uses Playwright's own browser\n",
        );
        return 1;
      }
      // Validated even when no browser flag was given, so a stray --timeout is never
      // silently ignored.
      const raw = flags[flags.indexOf("--timeout") + 1];
      const seconds = flags.includes("--timeout") ? Number(raw) : 300;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        process.stderr.write(`--timeout needs a positive number of seconds, got '${raw ?? ""}'.\n`);
        return 1;
      }
      if (!wantsChrome && !wantsPlaywright) return cmdLogin();
      return cmdLoginBrowser(wantsChrome ? "--chrome" : "--browser", seconds * 1000);
    }
    case "status":
      return cmdStatus();
    case "logout":
      return cmdLogout();
    case "help":
    case "--help":
    case "-h":
      process.stderr.write(USAGE);
      return 0;
    case undefined:
      return null;
    default:
      process.stderr.write(`Unknown command '${cmd}'.\n\n${USAGE}`);
      return 1;
  }
}
