"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../db/client");
const env_1 = require("../config/env");
const router = (0, express_1.Router)();
router.use((req, res, next) => {
    if (!env_1.env.ADMIN_DEBUG_TOKEN) {
        res.sendStatus(404);
        return;
    }
    const header = req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? (typeof req.query.token === "string" ? req.query.token : undefined);
    if (!token || token !== env_1.env.ADMIN_DEBUG_TOKEN) {
        res.sendStatus(401);
        return;
    }
    next();
});
router.get("/health", (_req, res) => {
    res.json({ ok: true, uptimeSec: Math.floor(process.uptime()) });
});
router.get("/stats", async (_req, res) => {
    const [trips, participants, expenses, processedEvents] = await Promise.all([
        client_1.db.trip.count(),
        client_1.db.participant.count(),
        client_1.db.expense.count(),
        client_1.db.processedEvent.count(),
    ]);
    res.json({ trips, participants, expenses, processedEvents });
});
exports.default = router;
