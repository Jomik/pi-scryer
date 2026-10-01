import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteKeychainKey,
  fetchKeychainKey,
  hasKeychainKey,
  KEYCHAIN_SERVICE,
  promptForApiKey,
  resolveProviderApiKey,
  scryerCommandHandler,
  storeKeychainKey,
} from "../src/credentials";
import type { ProviderStatus } from "../src/provider-routing";
import { CREDENTIAL_PROVIDERS } from "../src/providers/credential-providers";
// setupFiles installs this mock before the credentials module is imported.
// mockReset restores its throwing/tracked baseline, never an empty function.
import { execFileMock } from "./setup";

const ORIGINAL_ENV = process.env.EXA_API_KEY;
const ORIGINAL_TAVILY_ENV = process.env.TAVILY_API_KEY;
const SECRET_KEY = "test-only-secret-key";

type ExecFileCallback = (
  error: (Error & { stdout?: string; stderr?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

function mockMacOS(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
}

function mockNonMacOS(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
}

function succeedWith(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
    callback(null, stdout, "");
  });
}

function failWith(stderr: string): void {
  execFileMock.mockImplementation((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
    const error = new Error("subprocess failed") as Error & { stdout?: string; stderr?: string };
    error.stdout = "";
    error.stderr = stderr;
    callback(error, "", stderr);
  });
}

describe("credentials", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    if (ORIGINAL_TAVILY_ENV === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = ORIGINAL_TAVILY_ENV;
    }
    vi.restoreAllMocks();
  });

  describe("resolveProviderApiKey", () => {
    it("prefers Tavily Keychain over its env and never uses Exa credentials", async () => {
      mockMacOS();
      succeedWith(`  ${SECRET_KEY}  \n`);
      process.env.TAVILY_API_KEY = "tavily-env";
      process.env.EXA_API_KEY = "exa-env";

      await expect(resolveProviderApiKey("tavily")).resolves.toBe(SECRET_KEY);
      expect(execFileMock.mock.calls[0][1]).toEqual([
        "find-generic-password",
        "-s",
        "pi-scryer",
        "-a",
        "tavily-api-key",
        "-w",
      ]);
    });

    it.each([
      "missing",
      "inaccessible",
      "empty",
    ])("falls back to trimmed Tavily env when Keychain is %s", async (state) => {
      mockMacOS();
      if (state === "empty") succeedWith("  \n");
      else failWith(state === "missing" ? "The specified item could not be found." : `denied ${SECRET_KEY}`);
      process.env.TAVILY_API_KEY = "  tavily-env  ";
      process.env.EXA_API_KEY = "exa-env";

      await expect(resolveProviderApiKey("tavily")).resolves.toBe("tavily-env");
    });

    it.each(["linux", "win32"] as const)("uses only trimmed Tavily env on %s without caching", async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      process.env.TAVILY_API_KEY = "  tavily-env  ";
      process.env.EXA_API_KEY = "exa-env";

      await expect(resolveProviderApiKey("tavily")).resolves.toBe("tavily-env");
      process.env.TAVILY_API_KEY = "next-key";
      await expect(resolveProviderApiKey("tavily")).resolves.toBe("next-key");
      process.env.TAVILY_API_KEY = "  ";
      await expect(resolveProviderApiKey("tavily")).resolves.toBeUndefined();
      delete process.env.TAVILY_API_KEY;
      await expect(resolveProviderApiKey("tavily")).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("re-reads Keychain on each call and does not fall back to Exa env", async () => {
      mockMacOS();
      process.env.EXA_API_KEY = "exa-env";
      succeedWith(SECRET_KEY);
      await expect(resolveProviderApiKey("tavily")).resolves.toBe(SECRET_KEY);
      succeedWith("next-key");
      await expect(resolveProviderApiKey("tavily")).resolves.toBe("next-key");
      succeedWith("  \n");
      await expect(resolveProviderApiKey("tavily")).resolves.toBeUndefined();
      expect(execFileMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("Tavily Keychain operations", () => {
    it("isolates all security argv to Tavily's account, keeping key and shell text discrete", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);
      const key = "key with 'quotes' $(subshell) ; --flags\n";

      await fetchKeychainKey("tavily");
      await hasKeychainKey("tavily");
      await storeKeychainKey("tavily", key);
      await deleteKeychainKey("tavily");

      expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
        ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "tavily-api-key", "-w"]],
        ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "tavily-api-key"]],
        ["security", ["add-generic-password", "-s", "pi-scryer", "-a", "tavily-api-key", "-w", key, "-U"]],
        ["security", ["delete-generic-password", "-s", "pi-scryer", "-a", "tavily-api-key"]],
      ]);
    });

    it("preserves Tavily non-macOS guards", async () => {
      mockNonMacOS();
      await expect(fetchKeychainKey("tavily")).resolves.toBeUndefined();
      await expect(hasKeychainKey("tavily")).resolves.toBe(false);
      await expect(storeKeychainKey("tavily", SECRET_KEY)).rejects.toThrow(
        "credentials: Keychain is only available on macOS",
      );
      await expect(deleteKeychainKey("tavily")).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("preserves sanitized failures and idempotent Tavily deletion", async () => {
      mockMacOS();
      failWith(`raw detail ${SECRET_KEY}`);
      await expect(fetchKeychainKey("tavily")).resolves.toBeUndefined();
      await expect(hasKeychainKey("tavily")).resolves.toBe(false);
      await expect(storeKeychainKey("tavily", SECRET_KEY)).rejects.toEqual(
        new Error("credentials: failed to store key in Keychain"),
      );
      await expect(deleteKeychainKey("tavily")).rejects.toEqual(
        new Error("credentials: failed to delete key from Keychain"),
      );
      failWith("The specified item could not be found in the keychain.");
      await expect(deleteKeychainKey("tavily")).resolves.toBeUndefined();
    });
  });

  describe.each(["darwin", "linux"] as const)("provider validation on %s", (platform) => {
    it.each([
      "unknown",
      "exa-anon",
      "tavily-anon",
      "",
      "EXA",
      "toString",
      "__proto__",
      "exa; $(security)",
    ])("rejects %j for every operation before invoking the OS", async (name) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      process.env.EXA_API_KEY = "exa-env";
      process.env.TAVILY_API_KEY = "tavily-env";
      const error = new Error("credentials: unsupported keyed provider");
      await expect(fetchKeychainKey(name)).rejects.toEqual(error);
      await expect(hasKeychainKey(name)).rejects.toEqual(error);
      await expect(storeKeychainKey(name, SECRET_KEY)).rejects.toEqual(error);
      await expect(deleteKeychainKey(name)).rejects.toEqual(error);
      await expect(resolveProviderApiKey(name)).rejects.toEqual(error);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("resolveProviderApiKey (exa)", () => {
    it("prefers the trimmed Keychain value over env on macOS", async () => {
      mockMacOS();
      succeedWith(`  ${SECRET_KEY}  \n`);
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveProviderApiKey("exa")).resolves.toBe(SECRET_KEY);
    });

    it("falls back to env when the Keychain item is missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveProviderApiKey("exa")).resolves.toBe("env-key");
    });

    it("falls back to env on Keychain access errors, without leaking raw error text", async () => {
      mockMacOS();
      failWith("security: SecKeychainItemCopyContent: The user name or passphrase you entered is not correct.");
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveProviderApiKey("exa")).resolves.toBe("env-key");
    });

    it("returns undefined when both Keychain and env are unavailable", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");

      await expect(resolveProviderApiKey("exa")).resolves.toBeUndefined();
    });

    it("never invokes execFile on non-macOS platforms, using env only", async () => {
      mockNonMacOS();
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveProviderApiKey("exa")).resolves.toBe("env-key");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("ignores an empty Keychain value and an empty env value", async () => {
      mockMacOS();
      succeedWith("   \n");
      process.env.EXA_API_KEY = "   ";

      await expect(resolveProviderApiKey("exa")).resolves.toBeUndefined();
    });
  });

  describe("fetchKeychainKey", () => {
    it("uses the exact fixed security find-generic-password args", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);

      await fetchKeychainKey("exa");

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "exa-api-key", "-w"]);
    });

    it("returns undefined without throwing on non-macOS", async () => {
      mockNonMacOS();
      await expect(fetchKeychainKey("exa")).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("hasKeychainKey", () => {
    it("reports true when a key is present, using args without -w", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);

      await expect(hasKeychainKey("exa")).resolves.toBe(true);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "exa-api-key"]);
    });

    it("reports false when missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      await expect(hasKeychainKey("exa")).resolves.toBe(false);
    });

    it("reports false on non-macOS without invoking a subprocess", async () => {
      mockNonMacOS();
      await expect(hasKeychainKey("exa")).resolves.toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("storeKeychainKey", () => {
    it("uses the exact fixed security add-generic-password args", async () => {
      mockMacOS();
      succeedWith("");

      await storeKeychainKey("exa", SECRET_KEY);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual([
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        "exa-api-key",
        "-w",
        SECRET_KEY,
        "-U",
      ]);
    });

    it("throws a fixed, sanitized error on failure, never the raw error or the key", async () => {
      mockMacOS();
      failWith(`raw failure containing ${SECRET_KEY}`);

      await expect(storeKeychainKey("exa", SECRET_KEY)).rejects.toThrow("credentials: failed to store key in Keychain");
      try {
        await storeKeychainKey("exa", SECRET_KEY);
      } catch (error) {
        expect(String(error)).not.toContain(SECRET_KEY);
      }
    });

    it("throws a fixed error on non-macOS", async () => {
      mockNonMacOS();
      await expect(storeKeychainKey("exa", SECRET_KEY)).rejects.toThrow(
        "credentials: Keychain is only available on macOS",
      );
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("deleteKeychainKey", () => {
    it("uses the exact fixed security delete-generic-password args", async () => {
      mockMacOS();
      succeedWith("");

      await deleteKeychainKey("exa");

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "exa-api-key"]);
    });

    it("is idempotent when the item is already missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");

      await expect(deleteKeychainKey("exa")).resolves.toBeUndefined();
    });

    it("throws a fixed, sanitized error on other failures", async () => {
      mockMacOS();
      failWith("permission denied: raw internal detail");

      await expect(deleteKeychainKey("exa")).rejects.toThrow("credentials: failed to delete key from Keychain");
      try {
        await deleteKeychainKey("exa");
      } catch (error) {
        expect(String(error)).not.toContain("permission denied: raw internal detail");
      }
    });

    it("is a no-op on non-macOS", async () => {
      mockNonMacOS();
      await expect(deleteKeychainKey("exa")).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("promptForApiKey", () => {
    it("invokes osascript with the prompt text as a discrete argv entry (injection-safe)", async () => {
      mockMacOS();
      succeedWith(`${SECRET_KEY}\n`);

      const maliciousPrompt = "Enter \"key\"\nwith `backticks`, $(subshell), and 'quotes'";
      const result = await promptForApiKey(maliciousPrompt);

      expect(result).toBe(SECRET_KEY);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("osascript");
      expect(Array.isArray(args)).toBe(true);
      expect(args[0]).toBe("-e");
      expect(args[2]).toBe(maliciousPrompt);
      expect(String(args[1])).not.toContain(maliciousPrompt);
    });

    it("returns null when the user cancels", async () => {
      mockMacOS();
      failWith("execution error: User canceled. (-128)");

      await expect(promptForApiKey("Enter your Exa API key")).resolves.toBeNull();
    });

    it("throws a fixed error on other failures, never the raw error", async () => {
      mockMacOS();
      failWith(`unexpected raw failure ${SECRET_KEY}`);

      await expect(promptForApiKey("Enter your Exa API key")).rejects.toThrow("credentials: failed to read input");
      try {
        await promptForApiKey("Enter your Exa API key");
      } catch (error) {
        expect(String(error)).not.toContain(SECRET_KEY);
      }
    });

    it("throws a fixed error on non-macOS", async () => {
      mockNonMacOS();
      await expect(promptForApiKey("Enter your Exa API key")).rejects.toThrow(
        "credentials: prompt is only available on macOS",
      );
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});

type FakeCommandCtx = {
  ui: { notify: ReturnType<typeof vi.fn> };
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
};

function createCtx(overrides: Partial<Pick<FakeCommandCtx, "mode" | "hasUI">> = {}): FakeCommandCtx {
  return {
    ui: { notify: vi.fn() },
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
  };
}

function allNotifyMessages(ctx: FakeCommandCtx): string[] {
  return ctx.ui.notify.mock.calls.map((call) => String(call[0]));
}

/**
 * The real handler's context type requires the full ExtensionCommandContext
 * shape; behavior tests only need `ui`, `mode`, and `hasUI`, matching the
 * shared harness's fake context.
 */
const handler = scryerCommandHandler as unknown as (
  args: string,
  ctx: FakeCommandCtx,
  peekRuntimeStatus?: () => readonly ProviderStatus[] | undefined,
) => Promise<void>;

const USAGE = "/scryer login <keyed-provider> | logout <keyed-provider> | status (keyed providers: exa, tavily)";
const RESTART = "Restart Pi to refresh the cached provider registry.";

describe("scryer command", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = ORIGINAL_ENV;
    if (ORIGINAL_TAVILY_ENV === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = ORIGINAL_TAVILY_ENV;
    vi.restoreAllMocks();
  });

  it("with no args, reports all sources then usage without invoking the OS off macOS", async () => {
    mockNonMacOS();
    const ctx = createCtx();
    await handler("", ctx);
    expect(allNotifyMessages(ctx)).toEqual([
      "scryer: Exa API key source: missing",
      "scryer: Tavily API key source: missing",
      "scryer: runtime not initialized",
      USAGE,
    ]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports all Keychain sources using only presence checks, never key reads", async () => {
    mockMacOS();
    succeedWith(SECRET_KEY);
    const ctx = createCtx();
    await handler("  status  ", ctx);
    expect(allNotifyMessages(ctx)).toEqual([
      "scryer: Exa API key source: Keychain",
      "scryer: Tavily API key source: Keychain",
      "scryer: runtime not initialized",
    ]);
    expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "exa-api-key"]],
      ["security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "tavily-api-key"]],
    ]);
  });

  it("reports independent Keychain/env/missing sources without leaking credentials", async () => {
    mockMacOS();
    succeedWith("");
    execFileMock.mockImplementationOnce((_file: string, _args: readonly string[], cb: ExecFileCallback) => {
      cb(new Error("missing"), "", "");
    });
    process.env.EXA_API_KEY = SECRET_KEY;
    process.env.TAVILY_API_KEY = "ignored-env";
    const ctx = createCtx();
    await handler("status", ctx);
    expect(allNotifyMessages(ctx)).toEqual([
      "scryer: Exa API key source: environment (EXA_API_KEY)",
      "scryer: Tavily API key source: Keychain",
      "scryer: runtime not initialized",
    ]);
    failWith(`denied ${SECRET_KEY}`);
    delete process.env.EXA_API_KEY;
    process.env.TAVILY_API_KEY = "  ";
    ctx.ui.notify.mockClear();
    await handler("status", ctx);
    expect(allNotifyMessages(ctx)).toEqual([
      "scryer: Exa API key source: missing",
      "scryer: Tavily API key source: missing",
      "scryer: runtime not initialized",
    ]);
  });

  it("formats detached runtime snapshots with generic labels, ages, and missing keyed routes", async () => {
    mockNonMacOS();
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    process.env.TAVILY_API_KEY = SECRET_KEY;
    const statuses: readonly ProviderStatus[] = Object.freeze([
      Object.freeze({ provider: "exa", mode: "keyed", state: "eligible" }),
      Object.freeze({
        provider: "future\nprovider",
        mode: "anonymous",
        state: "cooling-down",
        retryAt: 101_001,
        lastAttemptAt: 98_001,
        lastSuccessAt: 90_000,
      }),
      Object.freeze({ provider: "expired", mode: "anonymous", state: "cooling-down", retryAt: 100_000 }),
      Object.freeze({ provider: "quota-provider", mode: "anonymous", state: "disabled", disabledReason: "quota" }),
      Object.freeze({
        provider: "invalid-provider",
        mode: "keyed",
        state: "disabled",
        disabledReason: "invalid-credentials",
        lastAttemptAt: 0,
      }),
      Object.freeze({ provider: "tavily", mode: "anonymous", state: "eligible" }),
    ] as const);
    const before = JSON.stringify(statuses);
    const peek = vi.fn(() => statuses);
    const ctx = createCtx();
    await handler("status", ctx, peek);
    expect(allNotifyMessages(ctx)).toEqual([
      "scryer: Exa API key source: missing",
      "scryer: Tavily API key source: environment (TAVILY_API_KEY)",
      "scryer: Exa (keyed): eligible · last attempt: never · last success: never",
      "scryer: Future provider (anonymous): cooling down · retry in 2s · last attempt: 1s ago · last success: 10s ago",
      "scryer: Expired (anonymous): eligible · last attempt: never · last success: never",
      "scryer: Quota-provider (anonymous): disabled · quota exhausted · last attempt: never · last success: never",
      "scryer: Invalid-provider (keyed): disabled · invalid credentials · last attempt: 100s ago · last success: never",
      "scryer: Tavily (anonymous): eligible · last attempt: never · last success: never",
      "scryer: Tavily (keyed): not configured",
    ]);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(statuses)).toBe(before);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("distinguishes an empty initialized snapshot from an unresolved runtime", async () => {
    mockNonMacOS();
    const ctx = createCtx();
    await handler("status", ctx, () => []);
    expect(allNotifyMessages(ctx).slice(2)).toEqual([
      "scryer: Exa (keyed): not configured",
      "scryer: Tavily (keyed): not configured",
    ]);
  });

  it("peeks only for status and empty args, never login, logout, or invalid args", async () => {
    mockNonMacOS();
    const peek = vi.fn(() => undefined);
    const ctx = createCtx();
    for (const args of ["login exa", "logout tavily", "bogus", "status exa"]) {
      await handler(args, ctx, peek);
    }
    expect(peek).not.toHaveBeenCalled();
    for (const args of ["status", ""]) {
      ctx.ui.notify.mockClear();
      await handler(args, ctx, peek);
      expect(allNotifyMessages(ctx)).toContain("scryer: runtime not initialized");
      expect(allNotifyMessages(ctx).join("\n")).not.toMatch(/eligible|not configured|cooling down|disabled/);
    }
    expect(peek).toHaveBeenCalledTimes(2);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  describe.each(CREDENTIAL_PROVIDERS)("$name commands", (provider) => {
    const { name, displayName, envVariable, keychainAccount } = provider;

    it("accepts explicit login with whitespace and stores only the selected account", async () => {
      mockMacOS();
      succeedWith(`  ${SECRET_KEY}  \n`);
      const ctx = createCtx();
      await handler(`  login\t${name}  `, ctx);
      expect(execFileMock.mock.calls.map(([file]) => file)).toEqual(["osascript", "security"]);
      const promptArgs = execFileMock.mock.calls[0][1];
      expect(promptArgs[2]).toBe(`Enter your ${displayName} API key`);
      expect(promptArgs[1]).toContain("with hidden answer");
      expect(promptArgs[1]).not.toContain(displayName);
      expect(execFileMock.mock.calls[1][1]).toEqual([
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        keychainAccount,
        "-w",
        SECRET_KEY,
        "-U",
      ]);
      expect(allNotifyMessages(ctx)).toEqual([`scryer: ${displayName} API key stored in Keychain. ${RESTART}`]);
    });

    it("reports selected-provider cancellation without storing", async () => {
      mockMacOS();
      failWith("execution error: User canceled. (-128)");
      const ctx = createCtx();
      await handler(`login ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([`scryer: ${displayName} login cancelled`]);
      expect(execFileMock.mock.calls.map(([file]) => file)).toEqual(["osascript"]);
    });

    it("rejects an empty prompted key", async () => {
      mockMacOS();
      succeedWith("  \n");
      const ctx = createCtx();
      await handler(`login ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([`scryer: no ${displayName} API key entered`]);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it.each(["prompt", "store"])("sanitizes %s failures", async (stage) => {
      mockMacOS();
      failWith(`raw failure ${SECRET_KEY}`);
      if (stage === "store") {
        execFileMock.mockImplementationOnce((_file: string, _args: readonly string[], cb: ExecFileCallback) => {
          cb(null, SECRET_KEY, "");
        });
      }
      const ctx = createCtx();
      await handler(`login ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([
        stage === "prompt"
          ? `scryer: failed to read the ${displayName} API key`
          : `scryer: failed to store the ${displayName} API key in Keychain`,
      ]);
    });

    it.each([
      { platform: "linux", mode: "tui", hasUI: true },
      { platform: "darwin", mode: "rpc", hasUI: true },
      { platform: "darwin", mode: "json", hasUI: false },
      { platform: "darwin", mode: "print", hasUI: false },
      { platform: "darwin", mode: "tui", hasUI: false },
    ] as const)("gives selected env guidance without OS access: %j", async ({ platform, mode, hasUI }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const ctx = createCtx({ mode, hasUI });
      await handler(`login ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([
        `scryer: login requires the interactive macOS TUI; set the ${envVariable} environment variable instead`,
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it.each([false, true])("logs out only the selected account, preserving env fallback (%s)", async (envSet) => {
      mockMacOS();
      succeedWith("");
      process.env.EXA_API_KEY = "other-env";
      process.env.TAVILY_API_KEY = "other-env";
      if (envSet) process.env[envVariable] = SECRET_KEY;
      else delete process.env[envVariable];
      const ctx = createCtx();
      await handler(`logout ${name}`, ctx);
      expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
        ["security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount]],
      ]);
      const fallback = envSet ? `; ${envVariable} environment variable is still set and will be used` : "";
      expect(allNotifyMessages(ctx)).toEqual([
        `scryer: ${displayName} API key removed from Keychain${fallback}. ${RESTART}`,
      ]);
      expect(process.env[envVariable]).toBe(envSet ? SECRET_KEY : undefined);
      expect(process.env[name === "exa" ? "TAVILY_API_KEY" : "EXA_API_KEY"]).toBe("other-env");
    });

    it("treats an already missing item as successful logout", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      const ctx = createCtx();
      await handler(`logout ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([`scryer: ${displayName} API key removed from Keychain. ${RESTART}`]);
    });

    it("sanitizes deletion failures without claiming success", async () => {
      mockMacOS();
      failWith(`permission denied ${SECRET_KEY}`);
      const ctx = createCtx();
      await handler(`logout ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([`scryer: failed to remove the ${displayName} API key from Keychain`]);
    });

    it("gives selected env logout guidance off macOS", async () => {
      mockNonMacOS();
      const ctx = createCtx();
      await handler(`logout ${name}`, ctx);
      expect(allNotifyMessages(ctx)).toEqual([
        `scryer: Keychain is only available on macOS; unset ${envVariable} to remove the environment fallback`,
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    "login",
    "logout",
    "bogus",
    "status exa",
    "status secret",
    "login unknown",
    "logout unknown",
    "login exa-anon",
    "logout tavily-anon",
    "login EXA",
    "login toString",
    "logout __proto__",
    `login exa ${SECRET_KEY}`,
    `login tavily ${SECRET_KEY}`,
    `logout exa ${SECRET_KEY}`,
    `logout tavily ${SECRET_KEY}`,
    `login ${SECRET_KEY}`,
  ])("rejects invalid arguments %j before any prompt or Keychain access", async (args) => {
    mockMacOS();
    const ctx = createCtx();
    await handler(args, ctx);
    expect(ctx.ui.notify.mock.calls).toEqual([[USAGE, "warning"]]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
