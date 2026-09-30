import type { WebProvider } from "../provider-routing";
import { createExaProvider } from "./exa";
import { createExaAnonProvider } from "./exa-anon";
import { createTavilyProviders } from "./tavily";

export function createProviderRegistry(): () => Promise<WebProvider[]> {
  const exaAnon = createExaAnonProvider();
  const tavily = createTavilyProviders();
  return async () => {
    const exa = await createExaProvider();
    return [...(exa ? [exa] : []), exaAnon, ...tavily];
  };
}
