/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { QueryProvider } from "../components/QueryProvider";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#f4f2ed" },
      { title: "Kids Channels" },
    ],
  }),
  pendingComponent: () => (
    <main className="page-shell" aria-busy="true">
      <p className="eyebrow">Kids Channels</p>
      <p>Loading Parent Page…</p>
    </main>
  ),
  notFoundComponent: () => (
    <main className="page-shell">
      <p className="eyebrow">Kids Channels</p>
      <h1>Page not found</h1>
      <p>This Parent Page destination does not exist.</p>
      <a className="text-link" href="/">Create a Household</a>
    </main>
  ),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <QueryProvider>{children}</QueryProvider>
        <Scripts />
      </body>
    </html>
  ),
  component: Outlet,
});
