/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { Ident } from "../components/Ident";
import { QueryProvider } from "../components/QueryProvider";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#fbfaf8" },
      { title: "Kids Channels" },
    ],
  }),
  pendingComponent: () => (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16" aria-busy="true">
      <Ident className="mb-3">Kids Channels</Ident>
      <p className="leading-relaxed text-muted-foreground">Loading Parent Page…</p>
    </main>
  ),
  notFoundComponent: () => (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16">
      <Ident className="mb-3">Kids Channels</Ident>
      <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">Page not found</h1>
      <p className="mt-2 leading-relaxed text-muted-foreground">This Parent Page destination does not exist.</p>
      <a className="mt-4 w-fit font-medium text-accent underline-offset-4 hover:underline" href="/">Create a Household</a>
    </main>
  ),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <a className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-[3px] focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-background" href="#main">
          Skip to content
        </a>
        <QueryProvider>{children}</QueryProvider>
        <Scripts />
      </body>
    </html>
  ),
  component: Outlet,
});
