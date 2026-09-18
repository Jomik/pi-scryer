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
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (...args: unknown[]) => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

const ORIGINAL_ENV = process.env.EXA_API_KEY;
const SECRET_KEY = "secret-test-key";

function getRegisteredTools(): RegisteredTool[] {
  const registerTool = vi.fn<(tool: RegisteredTool) => void>();
  const api = { registerTool } as unknown as ExtensionAPI;
  activate(api);
  expect(registerTool).toHaveBeenCalledTimes(2);
  return registerTool.mock.calls.map((call) => call[0]);
}

function getRegisteredTool(name: string): RegisteredTool {
  const tool = getRegisteredTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return tool;
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

describe("extension registration", () => {
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

  it("registers exactly web_read and web_search", () => {
    const tools = getRegisteredTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["web_read", "web_search"]);
  });
});

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

  it("registers a strict schema for web_read", () => {
    const tool = getRegisteredTool("web_read");

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
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { url }, new AbortController().signal, noop, {})).rejects.toThrow(
      "web_read: url must be an absolute http or https URL",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with missing key error without calling fetch", async () => {
    delete process.env.EXA_API_KEY;
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: missing EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns readable text on success and calls the Exa endpoint correctly", async () => {
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse("not json"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("malformed JSON");
  });

  it("reports status errors with only the status message, hiding the key", async () => {
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("no content returned");
  });

  it("reports whitespace-only text", async () => {
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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
    const tool = getRegisteredTool("web_read");
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

describe("web_search extension", () => {
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

  it("registers a strict schema for web_search", () => {
    const tool = getRegisteredTool("web_search");

    expect(tool.name).toBe("web_search");
    expect(tool.parameters.required).toEqual(["query"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["query"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it.each([["   "], [""]])("rejects whitespace query %j without calling fetch", async (query) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query }, new AbortController().signal, noop, {})).rejects.toThrow(
      "web_search: query must not be empty",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with missing key error without calling fetch", async () => {
    delete process.env.EXA_API_KEY;
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { query: "pi coding agent" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_search: missing EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the Exa search endpoint with the exact expected request", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: "Some excerpt" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool.execute("call-1", { query: "  pi coding agent  " }, new AbortController().signal, noop, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeDefined();

    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET_KEY);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(init?.body as string) as unknown;
    expect(body).toEqual({
      query: "pi coding agent",
      numResults: 5,
      contents: { text: { maxCharacters: 500 } },
    });
  });

  it("returns Markdown with title, source, and excerpt", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example Title", url: "https://resolved.example/page", text: "Example excerpt" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("Example Title");
    expect(text).toContain("Source: https://resolved.example/page");
    expect(text).toContain("Example excerpt");
    expect(text).not.toContain(SECRET_KEY);
    expect(result.details).toBeUndefined();
  });

  it("caps output at five results even if the provider returns more", async () => {
    const tool = getRegisteredTool("web_search");
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`https://example.com/${i}`);
    }
    for (let i = 5; i < 8; i++) {
      expect(text).not.toContain(`https://example.com/${i}`);
    }
  });

  it("reports a clear message when there are no results", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    expect(result.content[0].text).toBe("No search results found.");
  });

  it.each([
    [{ notResults: [] }],
    [{ results: "not-an-array" }],
    ["not-a-record"],
  ])("rejects malformed top-level responses %j", async (body) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {})).rejects.toThrow(
      "malformed response from search provider",
    );
  });

  it("rejects when every result entry is invalid", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "No URL" }, { url: "not-a-url" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {})).rejects.toThrow(
      "malformed results from search provider",
    );
  });

  it("omits malformed entries and reports how many were omitted", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Valid", url: "https://example.com/valid" }, { title: "No URL" }, { url: "not-a-url" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("https://example.com/valid");
    expect(text).toContain("2 results omitted");
  });

  it("bounds titles and excerpts locally to their expected limits", async () => {
    const tool = getRegisteredTool("web_search");
    const longTitle = "T".repeat(300);
    const longExcerpt = "E".repeat(700);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: longTitle, url: "https://example.com/page", text: longExcerpt }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("T".repeat(200));
    expect(text).not.toContain("T".repeat(201));
    expect(text).toContain("E".repeat(500));
    expect(text).not.toContain("E".repeat(501));
  });

  it("falls back to a truncated URL as title when title is missing, and rejects URLs over 2048 chars", async () => {
    const tool = getRegisteredTool("web_search");
    const longUrl = `https://example.com/${"a".repeat(300)}`;
    const overlongUrl = `https://example.com/${"a".repeat(2048)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ url: longUrl }, { title: "Too Long", url: overlongUrl }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;
    const truncatedTitle = longUrl.slice(0, 200);

    expect(text.split("\n")[0]).toBe(`1. ${truncatedTitle}`);
    expect(text).toContain(`Source: ${longUrl}`);
    expect(text).not.toContain(overlongUrl);
    expect(text).toContain("1 result omitted");
  });

  it.each([
    [401, "invalid API key"],
    [402, "quota exceeded"],
    [429, "rate limited"],
  ])("maps HTTP %d to expected error message without leaking the key", async (status, expected) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: `secret leaked: ${SECRET_KEY}` }, status));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    } catch (err) {
      caught = err;
    }

    expect(String(caught)).toContain(expected);
    expect(String(caught)).not.toContain(SECRET_KEY);
  });

  it("propagates caller cancellation", async () => {
    const tool = getRegisteredTool("web_search");
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

    const promise = tool.execute("call-1", { query: "example" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_search: request cancelled");
    controller.abort();
    await assertion;
  });

  it("times out after 30 seconds", async () => {
    const tool = getRegisteredTool("web_search");
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

    const promise = tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_search: request timed out");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutController.abort();
    await assertion;
  });
});
