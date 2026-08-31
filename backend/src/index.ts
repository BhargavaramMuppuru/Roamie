import "dotenv/config";
import express from "express";
import helmet from "helmet";
import webhookRouter from "./routes/webhook";
import adminRouter from "./routes/admin";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { startScheduler } from "./services/scheduler";

const app = express();
app.set("trust proxy", env.TRUST_PROXY ? 1 : false);

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
    },
  }),
);

app.get("/", (_req, res) => {
  res.send("Roamie backend is running");
});

app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);

app.listen(env.PORT, () => {
  logger.info(`Roamie is listening on port ${env.PORT}`);
  startScheduler();
});
