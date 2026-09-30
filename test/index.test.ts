import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../src/credentials";
import { activateExtension, jsonResponse, noop, ORIGINAL_ENV, SECRET_KEY } from "./harness";

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
    const resolveKey = vi.spyOn(credentials, "resolveExaApiKey").mockResolvedValue(undefined);
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
    expect(resolveKey).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one scryer command", () => {
    const { commands } = activateExtension();
    expect(commands.map((command) => command.name)).toEqual(["scryer"]);
    expect(commands[0].description).toBe("Manage the Exa API key used by pi-scryer (status, login, logout)");
  });
});
