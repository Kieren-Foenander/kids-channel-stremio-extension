import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { parentApi, parentKeys } from "./parent-api";

const POLL_INTERVAL_MS = 30_000;

export function useTvChannel<T>(secret: string) {
  const query = useQuery({
    queryKey: parentKeys.tv(secret),
    queryFn: () => parentApi<T>(`/api/households/${secret}/tv-state`),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  useVisibleFocusRefetch(query.refetch);
  return query;
}

export function useTvPreparation<T extends { run: { status: string } | null }>(secret: string) {
  const query = useQuery({
    queryKey: parentKeys.tvPreparation(secret),
    queryFn: () => parentApi<T>(`/api/households/${secret}/tv-preparation`),
    refetchInterval: (current) => ["queued", "running"].includes(current.state.data?.run?.status ?? "") ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
  useVisibleFocusRefetch(query.refetch);
  return query;
}

export function useMovieChannel<T>(secret: string) {
  const query = useQuery({
    queryKey: parentKeys.movie(secret),
    queryFn: () => parentApi<T>(`/api/households/${secret}/movie-state`),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  useVisibleFocusRefetch(query.refetch);
  return query;
}

function useVisibleFocusRefetch(refetch: () => unknown) {
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);
}
