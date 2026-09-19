import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContinuationCache } from "./continuation-cache";
import { createWebReadTool } from "./web-read";
import { webSearchTool } from "./web-search";

export default function activate(api: ExtensionAPI): void {
  const cache = createContinuationCache();

  api.on("session_shutdown", async () => {
    await cache.cleanup().catch(() => {});
  });

  api.registerTool(createWebReadTool(cache));
  api.registerTool(webSearchTool);
}
