import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Components rely on browser globals; jsdom provides them. Keep
    // tests pure / file-scoped — no DB, no real network.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
