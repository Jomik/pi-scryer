import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContinuationCache } from "./continuation-cache";
import { registerScryerCommand } from "./credentials";
import { createExaKeyedRoute } from "./exa";
import { createExaMcpProvider } from "./exa-mcp";
import { createGitHubReader } from "./github";
import { createProviderRouter } from "./provider-routing";
import { createTavilyProvider } from "./tavily";
import { createWebReadTool } from "./web-read";
import { createWebSearchTool } from "./web-search";

export default function activate(api: ExtensionAPI): void {
  const cache = createContinuationCache();
  const githubReader = createGitHubReader();

  api.on("session_shutdown", async () => {
    await cache.cleanup().catch(() => {});
    await githubReader.cleanup().catch(() => {});
  });

  const exa = createExaMcpProvider();
  const tavily = createTavilyProvider();
  // Resolve credentials only when search runs; web_read keeps its legacy path.
  let routerPromise: Promise<ReturnType<typeof createProviderRouter>> | undefined;
  const getRouter = () =>
    (routerPromise ??= createExaKeyedRoute().then((keyed) => {
      if (keyed) exa.keyed = keyed;
      return createProviderRouter([exa, tavily]);
    }));

  api.registerTool(createWebReadTool(cache, githubReader));
  api.registerTool(createWebSearchTool(getRouter));

  registerScryerCommand(api);
}
