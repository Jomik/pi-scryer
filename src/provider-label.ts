import { truncateForDisplay } from "./exa";
import type { ProviderName } from "./provider-routing";

/** Keep provider attribution bounded and free of line breaks or terminal controls. */
export function providerLabel(name: ProviderName): string {
  const label = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || "Provider";
  return truncateForDisplay(label.charAt(0).toUpperCase() + label.slice(1), 80);
}
