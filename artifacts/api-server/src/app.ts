import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { trackInflight } from "./lib/inflight";

const app: Express = express();

app.disable("x-powered-by");

// Trust proxy hops, driven by env. Without this, behind nginx /
// Cloudflare / Vercel etc., req.ip becomes the proxy's IP and the
// per-IP rate limiter collapses every client into one bucket. Also
// breaks `secure: true` cookies when TLS terminates upstream.
//
// Set TRUST_PROXY_HOPS to the number of trusted reverse proxies in
// front of the api-server (typically 1). Leave unset (0) for direct
// connections (local dev).
const trustHops = Number(process.env["TRUST_PROXY_HOPS"] ?? "0");
if (Number.isFinite(trustHops) && trustHops > 0) {
  app.set("trust proxy", trustHops);
}

// Helmet's default Content-Security-Policy blocks the inline script
// references Vite emits into index.html. Loosen it just enough for the
// hashed JS/CSS assets we ship while keeping the rest of the default
// header set (XSS, clickjacking, etc.).
app.use(
  helmet({
    contentSecurityPolicy:
      process.env["SPA_DIST_PATH"] !== undefined
        ? {
            useDefaults: true,
            directives: {
              // Allow the SPA's own bundled JS + connect-back to /api.
              "script-src": ["'self'"],
              "connect-src": ["'self'"],
              // Vite emits a single CSS bundle; no inline styles.
              "style-src": ["'self'"],
              // Lucide icons are inline SVG, no extra src needed.
              "img-src": ["'self'", "data:"],
            },
          }
        : undefined,
  }),
);

const corsOriginEnv = process.env["CORS_ORIGIN"]?.trim();
const corsOptions: CorsOptions = corsOriginEnv
  ? {
      origin: corsOriginEnv.split(",").map((s) => s.trim()).filter(Boolean),
      credentials: true,
    }
  : process.env["NODE_ENV"] === "production"
    ? { origin: false }
    : { credentials: true };
app.use(cors(corsOptions));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Track in-flight requests so SIGTERM can wait for them to drain.
app.use(trackInflight);

app.use("/api", router);

// When SPA_DIST_PATH points at a built provider-app, serve it from this
// same process — single container, same-origin cookies, no CORS dance.
// In local dev we run Vite separately (which proxies /api here), so this
// branch is no-op'd by leaving SPA_DIST_PATH unset.
const spaDistPath = process.env["SPA_DIST_PATH"]?.trim();
if (spaDistPath && spaDistPath.length > 0) {
  const resolved = path.resolve(spaDistPath);
  if (!existsSync(resolved)) {
    logger.warn(
      { spaDistPath: resolved },
      "SPA_DIST_PATH set but directory does not exist; skipping static serve",
    );
  } else {
    logger.info({ spaDistPath: resolved }, "serving SPA from disk");
    // Hashed assets get a long-lived cache; the entry HTML stays
    // no-cache so a new deploy is picked up on the next page load.
    app.use(
      express.static(resolved, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith("index.html")) {
            res.setHeader("cache-control", "no-cache");
          } else {
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );

    // SPA fallback: any GET that isn't /api/* and doesn't match a static
    // file gets index.html, so client-side routes (wouter) work on a
    // deep refresh. POSTs / mutations against unknown paths still 404.
    app.get(/^\/(?!api\/).*/, (req: Request, res: Response, next) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      res.sendFile(path.join(resolved, "index.html"));
    });
  }
}

export default app;
