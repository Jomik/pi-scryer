import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../src/index";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: undefined;
}

interface ToolSchema {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

interface RegisteredTool {
  name: string;
  parameters: ToolSchema;
  execute: (
    toolCallId: string,
    params: { url: string },
    signal: AbortSignal,
    onUpdate: (...args: unknown[]) => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

const ORIGINAL_ENV = process.env.EXA_API_KEY;
const SECRET_KEY = "secret-test-key";

function getRegisteredTool(): RegisteredTool {
  const registerTool = vi.fn<(tool: RegisteredTool) => void>();
  const api = { registerTool } as unknown as ExtensionAPI;
  activate(api);
  expect(registerTool).toHaveBeenCalledTimes(1);
  return registerTool.mock.calls[0][0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function noop(): void {}

describe("web_read extension", () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = SECRET_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers exactly one tool named web_read with a strict schema", () => {
    const tool = getRegisteredTool();

    expect(tool.name).toBe("web_read");
    expect(tool.parameters.required).toEqual(["url"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["url"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it.each([
    ["file:///tmp/x"],
    ["ftp://example.com"],
    ["relative"],
  ])("rejects invalid URL %s without calling fetch", async (url) => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { url }, new AbortController().signal, noop, {})).rejects.toThrow(
      "web_read: url must be an absolute http or https URL",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with missing key error without calling fetch", async () => {
    delete process.env.EXA_API_KEY;
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: missing EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns readable text on success and calls the Exa endpoint correctly", async () => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            title: "Example",
            url: "https://resolved.example/page",
            text: "Readable text",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.exa.ai/contents");
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeDefined();

    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET_KEY);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(init?.body as string) as unknown;
    expect(body).toEqual({ urls: ["https://example.com/page"], text: true });

    const text = result.content[0].text;
    expect(text).toContain("Example");
    expect(text).toContain("https://resolved.example/page");
    expect(text).toContain("Readable text");
    expect(text).not.toContain(SECRET_KEY);
    expect(result.details).toBeUndefined();
  });

  it.each([
    [401, "invalid API key"],
    [402, "quota exceeded"],
    [429, "rate limited"],
  ])("maps HTTP %d to expected error message", async (status, expected) => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: `secret leaked: ${SECRET_KEY}` }, status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow(expected);

    try {
      await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    } catch (err) {
      expect(String(err)).not.toContain(SECRET_KEY);
    }
  });

  it("reports malformed JSON responses", async () => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse("not json"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("malformed JSON");
  });

  it("reports status errors with only the status message, hiding the key", async () => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        statuses: [
          {
            status: "error",
            error: { tag: "CRAWL_TIMEOUT", message: SECRET_KEY },
          },
        ],
        results: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    } catch (err) {
      caught = err;
    }

    expect(String(caught)).toContain("Exa could not retrieve this URL");
    expect(String(caught)).not.toContain(SECRET_KEY);
  });

  it("reports when there are no results", async () => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("no content returned");
  });

  it("reports whitespace-only text", async () => {
    const tool = getRegisteredTool();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: "   \n\t  " }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("empty text");
  });

  it("propagates caller cancellation", async () => {
    const tool = getRegisteredTool();
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request cancelled");
    controller.abort();
    await assertion;
  });

  it("times out when the request takes too long", async () => {
    const tool = getRegisteredTool();
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request timed out");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutController.abort();
    await assertion;
  });

  it("propagates caller cancellation during JSON body parsing", async () => {
    const tool = getRegisteredTool();
    const controller = new AbortController();
    let resolveJsonStarted: () => void;
    const jsonStarted = new Promise<void>((resolve) => {
      resolveJsonStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = {
        ok: true,
        status: 200,
        json: () => {
          resolveJsonStarted();
          return new Promise<unknown>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      } as unknown as Response;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request cancelled");
    await jsonStarted;
    controller.abort();
    await assertion;
  });

  it("times out during JSON body parsing", async () => {
    const tool = getRegisteredTool();
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    let resolveJsonStarted: () => void;
    const jsonStarted = new Promise<void>((resolve) => {
      resolveJsonStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = {
        ok: true,
        status: 200,
        json: () => {
          resolveJsonStarted();
          return new Promise<unknown>((_resolve, reject) => {
            timeoutController.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      } as unknown as Response;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request timed out");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    await jsonStarted;
    timeoutController.abort();
    await assertion;
  });

  it("truncates oversized text with a source header and size note", async () => {
    const tool = getRegisteredTool();
    const longText = "x".repeat(DEFAULT_MAX_BYTES + 1000);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            title: "Example",
            url: "https://resolved.example/page",
            text: longText,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    const text = result.content[0].text;
    const sourceIndex = text.indexOf("https://resolved.example/page");
    const truncationIndex = text.indexOf("[Showing first");

    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeLessThan(200);
    expect(truncationIndex).toBeGreaterThanOrEqual(0);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(new TextEncoder().encode(longText).byteLength);
    expect(text).not.toContain(SECRET_KEY);
  });
});
