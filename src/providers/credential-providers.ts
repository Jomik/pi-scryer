export interface CredentialProvider {
  readonly name: string;
  readonly envVariable: string;
  readonly keychainAccount: string;
}

const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  { name: "exa", envVariable: "EXA_API_KEY", keychainAccount: "exa-api-key" },
  { name: "tavily", envVariable: "TAVILY_API_KEY", keychainAccount: "tavily-api-key" },
];

/** Only registered keyed providers have credentials; anonymous and unknown names are rejected. */
export function getCredentialProvider(name: string): CredentialProvider {
  const provider = CREDENTIAL_PROVIDERS.find((provider) => provider.name === name);
  if (!provider) {
    throw new Error("credentials: unsupported keyed provider");
  }
  return provider;
}
