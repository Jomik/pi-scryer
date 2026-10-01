import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContinuationCache } from "./continuation-cache";
import { registerScryerCommand } from "./credentials";
import { createGitHubReader } from "./github";
import { createProviderRouter } from "./provider-routing";
import { createProviderRegistry } from "./providers/registry";
import { createWebReadTool } from "./web-read";
import { createWebSearchTool } from "./web-search";

export default function activate(api: ExtensionAPI): void {
  const cache = createContinuationCache();
  const githubReader = createGitHubReader();

  api.on("session_shutdown", async () => {
    await cache.cleanup().catch(() => {});
    await githubReader.cleanup().catch(() => {});
  });

  const loadProviders = createProviderRegistry();
  // Resolve credentials only when a hosted search or read runs.
  let routerPromise: Promise<ReturnType<typeof createProviderRouter>> | undefined;
  let resolvedRouter: ReturnType<typeof createProviderRouter> | undefined;
  const getRouter = () =>
    (routerPromise ??= loadProviders().then((providers) => {
      resolvedRouter = createProviderRouter(providers);
      return resolvedRouter;
    }));

  api.registerTool(createWebReadTool(cache, githubReader, getRouter));
  api.registerTool(createWebSearchTool(getRouter));

  registerScryerCommand(api, () => resolvedRouter?.getStatus());
}
