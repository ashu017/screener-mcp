import { createInterface } from "node:readline";
import { clearSession, loadSession, login, LoginError, saveSession, sessionPath, whoami } from "./auth.js";

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
    const sessionId = await login(username, password);
    const who = await whoami(sessionId);
    const path = saveSession({
      sessionId,
      username: who.username || username,
      savedAt: new Date().toISOString(),
    });
    process.stderr.write(`\nSigned in as ${who.username || username}.\nSession saved to ${path} (mode 0600).\n`);
    process.stderr.write("\nAuthenticated tools are now available to any MCP client running this server.\n");
    return 0;
  } catch (e) {
    process.stderr.write(`\nLogin failed: ${e instanceof LoginError ? e.message : String(e)}\n`);
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
  const ok = clearSession();
  process.stderr.write(ok ? `Removed ${sessionPath()}.\n` : "No stored session to remove.\n");
  return 0;
}

const USAGE = `screener-mcp — MCP server for Screener.in

Usage:
  screener-mcp            Run the MCP server on stdio (default; for MCP clients)
  screener-mcp login      Sign in to Screener and store a session cookie
  screener-mcp status     Show whether the stored session is still valid
  screener-mcp logout     Delete the stored session

Environment:
  SCREENER_SESSION_ID     Use this sessionid cookie instead of the stored one
  SCREENER_MCP_CONFIG_DIR Override where the session is stored
`;

/** Returns an exit code when it handled a subcommand, or null to run the server. */
export async function runCli(argv: string[]): Promise<number | null> {
  const cmd = argv[0];
  switch (cmd) {
    case "login":
      return cmdLogin();
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
