import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

const envPath = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// PORT is only needed for `vite dev` / `vite preview` (where this config
// configures `server.port`). `vite build` calls into this config but
// never reads the dev-server settings — so requiring PORT here would
// break the build in environments without a .env (CI, Docker). Default
// to a placeholder for build-time, validate strictly only when actually
// serving.
const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 5173;
if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default the api-server proxy target to localhost:8080. Override with
// API_PROXY_TARGET when the api-server runs on a different port.
const apiProxyTarget =
  process.env["API_PROXY_TARGET"] ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
  },
});
