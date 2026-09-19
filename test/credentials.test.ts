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
