export interface SearchHit {
  title?: string;
  url: string;
  snippet?: string;
}

export interface ReadPage {
  title?: string;
  url: string;
  text: string;
}

export type ProviderName = string;
export type AccessMode = "keyed" | "anonymous";
export type ProviderFailureKind = "quota" | "invalid-credentials" | "rate-limit" | "transient";

/** Retry-after is a delay in milliseconds, not an absolute timestamp. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(kind);
    this.name = "ProviderError";
  }
}

export interface ProviderRoute {
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
  read(url: string, signal?: AbortSignal): Promise<ReadPage>;
}

export interface WebProvider {
  name: ProviderName;
  keyed?: ProviderRoute;
  anonymous?: ProviderRoute;
}

export interface RoutedResult<T> {
  value: T;
  provider: ProviderName;
  mode: AccessMode;
}

interface RouteState {
  provider: ProviderName;
  mode: AccessMode;
  route: ProviderRoute;
  disabled?: "quota" | "invalid-credentials";
  retryAt: number;
}

export const SEARCH_URL_MAX_CHARS = 2048;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/** Parses Exa Retry-After seconds or HTTP dates without Date.parse's informal date coercions. */
export function retryAfterMs(header: string | null, allowFractionalSeconds = false): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if ((allowFractionalSeconds ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  if (
    !/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  }
}

function eligible(route: RouteState): boolean {
  return !route.disabled && Date.now() >= route.retryAt;
}

/** Holds route availability in memory for the lifetime of this router. */
export function createProviderRouter(providers: WebProvider[]) {
  const routes = providers.flatMap((provider): RouteState[] => {
    if (typeof provider.name !== "string" || !provider.name.trim()) {
      throw new Error("Web provider name must be a nonempty string");
    }
    const name = provider.name.trim();
    return [
      ...(provider.anonymous
        ? [{ provider: name, mode: "anonymous" as const, route: provider.anonymous, retryAt: 0 }]
        : []),
      ...(provider.keyed ? [{ provider: name, mode: "keyed" as const, route: provider.keyed, retryAt: 0 }] : []),
    ];
  });

  async function run<T>(
    operation: (route: ProviderRoute) => Promise<T>,
    signal: AbortSignal | undefined,
    isEmpty: (value: T) => boolean,
  ): Promise<RoutedResult<T>> {
    abortIfRequested(signal);
    const anonymous = routes.filter((state) => state.mode === "anonymous" && eligible(state));
    const keyed = routes.filter((state) => state.mode === "keyed" && eligible(state));
    if (anonymous.length + keyed.length === 0) {
      throw new Error("Web providers unavailable: no eligible routes");
    }
    const chooseFirst = (available: RouteState[]) => {
      if (available.length === 0) return available;
      const first = Math.floor(Math.random() * available.length);
      return [available[first], ...available.filter((_, index) => index !== first)];
    };
    const failures: string[] = [];
    let empty: RoutedResult<T> | undefined;

    for (const tier of [anonymous, keyed]) {
      for (const state of chooseFirst(tier)) {
        abortIfRequested(signal);
        if (!eligible(state)) {
          continue;
        }
        try {
          const value = await operation(state.route);
          abortIfRequested(signal);
          const result = { value, provider: state.provider, mode: state.mode };
          if (!isEmpty(value)) {
            return result;
          }
          empty ??= result;
        } catch (error) {
          abortIfRequested(signal);
          if (error instanceof ProviderError) {
            if (error.kind === "quota" || error.kind === "invalid-credentials") {
              state.disabled = error.kind;
            } else if (error.kind === "rate-limit") {
              const delay = error.retryAfterMs;
              state.retryAt =
                Date.now() +
                (delay !== undefined && Number.isFinite(delay) && delay > 0 ? delay : RATE_LIMIT_COOLDOWN_MS);
            }
          }
          // Never include provider-supplied messages, response bodies, or URLs.
          const reason = error instanceof ProviderError ? error.kind : "unexpected failure";
          failures.push(`${state.provider}/${state.mode}: ${reason}`);
        }
      }
    }
    if (empty) {
      return empty;
    }
    throw new Error(`Web providers unavailable: ${failures.join("; ") || "no eligible routes"}`);
  }

  return {
    search(query: string, signal?: AbortSignal): Promise<RoutedResult<SearchHit[]>> {
      return run(
        async (route) => {
          const hits = await route.search(query, signal);
          if (
            hits.length > 0 &&
            !hits.some((hit) => {
              if (typeof hit?.url !== "string") return false;
              const trimmedUrl = hit.url.trim();
              if (trimmedUrl.length > SEARCH_URL_MAX_CHARS) return false;
              try {
                const url = new URL(trimmedUrl);
                return url.protocol === "http:" || url.protocol === "https:";
              } catch {
                return false;
              }
            })
          ) {
            throw new ProviderError("transient");
          }
          return hits;
        },
        signal,
        (hits) => hits.length === 0,
      );
    },
    read(url: string, signal?: AbortSignal): Promise<RoutedResult<ReadPage>> {
      return run(
        async (route) => {
          const page = await route.read(url, signal);
          if (
            !page ||
            typeof page.text !== "string" ||
            !page.text.trim() ||
            typeof page.url !== "string" ||
            !page.url.trim() ||
            page.url.trim().length > SEARCH_URL_MAX_CHARS ||
            (page.title !== undefined && typeof page.title !== "string")
          ) {
            throw new ProviderError("transient");
          }
          try {
            const resolved = new URL(page.url.trim());
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
              throw new ProviderError("transient");
            }
          } catch {
            throw new ProviderError("transient");
          }
          return page;
        },
        signal,
        () => false,
      );
    },
  };
}
