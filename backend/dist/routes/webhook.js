"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const eventController_1 = require("../controllers/eventController");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const webhookRateLimit_1 = require("../middleware/webhookRateLimit");
const webhookSecurity_1 = require("../utils/webhookSecurity");
const router = (0, express_1.Router)();
router.post("/linq", webhookRateLimit_1.webhookRateLimiter, async (req, res) => {
    const rawBody = req.rawBody;
    const signatureHeader = req.header("x-webhook-signature") ??
        req.header("x-linq-signature") ??
        req.header("x-linq-signature-256");
    const timestampHeader = req.header("x-webhook-timestamp") ?? req.header("x-linq-timestamp");
    const isTrusted = (0, webhookSecurity_1.verifyWebhookSignature)({
        rawBody,
        signature: signatureHeader ?? undefined,
        timestamp: timestampHeader ?? undefined,
        secret: env_1.env.LINQ_WEBHOOK_SECRET,
    });
    if (!isTrusted) {
        res.sendStatus(401);
        return;
    }
    res.sendStatus(200);
    void (0, eventController_1.handleEvent)(req.body).catch((error) => {
        logger_1.logger.error("Webhook handling failed", error);
    });
});
exports.default = router;
