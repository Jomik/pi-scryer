import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateExtension, execFileMock, jsonResponse, noop, ORIGINAL_ENV, SECRET_KEY } from "./harness";

// Evaluate the harness before importing credentials; setup also installs the
// fail-closed subprocess mock before either module is loaded.
const credentials = await import("../src/credentials");
const registry = await import("../src/providers/registry");

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
    const { tools } = activateExtension();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["web_read", "web_search"]);
  });

  it("shares one lazy router load across hosted search and read", async () => {
    const resolveKey = vi.spyOn(credentials, "resolveProviderApiKey").mockImplementation(async (name) => {
      if (name !== "exa" && name !== "tavily") throw new Error(`Unexpected credential provider: ${name}`);
      return undefined;
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const { params } = JSON.parse(init?.body as string);
        const text =
          params.name === "web_search_exa"
            ? "Title: Page\nURL: https://example.com/\nHighlights:\nSnippet"
            : "# Page\nURL: https://example.com/\n\nPage content";
        return jsonResponse({ result: { content: [{ type: "text", text }] } });
      }),
    );
    const { tools } = activateExtension();
    expect(resolveKey).not.toHaveBeenCalled();
    const search = tools.find((tool) => tool.name === "web_search");
    const read = tools.find((tool) => tool.name === "web_read");

    await Promise.all([
      search?.execute("search", { query: "example" }, undefined, noop, {}),
      read?.execute("read", { url: "https://example.com/" }, undefined, noop, {}),
    ]);
    expect(resolveKey.mock.calls).toEqual([["exa"], ["tavily"]]);
  });

  it("keeps status before first use lazy and checks only Keychain presence", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const resolveKey = vi.spyOn(credentials, "resolveProviderApiKey").mockResolvedValue(undefined);
    const createRegistry = registry.createProviderRegistry;
    const load = vi.fn(createRegistry());
    vi.spyOn(registry, "createProviderRegistry").mockReturnValue(load);
    const fetchMock = vi.fn<typeof fetch>(() => {
      throw new Error("Unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { commands, tools } = activateExtension();
    const ctx = { ui: { notify: vi.fn() } };
    expect(commands[0].handler.length).toBe(2);
    await commands[0].handler("status", ctx);
    expect(ctx.ui.notify.mock.calls.map(([message]) => message)).toEqual([
      "scryer: Exa API key source: environment (EXA_API_KEY)",
      expect.stringMatching(/^scryer: Tavily API key source: /),
      "scryer: runtime not initialized",
    ]);
    expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "exa-api-key"]],
      ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "tavily-api-key"]],
    ]);
    expect(load).not.toHaveBeenCalled();
    expect(resolveKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      tools.map((tool) => [tool.name, Object.keys(tool.parameters.properties), tool.parameters.additionalProperties]),
    ).toEqual([
      ["web_read", ["url", "offset"], false],
      ["web_search", ["query"], false],
    ]);
  });

  it("does not await a pending load or start another load when status peeks", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const resolveKey = vi.spyOn(credentials, "resolveProviderApiKey").mockResolvedValue(undefined);
    let release!: (providers: []) => void;
    const pending = new Promise<[]>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(() => pending);
    vi.spyOn(registry, "createProviderRegistry").mockReturnValue(load);
    const { commands, tools } = activateExtension();
    const ctx = { ui: { notify: vi.fn() } };
    const request = tools
      .find((tool) => tool.name === "web_search")
      ?.execute("search", { query: "private query" }, undefined, noop, {});
    const rejected = expect(request).rejects.toThrow("no eligible routes");
    expect(load).toHaveBeenCalledTimes(1);
    try {
      await commands[0].handler("status", ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["scryer: runtime not initialized", "info"]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(resolveKey).not.toHaveBeenCalled();
    } finally {
      release([]);
      await rejected;
    }
    ctx.ui.notify.mockClear();
    await commands[0].handler("status", ctx);
    expect(ctx.ui.notify.mock.calls.slice(2)).toEqual([
      ["scryer: Exa (keyed): not configured", "info"],
      ["scryer: Tavily (keyed): not configured", "info"],
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports independent runtime ages and cooldowns after mocked hosted requests without further I/O", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const resolveKey = vi.spyOn(credentials, "resolveProviderApiKey").mockResolvedValue(undefined);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "https://mcp.exa.ai/mcp") {
        return new Response("private error", { status: 429, headers: { "retry-after": "10.001" } });
      }
      if (String(input) === "https://api.tavily.com/search") {
        return jsonResponse({ results: [{ url: "https://example.com/private", content: "private snippet" }] });
      }
      throw new Error("Unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { commands, tools } = activateExtension();
    const search = tools.find((tool) => tool.name === "web_search");
    await search?.execute("search", { query: "private query" }, undefined, noop, {});
    const ctx = { ui: { notify: vi.fn() } };
    vi.mocked(Date.now).mockReturnValue(102_500);
    await commands[0].handler("status", ctx);
    expect(ctx.ui.notify.mock.calls.slice(2)).toEqual([
      ["scryer: Exa-anon (anonymous): cooling down · retry in 8s · last attempt: 2s ago · last success: never", "info"],
      ["scryer: Tavily-anon (anonymous): eligible · last attempt: 2s ago · last success: 2s ago", "info"],
      ["scryer: Exa (keyed): not configured", "info"],
      ["scryer: Tavily (keyed): not configured", "info"],
    ]);
    vi.mocked(Date.now).mockReturnValue(110_001);
    ctx.ui.notify.mockClear();
    await commands[0].handler("status", ctx);
    expect(ctx.ui.notify.mock.calls[2]).toEqual([
      "scryer: Exa-anon (anonymous): eligible · last attempt: 10s ago · last success: never",
      "info",
    ]);
    expect(resolveKey.mock.calls).toEqual([["exa"], ["tavily"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toMatch(/private|https:\/\//);
  });

  it("registers exactly one scryer command", () => {
    const { commands } = activateExtension();
    expect(commands.map((command) => command.name)).toEqual(["scryer"]);
    expect(commands[0].description).toBe(
      "Manage provider API keys used by pi-scryer (status, login <provider>, logout <provider>)",
    );
  });
  describe("registered argument completions", () => {
    it.each([
      ["", ["login", "logout", "status"]],
      ["lo", ["login", "logout"]],
      ["sta", ["status"]],
      ["login ", ["login exa", "login tavily"]],
      ["logout ", ["logout exa", "logout tavily"]],
      ["login ta", ["login tavily"]],
      ["logout ex", ["logout exa"]],
    ] as const)("completes %j using full argument values", (prefix, values) => {
      const command = activateExtension().commands[0];
      expect(command.getArgumentCompletions?.(prefix)).toEqual(values.map((value) => ({ value, label: value })));
    });

    it.each([
      "bogus",
      "status ",
      "status exa",
      "login unknown",
      "login exa-anon",
      "logout tavily-anon",
      "login exa secret",
      "logout tavily secret",
      "login exa ",
      "login  ",
      "login ta extra",
    ])("returns null for invalid or extra prefix %j", (prefix) => {
      const command = activateExtension().commands[0];
      expect(command.getArgumentCompletions?.(prefix)).toBeNull();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
