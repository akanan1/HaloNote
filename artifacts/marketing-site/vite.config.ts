import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Marketing site — Tailwind v3 via PostCSS (mirroring the live
// Replit project's setup, so the rendered HTML stays a 1:1 carbon
// copy of halonote.app modulo the new logo SVG).

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 5174;
if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
