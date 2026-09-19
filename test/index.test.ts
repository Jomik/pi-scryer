import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredTools, ORIGINAL_ENV, SECRET_KEY } from "./harness";

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
