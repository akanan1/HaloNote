import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
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

// HTTPS dev server when DEV_HTTPS is truthy. Speech Recognition (and
// other powerful browser APIs) refuse to expose themselves over plain
// HTTP except on localhost — without HTTPS the dictation button stays
// hidden when a phone connects via LAN IP. Plugin emits a self-signed
// cert; users dismiss the one-time browser warning.
const devHttps =
  process.env["DEV_HTTPS"] === "1" || process.env["DEV_HTTPS"] === "true";

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(devHttps ? [basicSsl()] : [])],
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
    allowedHosts: true,
    proxy: {},
  },
});
