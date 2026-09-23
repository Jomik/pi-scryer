import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, vi } from "vitest";
import activate from "../src/index";

// Hoisted mock for node:child_process.execFile. Default behavior simulates a
// missing macOS Keychain item (as `security` reports it), so every existing
// tool test that relies on the EXA_API_KEY env fallback stays deterministic
// and never touches the real Keychain. Individual credential tests may
// override the implementation per-case; the top-level afterEach below
// restores this default so state never leaks between tests.
type ExecFileCallback = (
  error: (Error & { stdout?: string; stderr?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

function defaultExecFileImplementation(_file: string, _args: readonly string[], callback: ExecFileCallback): void {
  const error = new Error("item not found") as Error & { stdout?: string; stderr?: string };
  const stderr = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
  error.stdout = "";
  error.stderr = stderr;
  callback(error, "", stderr);
}

const execFileMockRef = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMockRef,
}));

export const execFileMock = execFileMockRef;

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
    signal: AbortSignal,
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
  execFileMock.mockImplementation(defaultExecFileImplementation);
});

execFileMock.mockImplementation(defaultExecFileImplementation);

export async function listCacheDirNames(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(CACHE_DIR_PREFIX));
}

export interface RegisteredCommand {
  name: string;
  description?: string;
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

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function noop(): void {}
