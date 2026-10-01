import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import activate from "../src/index";
import { CREDENTIAL_PROVIDERS } from "../src/providers/credential-providers";
import { blockExternalBoundary, execFileMock } from "./setup";

export { execFileMock } from "./setup";

// Each isolated Vitest file owns its temporary root, so cache scans cannot
// observe directories created or removed by parallel workers. Assign directly
// so vi.unstubAllEnvs() cannot undo the harness's lifetime environment setting.
const originalTmpdirEnv = process.env.TMPDIR;
const testTmpdir = mkdtempSync(join(tmpdir(), "scryer-test-"));
process.env.TMPDIR = testTmpdir;

afterAll(async () => {
  try {
    await rm(testTmpdir, { recursive: true, force: true });
  } finally {
    if (originalTmpdirEnv === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdirEnv;
    }
  }
});

// The global setup blocks all subprocesses before source imports. This
// harness opts into only the registered providers' exact Keychain find
// shapes, simulating a missing item for integration env fallbacks. Tests
// invoking git/gh, writes, or prompts must install an explicit fixture.
type ExecFileCallback = (
  error: (Error & { stdout?: string; stderr?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

function defaultExecFileImplementation(file: string, args: readonly string[], callback: ExecFileCallback): void {
  if (
    file !== "security" ||
    !Array.isArray(args) ||
    (args.length !== 5 && args.length !== 6) ||
    args[0] !== "find-generic-password" ||
    args[1] !== "-s" ||
    args[2] !== "pi-scryer" ||
    args[3] !== "-a" ||
    !CREDENTIAL_PROVIDERS.some((provider) => provider.keychainAccount === args[4]) ||
    (args.length === 6 && args[5] !== "-w") ||
    typeof callback !== "function"
  ) {
    blockExternalBoundary("child_process.execFile");
  }
  const error = new Error("item not found") as Error & { stdout?: string; stderr?: string };
  const stderr = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
  error.stdout = "";
  error.stderr = stderr;
  callback(error, "", stderr);
}

export interface WebReadToolDetails {
  title?: string;
  source: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalLength: number;
}

export interface WebSearchToolDetails {
  resultCount: number;
  omitted: number;
  truncated: boolean;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: WebReadToolDetails | WebSearchToolDetails | undefined;
}

export interface RenderedText {
  render: (width: number) => string[];
}

export interface FakeTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export interface ToolCallRenderContext {
  expanded: boolean;
}

export interface ToolResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface ToolResultRenderContext {
  isError: boolean;
}

export function createIdentityTheme(): FakeTheme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
}

export const LARGE_RENDER_WIDTH = 10_000;

export function renderText(component: RenderedText, width: number = LARGE_RENDER_WIDTH): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

export interface ToolSchema {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

export interface RegisteredTool {
  name: string;
  parameters: ToolSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (...args: unknown[]) => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: FakeTheme, context: ToolCallRenderContext) => RenderedText;
  renderResult?: (
    result: ToolResult,
    options: ToolResultRenderOptions,
    theme: FakeTheme,
    context: ToolResultRenderContext,
  ) => RenderedText;
}

export const ORIGINAL_ENV = process.env.EXA_API_KEY;
export const SECRET_KEY = "secret-test-key";
export const CACHE_DIR_PREFIX = "pi-scryer-";

export type ShutdownHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

// Global registry of session_shutdown handlers captured from every activate()
// call in this file. A top-level afterEach drains and invokes them so no test
// leaves a private cache temp directory behind, regardless of which describe
// block or assertion path it took.
let capturedShutdownHandlers: ShutdownHandler[] = [];

afterEach(async () => {
  const handlers = capturedShutdownHandlers;
  capturedShutdownHandlers = [];
  for (const handler of handlers) {
    await handler({ type: "session_shutdown", reason: "quit" }, {});
  }
  execFileMock.mockReset();
});

beforeEach(() => {
  execFileMock.mockImplementation(defaultExecFileImplementation);
});

export async function listCacheDirNames(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(CACHE_DIR_PREFIX));
}

export interface RegisteredCommand {
  name: string;
  description?: string;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface Activation {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  /** Invokes every session_shutdown handler registered by this activation. */
  shutdown: () => Promise<void>;
}

export function activateExtension(): Activation {
  const registerTool = vi.fn<(tool: RegisteredTool) => void>();
  const registerCommand = vi.fn<(name: string, options: Omit<RegisteredCommand, "name">) => void>();
  const shutdownHandlers: ShutdownHandler[] = [];
  const on = vi.fn((event: string, handler: ShutdownHandler) => {
    if (event === "session_shutdown") {
      shutdownHandlers.push(handler);
    }
  });
  const api = { registerTool, registerCommand, on } as unknown as ExtensionAPI;
  activate(api);
  expect(registerTool).toHaveBeenCalledTimes(2);
  capturedShutdownHandlers.push(...shutdownHandlers);
  return {
    tools: registerTool.mock.calls.map((call) => call[0]),
    commands: registerCommand.mock.calls.map(([name, options]) => ({ name, ...options })),
    shutdown: async () => {
      for (const handler of shutdownHandlers) {
        await handler({ type: "session_shutdown", reason: "quit" }, {});
      }
    },
  };
}

export function getRegisteredTools(): RegisteredTool[] {
  return activateExtension().tools;
}

export function getRegisteredTool(name: string): RegisteredTool {
  const tool = getRegisteredTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return tool;
}

/** Like getRegisteredTool, but also exposes a way to invoke this activation's captured session_shutdown handler directly. */
export function getRegisteredToolWithShutdown(name: string): {
  tool: RegisteredTool;
  shutdown: () => Promise<void>;
} {
  const { tools, shutdown } = activateExtension();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return { tool, shutdown };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Exhaust anonymous read routes without adding their calls to keyed Exa fixture counts. */
export function stubKeyedExaFetch(fetchMock: typeof fetch): void {
  const wrappedFetch: typeof fetch = (input, init) => {
    const url = String(input);
    if (
      url === "https://mcp.exa.ai/mcp" ||
      (url.startsWith("https://api.tavily.com/") &&
        new Headers(init?.headers).get("X-Tavily-Access-Mode") === "keyless")
    ) {
      return Promise.resolve(jsonResponse({ error: "rate limited" }, 429));
    }
    return fetchMock(input, init);
  };
  vi.stubGlobal("fetch", wrappedFetch);
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function noop(): void {}
