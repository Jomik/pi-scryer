import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContinuationCache } from "./continuation-cache";
import { registerScryerCommand } from "./credentials";
import { createGitHubReader } from "./github";
import { createWebReadTool } from "./web-read";
import { webSearchTool } from "./web-search";

export default function activate(api: ExtensionAPI): void {
  const cache = createContinuationCache();
  const githubReader = createGitHubReader();

  api.on("session_shutdown", async () => {
    await cache.cleanup().catch(() => {});
    await githubReader.cleanup().catch(() => {});
  });

  api.registerTool(createWebReadTool(cache, githubReader));
  api.registerTool(webSearchTool);

  registerScryerCommand(api);
}
