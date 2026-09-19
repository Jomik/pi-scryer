import { execFile } from "node:child_process";

const KEYCHAIN_SERVICE = "pi-scryer";
const KEYCHAIN_ACCOUNT = "exa-api-key";

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
 * Reads the Exa API key from the macOS Keychain. Returns undefined when not
 * on macOS, when no item exists, when the stored value is empty, or on any
 * subprocess failure. Never throws.
 */
export async function fetchKeychainKey(): Promise<string | undefined> {
  if (!isMacOS()) {
    return undefined;
  }
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a Keychain item exists for the Exa API key, without ever
 * reading or exposing its value. Runs the presence check without the `-w`
 * flag. Returns false on non-macOS platforms (no subprocess invoked) and on
 * any missing item or subprocess failure.
 */
export async function hasKeychainKey(): Promise<boolean> {
  if (!isMacOS()) {
    return false;
  }
  try {
    await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stores or updates the Exa API key in the macOS Keychain. Throws a fixed,
 * sanitized error (never the raw subprocess error or the supplied key) on
 * failure.
 */
export async function storeKeychainKey(apiKey: string): Promise<void> {
  if (!isMacOS()) {
    throw new Error("credentials: Keychain is only available on macOS");
  }
  try {
    await run("security", ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", apiKey, "-U"]);
  } catch {
    throw new Error("credentials: failed to store key in Keychain");
  }
}

/**
 * Deletes the Exa API key from the macOS Keychain. Idempotent: a missing
 * item is treated as success. Throws a fixed, sanitized error on any other
 * failure.
 */
export async function deleteKeychainKey(): Promise<void> {
  if (!isMacOS()) {
    return;
  }
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
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
 * Resolves the Exa API key to use for outgoing requests. On macOS, the
 * Keychain is consulted first; if it is missing, empty, or inaccessible,
 * falls back to the trimmed EXA_API_KEY environment variable. On non-macOS
 * platforms only the environment variable is consulted; the Keychain is
 * never invoked. The key is never cached: each call re-reads the source(s).
 */
export async function resolveExaApiKey(): Promise<string | undefined> {
  if (isMacOS()) {
    const keychainKey = await fetchKeychainKey();
    if (keychainKey !== undefined) {
      return keychainKey;
    }
  }
  const envKey = process.env.EXA_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : undefined;
}
