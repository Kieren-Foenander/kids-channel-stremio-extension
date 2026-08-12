export class ParentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ParentApiError";
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  notifyOnUnauthorized?: boolean;
};

export async function parentApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  const { notifyOnUnauthorized = true, ...requestInit } = options;
  const response = await fetch(path, {
    ...requestInit,
    body,
    headers,
    cache: options.cache ?? "no-store",
    credentials: "same-origin",
  });

  const result = await readJson(response);
  if (!response.ok) {
    const message = errorMessage(result) ?? `Request failed (${response.status}).`;
    if (notifyOnUnauthorized && response.status === 401 && message === "Parent authentication is required.") {
      window.dispatchEvent(new Event("parent-session-expired"));
    }
    throw new ParentApiError(message, response.status);
  }

  return result as T;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  return typeof value.error === "string" && value.error.trim() ? value.error : undefined;
}

export function apiErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof ParentApiError) || error.message.startsWith("Request failed (")) return fallback;
  return error.message;
}

/** Channel-scoped keys nest under a per-type prefix so a change that affects every Channel
 * can invalidate them all without knowing which Channels are currently loaded. */
export const parentKeys = {
  household: (secret: string) => ["household", secret] as const,
  session: (secret: string) => ["household", secret, "session"] as const,
  overview: (secret: string) => ["household", secret, "overview"] as const,
  library: (secret: string) => ["household", secret, "approved-library"] as const,
  libraryProgramme: (secret: string, programmeId?: string) =>
    ["household", secret, "approved-library", "programme", programmeId] as const,
  search: (secret: string, query?: string) => ["household", secret, "cinemeta-search", query] as const,
  title: (secret: string, type: string, imdbId: string) =>
    ["household", secret, "cinemeta-title", type, imdbId] as const,
  channels: (secret: string) => ["household", secret, "channels"] as const,
  channel: (secret: string, channelId: string) => ["household", secret, "channel", channelId] as const,
  tvChannels: (secret: string) => ["household", secret, "tv-channel"] as const,
  tv: (secret: string, channelId?: string) => ["household", secret, "tv-channel", channelId ?? "default"] as const,
  tvPreparations: (secret: string) => ["household", secret, "tv-preparation"] as const,
  tvPreparation: (secret: string, channelId?: string) => ["household", secret, "tv-preparation", channelId ?? "default"] as const,
  movieChannels: (secret: string) => ["household", secret, "movie-channel"] as const,
  movie: (secret: string, channelId?: string) => ["household", secret, "movie-channel", channelId ?? "default"] as const,
  torBox: (secret: string) => ["household", secret, "torbox"] as const,
};
