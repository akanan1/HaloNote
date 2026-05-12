import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.disable("x-powered-by");

app.use(helmet());

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

app.use("/api", router);

export default app;
