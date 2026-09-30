import type { WebProvider } from "../provider-routing";
import { createExaKeyedRoute } from "./exa";
import { createExaMcpProvider } from "./exa-anon";
import { createTavilyProvider } from "./tavily";

export function createProviderRegistry(): () => Promise<WebProvider[]> {
  const exa = createExaMcpProvider();
  const tavily = createTavilyProvider();
  return async () => {
    const keyed = await createExaKeyedRoute();
    if (keyed) exa.keyed = keyed;
    return [exa, tavily];
  };
}
