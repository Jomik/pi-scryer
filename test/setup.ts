import { afterAll, afterEach, beforeEach, type Mock, vi } from "vitest";

// Hoisted before any source imports. Never import/spread the actual OS module.
// Vitest isolates this state per file; only boundary names, never argv or URLs,
// are retained. Deliberate guard tests must assert and consume their attempts.
const boundaries = vi.hoisted(() => {
  const attempts: string[] = [];
  function block(boundary: string): never {
    attempts.push(boundary);
    throw new Error(`Unexpected external boundary: ${boundary}`);
  }

  // Keep vi.fn's broad fixture signature (credentials use three arguments,
  // GitHub uses four). Vitest 4 resets vi.fn(impl) to impl, not to undefined.
  const execFile = vi.fn(() => block("child_process.execFile")) as Mock;
  const childProcess = {
    execFile,
    exec: () => block("child_process.exec"),
    spawn: () => block("child_process.spawn"),
    fork: () => block("child_process.fork"),
    execFileSync: () => block("child_process.execFileSync"),
    execSync: () => block("child_process.execSync"),
    spawnSync: () => block("child_process.spawnSync"),
  };
  const module = { ...childProcess, default: childProcess };
  const fetch: typeof globalThis.fetch = async () => block("fetch");
  return { attempts, block, execFile, module, fetch };
});

vi.mock("node:child_process", () => boundaries.module);
vi.mock("child_process", () => boundaries.module);

export const execFileMock = boundaries.execFile;
export const blockExternalBoundary = boundaries.block;

/** Consume only in tests deliberately exercising a guard; assert the result. */
export function consumeBoundaryAttempts(): string[] {
  return boundaries.attempts.splice(0);
}

export function assertNoUnexpectedBoundaryAttempts(): void {
  const attempts = consumeBoundaryAttempts();
  if (attempts.length > 0) {
    throw new Error(`Unexpected external boundaries (${attempts.length}): ${attempts.join(", ")}`);
  }
}

// Permanent safe baseline, NOT vi.stubGlobal or a spy on the real fetch.
// unstub/restore can only restore this guard, never the original network API.
// Explicit per-test vi.stubGlobal("fetch", fixture) remains supported.
globalThis.fetch = boundaries.fetch;

function resetBoundaries(): void {
  vi.unstubAllGlobals();
  globalThis.fetch = boundaries.fetch;
  execFileMock.mockReset();
}

beforeEach(() => {
  resetBoundaries();
  // Do not clear attempts here: module-initialization attempts must also fail.
});

afterEach(() => {
  resetBoundaries();
  assertNoUnexpectedBoundaryAttempts();
});

// Stack ordering runs this setup hook last, after file/harness teardown.
afterAll(() => {
  resetBoundaries();
  assertNoUnexpectedBoundaryAttempts();
});
