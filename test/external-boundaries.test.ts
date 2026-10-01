import childProcess, * as nodeChildProcess from "node:child_process";
// biome-ignore lint/style/useNodejsImportProtocol: Test the bare alias also receives the fail-closed subprocess mock.
import aliasDefault, * as aliasChildProcess from "child_process";
import { afterEach, expect, it, vi } from "vitest";
import { promptForApiKey, resolveProviderApiKey } from "../src/credentials";
import { assertNoUnexpectedBoundaryAttempts, consumeBoundaryAttempts, execFileMock } from "./setup";

// No harness or per-file subprocess mock: these source imports must already
// be protected by setupFiles, including on a macOS test host.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const methods = ["execFile", "exec", "spawn", "fork", "execFileSync", "execSync", "spawnSync"] as const;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function fixtureKey(_file: string, _args: readonly string[], callback: ExecFileCallback): void {
  callback(null, "fixture-key\n", "");
}

it("blocks subprocess methods on both aliases and default exports", () => {
  for (const module of [nodeChildProcess, aliasChildProcess, childProcess, aliasDefault]) {
    for (const method of methods) {
      const invoke = module[method] as (...args: unknown[]) => unknown;
      expect(() => invoke("security", ["test-only-argument"])).toThrow(
        `Unexpected external boundary: child_process.${method}`,
      );
      expect(consumeBoundaryAttempts()).toEqual([`child_process.${method}`]);
    }
  }
});

it("blocks security and osascript even when credential code catches the error", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.stubEnv("EXA_API_KEY", "fixture-env-key");

  await expect(promptForApiKey("test-only-prompt")).rejects.toThrow("credentials: failed to read input");
  expect(consumeBoundaryAttempts()).toEqual(["child_process.execFile"]);

  await expect(resolveProviderApiKey("exa")).resolves.toBe("fixture-env-key");
  // The resolver swallowed the subprocess error; teardown must still fail
  // unless this deliberate blocked-call test asserts/consumes the attempt.
  expect(() => assertNoUnexpectedBoundaryAttempts()).toThrow(
    "Unexpected external boundaries (1): child_process.execFile",
  );
  expect(consumeBoundaryAttempts()).toEqual([]);
});

it("allows explicit source fixtures, then resets execFile to the denying baseline", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  execFileMock.mockImplementationOnce(fixtureKey);
  await expect(promptForApiKey("test-only-prompt")).resolves.toBe("fixture-key");
  execFileMock.mockImplementationOnce(fixtureKey);
  await expect(resolveProviderApiKey("exa")).resolves.toBe("fixture-key");
  expect(consumeBoundaryAttempts()).toEqual([]);

  execFileMock.mockReset();
  expect(() => nodeChildProcess.execFile("osascript", [])).toThrow(
    "Unexpected external boundary: child_process.execFile",
  );
  expect(consumeBoundaryAttempts()).toEqual(["child_process.execFile"]);

  vi.resetAllMocks();
  execFileMock.mockRestore();
  vi.restoreAllMocks();
  expect(() => aliasChildProcess.execFile("security", [])).toThrow(
    "Unexpected external boundary: child_process.execFile",
  );
  expect(consumeBoundaryAttempts()).toEqual(["child_process.execFile"]);
});

it("blocks fetch before and after explicit stubs, spies, and reset/restore", async () => {
  async function expectBlockedFetch(): Promise<void> {
    await expect(fetch("https://test.invalid/")).rejects.toThrow("Unexpected external boundary: fetch");
    expect(consumeBoundaryAttempts()).toEqual(["fetch"]);
  }

  await expectBlockedFetch();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response("fixture")),
  );
  expect(await (await fetch("https://test.invalid/")).text()).toBe("fixture");
  vi.unstubAllGlobals();
  await expectBlockedFetch();

  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fixture"));
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await expectBlockedFetch();
});
