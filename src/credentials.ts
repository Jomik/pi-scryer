import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getCredentialProvider } from "./providers/credential-providers";

const KEYCHAIN_SERVICE = "pi-scryer";
const KEYCHAIN_ACCOUNT = getCredentialProvider("exa").keychainAccount;
const COMMAND_USAGE = "/scryer login|logout|status";
const PROMPT_TEXT = "Enter your Exa API key";

export { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE };

type SubprocessError = Error & { stdout?: string; stderr?: string };

function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Runs a subprocess and resolves with its stdout/stderr, or rejects with the
 * raw error (annotated with stdout/stderr) for internal inspection only.
 * Callers must never expose this raw error to the user; translate it to a
 * fixed, sanitized message first.
 */
function run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], (error, stdout, stderr) => {
      const outText = typeof stdout === "string" ? stdout : String(stdout ?? "");
      const errText = typeof stderr === "string" ? stderr : String(stderr ?? "");
      if (error) {
        const subprocessError = error as SubprocessError;
        subprocessError.stdout = outText;
        subprocessError.stderr = errText;
        reject(subprocessError);
        return;
      }
      resolve({ stdout: outText, stderr: errText });
    });
  });
}

function extractErrorText(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as SubprocessError).stderr ?? "") : "";
    const message = "message" in error ? String((error as SubprocessError).message ?? "") : "";
    return `${stderr}\n${message}`;
  }
  return "";
}

function isItemNotFoundError(error: unknown): boolean {
  return /could not be found/i.test(extractErrorText(error));
}

function isUserCancelledError(error: unknown): boolean {
  const text = extractErrorText(error);
  return text.includes("-128") || /user (cancel(l)?ed)/i.test(text);
}

/**
 * Reads the provider API key from the macOS Keychain. Returns undefined when not
 * on macOS, when no item exists, when the stored value is empty, or on any
 * subprocess failure. Rejects unsupported provider names before any subprocess.
 */
export async function fetchKeychainKey(name: string): Promise<string | undefined> {
  const provider = getCredentialProvider(name);
  if (!isMacOS()) {
    return undefined;
  }
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      provider.keychainAccount,
      "-w",
    ]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a Keychain item exists for the provider API key, without ever
 * reading or exposing its value. Runs the presence check without the `-w`
 * flag. Returns false on non-macOS platforms (no subprocess invoked) and on
 * any missing item or subprocess failure.
 */
export async function hasKeychainKey(name: string): Promise<boolean> {
  const provider = getCredentialProvider(name);
  if (!isMacOS()) {
    return false;
  }
  try {
    await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider.keychainAccount]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stores or updates the provider API key in the macOS Keychain. Throws a fixed,
 * sanitized error (never the raw subprocess error or the supplied key) on
 * failure.
 */
export async function storeKeychainKey(name: string, apiKey: string): Promise<void> {
  const provider = getCredentialProvider(name);
  if (!isMacOS()) {
    throw new Error("credentials: Keychain is only available on macOS");
  }
  try {
    await run("security", [
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      provider.keychainAccount,
      "-w",
      apiKey,
      "-U",
    ]);
  } catch {
    throw new Error("credentials: failed to store key in Keychain");
  }
}

/**
 * Deletes the provider API key from the macOS Keychain. Idempotent: a missing
 * item is treated as success. Throws a fixed, sanitized error on any other
 * failure.
 */
export async function deleteKeychainKey(name: string): Promise<void> {
  const provider = getCredentialProvider(name);
  if (!isMacOS()) {
    return;
  }
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider.keychainAccount]);
  } catch (error) {
    if (isItemNotFoundError(error)) {
      return;
    }
    throw new Error("credentials: failed to delete key from Keychain");
  }
}

/**
 * Prompts the user for the Exa API key via a hidden macOS dialog. The
 * prompt text is passed as a discrete argv entry to the AppleScript (never
 * interpolated into the script source), avoiding injection. Returns the
 * entered value, or null if the user cancelled. Throws a fixed, sanitized
 * error on any other failure.
 */
export async function promptForApiKey(promptText: string): Promise<string | null> {
  if (!isMacOS()) {
    throw new Error("credentials: prompt is only available on macOS");
  }
  const script =
    'on run argv\n  set promptText to item 1 of argv\n  display dialog promptText default answer "" with hidden answer with title "pi-scryer"\n  return text returned of result\nend run';
  try {
    const { stdout } = await run("osascript", ["-e", script, promptText]);
    return stdout.replace(/\r?\n$/, "");
  } catch (error) {
    if (isUserCancelledError(error)) {
      return null;
    }
    throw new Error("credentials: failed to read input");
  }
}

/**
 * Resolves a keyed provider API key to use for outgoing requests. On macOS, the
 * Keychain is consulted first; if it is missing, empty, or inaccessible,
 * falls back to the trimmed provider environment variable. On non-macOS
 * platforms only the environment variable is consulted; the Keychain is
 * never invoked. The key is never cached: each call re-reads the source(s).
 */
export async function resolveProviderApiKey(name: string): Promise<string | undefined> {
  const provider = getCredentialProvider(name);
  if (isMacOS()) {
    const keychainKey = await fetchKeychainKey(name);
    if (keychainKey !== undefined) {
      return keychainKey;
    }
  }
  const envKey = process.env[provider.envVariable]?.trim();
  return envKey && envKey.length > 0 ? envKey : undefined;
}

/** Temporary Exa compatibility wrapper until callers migrate to provider credentials. */
export async function resolveExaApiKey(): Promise<string | undefined> {
  return resolveProviderApiKey("exa");
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
  if (isMacOS() && (await hasKeychainKey("exa"))) {
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
    await storeKeychainKey("exa", trimmed);
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
    await deleteKeychainKey("exa");
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

/**
 * Registers the `/scryer` command on the provided extension API, wiring the
 * fixed command name, description, and handler.
 */
export function registerScryerCommand(api: ExtensionAPI): void {
  api.registerCommand("scryer", {
    description: "Manage the Exa API key used by pi-scryer (status, login, logout)",
    handler: scryerCommandHandler,
  });
}
