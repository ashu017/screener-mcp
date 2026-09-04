import { createInterface } from "node:readline";
import { clearSession, loadSession, login, LoginError, saveSession, sessionPath, whoami } from "./auth.js";
import { browserLogin, BrowserLoginError, browserProfilePath, clearBrowserProfile } from "./browser-login.js";

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
 * Open a browser and wait for the user to sign in. This is the only path that works
 * for Google/Apple accounts, which have no password to post.
 */
async function cmdLoginBrowser(timeoutMs: number): Promise<number> {
  process.stderr.write(
    "Opening Screener in a browser window. Sign in however you normally do — Google,\n" +
      "Apple, or email and password. Nothing you type passes through this process.\n\n",
  );
  const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let tick = 0;
  const progress = process.stderr.isTTY
    ? (left: number) => {
        process.stderr.write(`\r  ${spin[tick++ % spin.length]} waiting for sign-in… ${left}s left `);
      }
    : undefined;

  try {
    const { sessionId, csrfToken } = await browserLogin({ timeoutMs, onWait: progress });
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
        "run `npx screener-mcp login --browser` instead.\n",
    );
    return 1;
  }
}

async function cmdStatus(): Promise<number> {
  const s = loadSession();
  if (!s) {
    process.stderr.write(`Not signed in. No session at ${sessionPath()}.\nRun: npx screener-mcp login\n`);
    return 1;
  }
  const who = await whoami(s.sessionId);
  if (!who.valid) {
    process.stderr.write(`Session found (saved ${s.savedAt}) but Screener rejected it — it has expired.\nRun: npx screener-mcp login\n`);
    return 1;
  }
  process.stderr.write(`Signed in as ${who.username || s.username || "(unknown)"}. Session saved ${s.savedAt}.\n`);
  return 0;
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
  screener-mcp login --browser    Sign in in a real browser window (Google/Apple too)
  screener-mcp status             Show whether the stored session is still valid
  screener-mcp logout             Delete the stored session and browser profile

Options:
  --browser               Open a browser and wait for you to sign in, instead of
                          prompting for a password. Required for Google/Apple
                          accounts, which have no password to post. Needs
                          Playwright and Node 20+; needs a display.
  --timeout <seconds>     How long --browser waits for sign-in (default 300)

Environment:
  SCREENER_SESSION_ID          Use this sessionid cookie instead of the stored one
  SCREENER_MCP_CONFIG_DIR      Override where the session and profile are stored
  SCREENER_BROWSER_EXECUTABLE  Path to an existing Chrome for --browser
  SCREENER_PLAYWRIGHT_PATH     Path to a playwright module dir, if not in cwd
  SCREENER_BROWSER_HEADLESS    Run --browser headless; only refreshes a profile
                               that is already signed in
`;

/** Returns an exit code when it handled a subcommand, or null to run the server. */
export async function runCli(argv: string[]): Promise<number | null> {
  const cmd = argv[0];
  const flags = argv.slice(1);
  switch (cmd) {
    case "login": {
      const unknown = flags.filter((a, i) => a.startsWith("-") && a !== "--browser" && a !== "--timeout" && flags[i - 1] !== "--timeout");
      if (unknown.length) {
        process.stderr.write(`Unknown option(s) for login: ${unknown.join(", ")}\n\n${USAGE}`);
        return 1;
      }
      if (!flags.includes("--browser")) return cmdLogin();
      const raw = flags[flags.indexOf("--timeout") + 1];
      const seconds = flags.includes("--timeout") ? Number(raw) : 300;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        process.stderr.write(`--timeout needs a positive number of seconds, got '${raw ?? ""}'.\n`);
        return 1;
      }
      return cmdLoginBrowser(seconds * 1000);
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
