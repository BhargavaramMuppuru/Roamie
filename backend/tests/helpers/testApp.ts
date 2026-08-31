import express from "express";
import webhookRouter from "../../src/routes/webhook";

export function createWebhookTestApp(): express.Express {
  const app = express();
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
      },
    }),
  );
  app.use("/webhook", webhookRouter);
  return app;
}
