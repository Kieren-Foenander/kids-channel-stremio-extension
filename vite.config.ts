import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// Sonner injects its stylesheet via a runtime <style> element, which the
// Content-Security-Policy (style-src 'self') blocks and the hardened SPA shell
// forbids. Its styles are imported statically in components/ui/sonner.tsx, so
// the injection is stripped here. Sonner's injected CSS contains no `")`
// sequence, so matching to the first `")` terminator is safe for 2.0.7.
function stripSonnerRuntimeCss(): Plugin {
  return {
    name: "strip-sonner-runtime-css",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules/sonner/dist/") || !id.endsWith(".mjs")) return null;
      const stripped = code.replace(/__insertCSS\("[\s\S]*?"\);/, "");
      return stripped === code ? null : stripped;
    },
  };
}

export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  plugins: [
    stripSonnerRuntimeCss(),
    tanstackStart({ spa: { enabled: true } }),
    react(),
    tailwindcss(),
  ],
});
