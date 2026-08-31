import rateLimit from "express-rate-limit";
import { env } from "../config/env";

export const webhookRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.WEBHOOK_RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
});
