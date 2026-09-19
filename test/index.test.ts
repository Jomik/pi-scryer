import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateExtension, ORIGINAL_ENV, SECRET_KEY } from "./harness";

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

  it("registers exactly one scryer command", () => {
    const { commands } = activateExtension();
    expect(commands.map((command) => command.name)).toEqual(["scryer"]);
    expect(commands[0].description).toBe("Manage the Exa API key used by pi-scryer (status, login, logout)");
  });
});
