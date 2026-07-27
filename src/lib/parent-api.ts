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

export const parentKeys = {
  session: (secret: string) => ["household", secret, "session"] as const,
  overview: (secret: string) => ["household", secret, "overview"] as const,
  library: (secret: string) => ["household", secret, "approved-library"] as const,
  tv: (secret: string) => ["household", secret, "tv-channel"] as const,
  movie: (secret: string) => ["household", secret, "movie-channel"] as const,
};
