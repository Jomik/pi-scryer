import { truncateForDisplay } from "./exa";
import type { ProviderName } from "./provider-routing";

/** Keep provider attribution bounded and free of line breaks or terminal controls. */
export function providerLabel(name: ProviderName): string {
  const label = name === "exa" ? "Exa" : name === "tavily" ? "Tavily" : name;
  return truncateForDisplay(label.replace(/\p{Cc}/gu, " "), 80);
}
