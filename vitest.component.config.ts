import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "jsdom",
    include: ["test/component/**/*.test.tsx"],
    setupFiles: ["./test/component/setup.ts"],
  },
});
