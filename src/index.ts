import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createContinuationCache } from "./continuation-cache";
import { deleteKeychainKey, hasKeychainKey, promptForApiKey, storeKeychainKey } from "./credentials";
import { createWebReadTool } from "./web-read";
import { webSearchTool } from "./web-search";

const COMMAND_NAME = "scryer";
const COMMAND_USAGE = "/scryer login|logout|status";
const PROMPT_TEXT = "Enter your Exa API key";

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function hasEnvKey(): boolean {
  return Boolean(process.env.EXA_API_KEY?.trim());
}

/**
 * Reports which source (if any) will supply the Exa API key, without ever
 * reading or exposing the key's value. Keychain presence is checked first on
 * macOS; only its existence (not its content) is queried.
 */
async function reportStatus(ctx: ExtensionCommandContext): Promise<void> {
  if (isMacOS() && (await hasKeychainKey())) {
    ctx.ui.notify("scryer: Exa API key source: Keychain", "info");
    return;
  }
  if (hasEnvKey()) {
    ctx.ui.notify("scryer: Exa API key source: environment (EXA_API_KEY)", "info");
    return;
  }
  ctx.ui.notify("scryer: Exa API key source: missing", "info");
}

/**
 * Interactively prompts for and stores an Exa API key in the macOS Keychain.
 * Only available on macOS in the interactive TUI; every other case reports a
 * fixed, sanitized guidance message and performs no subprocess.
 */
async function handleLogin(ctx: ExtensionCommandContext): Promise<void> {
  if (!isMacOS() || ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "scryer: login requires the interactive macOS TUI; set the EXA_API_KEY environment variable instead",
      "error",
    );
    return;
  }

  let entered: string | null;
  try {
    entered = await promptForApiKey(PROMPT_TEXT);
  } catch {
    ctx.ui.notify("scryer: failed to read the Exa API key", "error");
    return;
  }

  if (entered === null) {
    ctx.ui.notify("scryer: login cancelled", "info");
    return;
  }

  const trimmed = entered.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify("scryer: no Exa API key entered", "error");
    return;
  }

  try {
    await storeKeychainKey(trimmed);
  } catch {
    ctx.ui.notify("scryer: failed to store the Exa API key in Keychain", "error");
    return;
  }

  ctx.ui.notify("scryer: Exa API key stored in Keychain", "info");
}

/**
 * Idempotently removes the Exa API key from the macOS Keychain. Never
 * touches the EXA_API_KEY environment variable; notifies when it remains as
 * a fallback. Non-macOS platforms perform no subprocess.
 */
async function handleLogout(ctx: ExtensionCommandContext): Promise<void> {
  if (!isMacOS()) {
    ctx.ui.notify(
      "scryer: Keychain is only available on macOS; unset EXA_API_KEY to remove the environment fallback",
      "info",
    );
    return;
  }

  try {
    await deleteKeychainKey();
  } catch {
    ctx.ui.notify("scryer: failed to remove the Exa API key from Keychain", "error");
    return;
  }

  if (hasEnvKey()) {
    ctx.ui.notify(
      "scryer: removed from Keychain; EXA_API_KEY environment variable is still set and will be used",
      "info",
    );
    return;
  }
  ctx.ui.notify("scryer: removed from Keychain", "info");
}

/**
 * Handles the `/scryer` command. Accepts exactly the empty string, `status`,
 * `login`, and `logout` (after trimming); anything else, including extra
 * arguments to a known subcommand, shows the fixed usage message and
 * performs no subprocess.
 */
export async function scryerCommandHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    await reportStatus(ctx);
    ctx.ui.notify(COMMAND_USAGE, "info");
    return;
  }

  if (trimmed === "status") {
    await reportStatus(ctx);
    return;
  }

  if (trimmed === "login") {
    await handleLogin(ctx);
    return;
  }

  if (trimmed === "logout") {
    await handleLogout(ctx);
    return;
  }

  ctx.ui.notify(COMMAND_USAGE, "warning");
}

export default function activate(api: ExtensionAPI): void {
  const cache = createContinuationCache();

  api.on("session_shutdown", async () => {
    await cache.cleanup().catch(() => {});
  });

  api.registerTool(createWebReadTool(cache));
  api.registerTool(webSearchTool);

  api.registerCommand(COMMAND_NAME, {
    description: "Manage the Exa API key used by pi-scryer (status, login, logout)",
    handler: scryerCommandHandler,
  });
}
