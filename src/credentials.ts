import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CREDENTIAL_PROVIDERS, type CredentialProvider, getCredentialProvider } from "./providers/credential-providers";

const KEYCHAIN_SERVICE = "pi-scryer";
const COMMAND_USAGE = `/scryer login <keyed-provider> | logout <keyed-provider> | status (keyed providers: ${CREDENTIAL_PROVIDERS.map((provider) => provider.name).join(", ")})`;
const RESTART_NOTICE = "Restart Pi to refresh the cached provider registry.";

export { KEYCHAIN_SERVICE };

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
 * Prompts the user for an API key via a hidden macOS dialog. The
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

function hasEnvKey(provider: CredentialProvider): boolean {
  return Boolean(process.env[provider.envVariable]?.trim());
}

/** Reports every registered credential source without reading Keychain values. */
async function reportStatus(ctx: ExtensionCommandContext): Promise<void> {
  for (const provider of CREDENTIAL_PROVIDERS) {
    const source = (await hasKeychainKey(provider.name))
      ? "Keychain"
      : hasEnvKey(provider)
        ? `environment (${provider.envVariable})`
        : "missing";
    ctx.ui.notify(`scryer: ${provider.displayName} API key source: ${source}`, "info");
  }
}

/** Prompts only in the interactive macOS TUI; otherwise gives env guidance. */
async function handleLogin(provider: CredentialProvider, ctx: ExtensionCommandContext): Promise<void> {
  if (!isMacOS() || ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      `scryer: login requires the interactive macOS TUI; set the ${provider.envVariable} environment variable instead`,
      "error",
    );
    return;
  }

  let entered: string | null;
  try {
    entered = await promptForApiKey(`Enter your ${provider.displayName} API key`);
  } catch {
    ctx.ui.notify(`scryer: failed to read the ${provider.displayName} API key`, "error");
    return;
  }

  if (entered === null) {
    ctx.ui.notify(`scryer: ${provider.displayName} login cancelled`, "info");
    return;
  }

  const trimmed = entered.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(`scryer: no ${provider.displayName} API key entered`, "error");
    return;
  }

  try {
    await storeKeychainKey(provider.name, trimmed);
  } catch {
    ctx.ui.notify(`scryer: failed to store the ${provider.displayName} API key in Keychain`, "error");
    return;
  }

  ctx.ui.notify(`scryer: ${provider.displayName} API key stored in Keychain. ${RESTART_NOTICE}`, "info");
}

/** Removes only the selected Keychain item; its environment fallback remains. */
async function handleLogout(provider: CredentialProvider, ctx: ExtensionCommandContext): Promise<void> {
  if (!isMacOS()) {
    ctx.ui.notify(
      `scryer: Keychain is only available on macOS; unset ${provider.envVariable} to remove the environment fallback`,
      "info",
    );
    return;
  }

  try {
    await deleteKeychainKey(provider.name);
  } catch {
    ctx.ui.notify(`scryer: failed to remove the ${provider.displayName} API key from Keychain`, "error");
    return;
  }

  const fallback = hasEnvKey(provider)
    ? `; ${provider.envVariable} environment variable is still set and will be used`
    : "";
  ctx.ui.notify(`scryer: ${provider.displayName} API key removed from Keychain${fallback}. ${RESTART_NOTICE}`, "info");
}

/** Validates all arguments before prompting or invoking Keychain operations. */
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

  const [command, name, ...extra] = trimmed.split(/\s+/);
  const provider = CREDENTIAL_PROVIDERS.find((provider) => provider.name === name);
  if (provider && extra.length === 0) {
    if (command === "login") {
      await handleLogin(provider, ctx);
      return;
    }
    if (command === "logout") {
      await handleLogout(provider, ctx);
      return;
    }
  }
  ctx.ui.notify(COMMAND_USAGE, "warning");
}

export function registerScryerCommand(api: ExtensionAPI): void {
  api.registerCommand("scryer", {
    description: "Manage provider API keys used by pi-scryer (status, login <provider>, logout <provider>)",
    getArgumentCompletions: (prefix) => {
      let values: string[];
      if (!/\s/.test(prefix)) {
        values = ["login", "logout", "status"].filter((command) => command.startsWith(prefix));
      } else {
        const match = /^(login|logout) ([^\s]*)$/.exec(prefix);
        if (!match) return null;
        values = CREDENTIAL_PROVIDERS.filter((provider) => provider.name.startsWith(match[2])).map(
          (provider) => `${match[1]} ${provider.name}`,
        );
      }
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: scryerCommandHandler,
  });
}
