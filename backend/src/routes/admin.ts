import { Router } from "express";
import { db } from "../db/client";
import { env } from "../config/env";

const router = Router();

router.use((req, res, next) => {
  if (!env.ADMIN_DEBUG_TOKEN) {
    res.sendStatus(404);
    return;
  }
  const header = req.header("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? (typeof req.query.token === "string" ? req.query.token : undefined);
  if (!token || token !== env.ADMIN_DEBUG_TOKEN) {
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
    db.trip.count(),
    db.participant.count(),
    db.expense.count(),
    db.processedEvent.count(),
  ]);
  res.json({ trips, participants, expenses, processedEvents });
});

export default router;
