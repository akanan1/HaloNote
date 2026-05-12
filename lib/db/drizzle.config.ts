import { defineConfig } from "drizzle-kit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// drizzle-kit doesn't auto-load .env. Pull it in here so `pnpm push` works
// without the caller having to pre-export DATABASE_URL.
const envPath = path.resolve(here, "../../.env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative path so drizzle-kit's glob resolver works on both POSIX
  // and Windows (backslash-prefixed absolute paths trip it up).
  schema: "./src/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
