export interface ProviderStream {
  name?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

export type ValidationStatus = "acceptable_cached" | "no_cached_result" | "unsuitable_results" | "provider_failure";

export interface ValidationResult {
  status: ValidationStatus;
  message: string;
}

export interface StreamProvider {
  validate(): Promise<ValidationResult>;
  streams(type: "movie" | "series", id: string): Promise<ProviderStream[]>;
  firstAcceptable(streams: ProviderStream[]): ProviderStream | null;
}

const validationMessages: Record<ValidationStatus, string> = {
  acceptable_cached: "The provider returned an acceptable cached 1080p Real-Debrid stream.",
  no_cached_result: "The provider returned no cached Real-Debrid stream for the validation title.",
  unsuitable_results: "The provider returned cached streams, but none were suitable 1080p results.",
  provider_failure: "The stream provider could not be validated. Check the endpoint and try again.",
};

function direct(stream: ProviderStream): boolean {
  if (typeof stream.url !== "string") return false;
  try {
    const protocol = new URL(stream.url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function cached(stream: ProviderStream): boolean {
  const label = `${stream.name ?? ""}\n${stream.title ?? ""}`;
  const torrentioCached = /(?:^|[^a-z0-9])RD\+(?=$|[^a-z0-9])/i.test(label) && !/download/i.test(label);
  const cometCached = /^\[RD⚡\]\s+Comet\b/i.test(stream.name ?? "");
  return direct(stream) && (torrentioCached || cometCached);
}

function suitable(stream: ProviderStream): boolean {
  return cached(stream) && /\b1080p?\b/i.test(`${stream.name ?? ""}\n${stream.title ?? ""}`);
}

export function firstAcceptableCachedStream(streams: ProviderStream[]): ProviderStream | null {
  return streams.find(suitable) ?? null;
}

export function parseProviderManifestUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.pathname.endsWith("/manifest.json")) return null;
    return url;
  } catch {
    return null;
  }
}

export class StremioAddonProvider implements StreamProvider {
  constructor(private readonly manifestUrl: URL, private readonly request?: typeof fetch) {}

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.request ? this.request.call(globalThis, input, init) : fetch(input, init);
  }

  private streamUrl(type: "movie" | "series", id: string): URL {
    const url = new URL(this.manifestUrl);
    url.pathname = `${url.pathname.slice(0, -"manifest.json".length)}stream/${type}/${encodeURIComponent(id)}.json`;
    return url;
  }

  async streams(type: "movie" | "series", id: string): Promise<ProviderStream[]> {
    const response = await this.fetch(this.streamUrl(type, id), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("provider request failed");
    const body = await response.json() as { streams?: unknown };
    if (!Array.isArray(body.streams)) throw new Error("provider response invalid");
    return body.streams.filter((stream): stream is ProviderStream => typeof stream === "object" && stream !== null);
  }

  firstAcceptable(streams: ProviderStream[]): ProviderStream | null {
    return firstAcceptableCachedStream(streams);
  }

  async validate(): Promise<ValidationResult> {
    try {
      const manifestResponse = await this.fetch(this.manifestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!manifestResponse.ok) throw new Error("manifest request failed");
      const manifest = await manifestResponse.json() as { id?: unknown; resources?: unknown };
      if (typeof manifest.id !== "string" || !Array.isArray(manifest.resources)) throw new Error("manifest response invalid");

      const streams = await this.streams("movie", "tt0111161");
      if (this.firstAcceptable(streams)) return { status: "acceptable_cached", message: validationMessages.acceptable_cached };
      if (streams.some(cached)) return { status: "unsuitable_results", message: validationMessages.unsuitable_results };
      return { status: "no_cached_result", message: validationMessages.no_cached_result };
    } catch {
      return { status: "provider_failure", message: validationMessages.provider_failure };
    }
  }
}
