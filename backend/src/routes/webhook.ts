import { Router } from "express";
import { handleEvent } from "../controllers/eventController";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { webhookRateLimiter } from "../middleware/webhookRateLimit";
import { verifyWebhookSignature } from "../utils/webhookSecurity";

const router = Router();

router.post("/linq", webhookRateLimiter, async (req, res) => {
  const rawBody = (req as typeof req & { rawBody?: string }).rawBody;
  const signatureHeader =
    req.header("x-webhook-signature") ??
    req.header("x-linq-signature") ??
    req.header("x-linq-signature-256");
  const timestampHeader = req.header("x-webhook-timestamp") ?? req.header("x-linq-timestamp");

  const isTrusted = verifyWebhookSignature({
    rawBody,
    signature: signatureHeader ?? undefined,
    timestamp: timestampHeader ?? undefined,
    secret: env.LINQ_WEBHOOK_SECRET,
  });

  if (!isTrusted) {
    res.sendStatus(401);
    return;
  }

  res.sendStatus(200);

  void handleEvent(req.body).catch((error) => {
    logger.error("Webhook handling failed", error);
  });
});

export default router;
