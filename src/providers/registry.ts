import type { WebProvider } from "../provider-routing";
import { createExaProvider } from "./exa";
import { createExaAnonProvider } from "./exa-anon";
import { createTavilyProviders } from "./tavily";

export function createProviderRegistry(): () => Promise<WebProvider[]> {
  const exaAnon = createExaAnonProvider();
  return async () => {
    const [exa, tavily] = await Promise.all([createExaProvider(), createTavilyProviders()]);
    return [...(exa ? [exa] : []), exaAnon, ...tavily];
  };
}
