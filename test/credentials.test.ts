import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteKeychainKey,
  fetchKeychainKey,
  hasKeychainKey,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  promptForApiKey,
  resolveExaApiKey,
  storeKeychainKey,
} from "../src/credentials";
import activate from "../src/index";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const ORIGINAL_ENV = process.env.EXA_API_KEY;
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
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    vi.restoreAllMocks();
  });

  describe("resolveExaApiKey", () => {
    it("prefers the trimmed Keychain value over env on macOS", async () => {
      mockMacOS();
      succeedWith(`  ${SECRET_KEY}  \n`);
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveExaApiKey()).resolves.toBe(SECRET_KEY);
    });

    it("falls back to env when the Keychain item is missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveExaApiKey()).resolves.toBe("env-key");
    });

    it("falls back to env on Keychain access errors, without leaking raw error text", async () => {
      mockMacOS();
      failWith("security: SecKeychainItemCopyContent: The user name or passphrase you entered is not correct.");
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveExaApiKey()).resolves.toBe("env-key");
    });

    it("returns undefined when both Keychain and env are unavailable", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");

      await expect(resolveExaApiKey()).resolves.toBeUndefined();
    });

    it("never invokes execFile on non-macOS platforms, using env only", async () => {
      mockNonMacOS();
      process.env.EXA_API_KEY = "env-key";

      await expect(resolveExaApiKey()).resolves.toBe("env-key");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("ignores an empty Keychain value and an empty env value", async () => {
      mockMacOS();
      succeedWith("   \n");
      process.env.EXA_API_KEY = "   ";

      await expect(resolveExaApiKey()).resolves.toBeUndefined();
    });
  });

  describe("fetchKeychainKey", () => {
    it("uses the exact fixed security find-generic-password args", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);

      await fetchKeychainKey();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    });

    it("returns undefined without throwing on non-macOS", async () => {
      mockNonMacOS();
      await expect(fetchKeychainKey()).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("hasKeychainKey", () => {
    it("reports true when a key is present, using args without -w", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);

      await expect(hasKeychainKey()).resolves.toBe(true);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    });

    it("reports false when missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      await expect(hasKeychainKey()).resolves.toBe(false);
    });

    it("reports false on non-macOS without invoking a subprocess", async () => {
      mockNonMacOS();
      await expect(hasKeychainKey()).resolves.toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("storeKeychainKey", () => {
    it("uses the exact fixed security add-generic-password args", async () => {
      mockMacOS();
      succeedWith("");

      await storeKeychainKey(SECRET_KEY);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual([
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        SECRET_KEY,
        "-U",
      ]);
    });

    it("throws a fixed, sanitized error on failure, never the raw error or the key", async () => {
      mockMacOS();
      failWith(`raw failure containing ${SECRET_KEY}`);

      await expect(storeKeychainKey(SECRET_KEY)).rejects.toThrow("credentials: failed to store key in Keychain");
      try {
        await storeKeychainKey(SECRET_KEY);
      } catch (error) {
        expect(String(error)).not.toContain(SECRET_KEY);
      }
    });

    it("throws a fixed error on non-macOS", async () => {
      mockNonMacOS();
      await expect(storeKeychainKey(SECRET_KEY)).rejects.toThrow("credentials: Keychain is only available on macOS");
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("deleteKeychainKey", () => {
    it("uses the exact fixed security delete-generic-password args", async () => {
      mockMacOS();
      succeedWith("");

      await deleteKeychainKey();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0];
      expect(file).toBe("security");
      expect(args).toEqual(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    });

    it("is idempotent when the item is already missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");

      await expect(deleteKeychainKey()).resolves.toBeUndefined();
    });

    it("throws a fixed, sanitized error on other failures", async () => {
      mockMacOS();
      failWith("permission denied: raw internal detail");

      await expect(deleteKeychainKey()).rejects.toThrow("credentials: failed to delete key from Keychain");
      try {
        await deleteKeychainKey();
      } catch (error) {
        expect(String(error)).not.toContain("permission denied: raw internal detail");
      }
    });

    it("is a no-op on non-macOS", async () => {
      mockNonMacOS();
      await expect(deleteKeychainKey()).resolves.toBeUndefined();
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

type CommandHandler = (args: string, ctx: FakeCommandCtx) => Promise<void>;

/**
 * Activates the extension with a minimal local mock API (registerTool,
 * registerCommand, on) and captures the /scryer command handler. Never
 * imports the shared harness: this file owns its own hoisted
 * node:child_process mock so no real subprocess or dialog can run.
 */
function captureScryerHandler(): { handler: CommandHandler; registerCommand: ReturnType<typeof vi.fn> } {
  const registerTool = vi.fn();
  const on = vi.fn();
  const registerCommand = vi.fn();
  activate({ registerTool, registerCommand, on } as unknown as ExtensionAPI);
  expect(registerCommand).toHaveBeenCalledTimes(1);
  const [name, options] = registerCommand.mock.calls[0] as [string, { handler: CommandHandler }];
  expect(name).toBe("scryer");
  return { handler: options.handler, registerCommand };
}

function allNotifyMessages(ctx: FakeCommandCtx): string[] {
  return ctx.ui.notify.mock.calls.map((call) => String(call[0]));
}

describe("scryer command", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    vi.restoreAllMocks();
  });

  it("registers exactly one scryer command with a description", () => {
    const { registerCommand } = captureScryerHandler();
    const [name, options] = registerCommand.mock.calls[0] as [string, { description?: string }];
    expect(name).toBe("scryer");
    expect(options.description).toBeTruthy();
  });

  it("with no args, reports status then fixed usage", async () => {
    mockNonMacOS();
    const { handler } = captureScryerHandler();
    const ctx = createCtx();

    await handler("", ctx);

    const messages = allNotifyMessages(ctx);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("missing");
    expect(messages[1]).toBe("/scryer login|logout|status");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("trims whitespace around a valid subcommand", async () => {
    mockNonMacOS();
    const { handler } = captureScryerHandler();
    const ctx = createCtx();

    await handler("  status  ", ctx);

    expect(allNotifyMessages(ctx)).toHaveLength(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  describe("status", () => {
    it("reports Keychain when present, probing without -w", async () => {
      mockMacOS();
      succeedWith(SECRET_KEY);
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("status", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: Exa API key source: Keychain"]);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [, args] = execFileMock.mock.calls[0];
      expect(args).not.toContain("-w");
    });

    it("reports environment when Keychain is absent but EXA_API_KEY is set", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      process.env.EXA_API_KEY = "env-key";
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("status", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: Exa API key source: environment (EXA_API_KEY)"]);
    });

    it("reports missing when neither source is available", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("status", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: Exa API key source: missing"]);
    });
  });

  describe("login", () => {
    it("stores a trimmed key on success in the macOS TUI", async () => {
      mockMacOS();
      succeedWith(`  ${SECRET_KEY}  \n`);
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: Exa API key stored in Keychain"]);
      const storeCall = execFileMock.mock.calls.find((call) => call[0] === "security");
      expect(storeCall?.[1]).toEqual([
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        SECRET_KEY,
        "-U",
      ]);
    });

    it("reports cancellation without storing anything", async () => {
      mockMacOS();
      failWith("execution error: User canceled. (-128)");
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: login cancelled"]);
      expect(execFileMock.mock.calls.some((call) => call[0] === "security")).toBe(false);
    });

    it("rejects an empty key without storing anything", async () => {
      mockMacOS();
      succeedWith("   \n");
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: no Exa API key entered"]);
      expect(execFileMock.mock.calls.some((call) => call[0] === "security")).toBe(false);
    });

    it("reports a fixed, sanitized error when storing fails", async () => {
      mockMacOS();
      execFileMock
        .mockImplementationOnce((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
          callback(null, `${SECRET_KEY}\n`, "");
        })
        .mockImplementationOnce((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
          const error = new Error("subprocess failed") as Error & { stdout?: string; stderr?: string };
          const stderr = `permission denied: raw detail containing ${SECRET_KEY}`;
          error.stdout = "";
          error.stderr = stderr;
          callback(error, "", stderr);
        });
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: failed to store the Exa API key in Keychain"]);
    });

    it("reports a fixed error and never invokes a subprocess on non-macOS", async () => {
      mockNonMacOS();
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual([
        "scryer: login requires the interactive macOS TUI; set the EXA_API_KEY environment variable instead",
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("reports a fixed error and never invokes a subprocess outside the interactive TUI", async () => {
      mockMacOS();
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "rpc", hasUI: true });

      await handler("login", ctx);

      expect(allNotifyMessages(ctx)).toEqual([
        "scryer: login requires the interactive macOS TUI; set the EXA_API_KEY environment variable instead",
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("removes the Keychain item and reports success when EXA_API_KEY is unset", async () => {
      mockMacOS();
      succeedWith("");
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("logout", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: removed from Keychain"]);
    });

    it("is idempotent when the Keychain item is already missing", async () => {
      mockMacOS();
      failWith("The specified item could not be found in the keychain.");
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("logout", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: removed from Keychain"]);
    });

    it("reports a fixed, sanitized error when deletion fails", async () => {
      mockMacOS();
      failWith(`permission denied: raw detail containing ${SECRET_KEY}`);
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("logout", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["scryer: failed to remove the Exa API key from Keychain"]);
    });

    it("reports fixed environment guidance and never invokes a subprocess on non-macOS", async () => {
      mockNonMacOS();
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("logout", ctx);

      expect(allNotifyMessages(ctx)).toEqual([
        "scryer: Keychain is only available on macOS; unset EXA_API_KEY to remove the environment fallback",
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("notifies that EXA_API_KEY still provides a fallback, leaving it untouched", async () => {
      mockMacOS();
      succeedWith("");
      process.env.EXA_API_KEY = "env-key";
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("logout", ctx);

      expect(allNotifyMessages(ctx)).toEqual([
        "scryer: removed from Keychain; EXA_API_KEY environment variable is still set and will be used",
      ]);
      expect(process.env.EXA_API_KEY).toBe("env-key");
    });
  });

  describe("unknown or extra arguments", () => {
    it("shows fixed usage and performs no subprocess for extra args to a known subcommand", async () => {
      mockMacOS();
      const { handler } = captureScryerHandler();
      const ctx = createCtx({ mode: "tui", hasUI: true });

      await handler("login exa", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["/scryer login|logout|status"]);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("shows fixed usage and performs no subprocess for an unrecognized subcommand", async () => {
      mockMacOS();
      const { handler } = captureScryerHandler();
      const ctx = createCtx();

      await handler("bogus", ctx);

      expect(allNotifyMessages(ctx)).toEqual(["/scryer login|logout|status"]);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("notification safety", () => {
    it("never includes the secret key or raw subprocess error text in any notification", async () => {
      mockMacOS();
      const observedMessages: string[] = [];

      // login store failure path
      execFileMock
        .mockImplementationOnce((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
          callback(null, `${SECRET_KEY}\n`, "");
        })
        .mockImplementationOnce((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
          const error = new Error("subprocess failed") as Error & { stdout?: string; stderr?: string };
          const stderr = `raw failure containing ${SECRET_KEY}`;
          error.stdout = "";
          error.stderr = stderr;
          callback(error, "", stderr);
        });
      const { handler: loginHandler } = captureScryerHandler();
      const loginCtx = createCtx({ mode: "tui", hasUI: true });
      await loginHandler("login", loginCtx);
      observedMessages.push(...allNotifyMessages(loginCtx));

      // logout deletion failure path
      failWith(`raw failure containing ${SECRET_KEY}`);
      const { handler: logoutHandler } = captureScryerHandler();
      const logoutCtx = createCtx();
      await logoutHandler("logout", logoutCtx);
      observedMessages.push(...allNotifyMessages(logoutCtx));

      for (const message of observedMessages) {
        expect(message).not.toContain(SECRET_KEY);
      }
    });
  });
});
