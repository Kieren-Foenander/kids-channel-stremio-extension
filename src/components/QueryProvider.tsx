import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        retry: 1,
        staleTime: 15_000,
      },
      mutations: { retry: false },
    },
  }));

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
