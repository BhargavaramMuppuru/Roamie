-- One-time 24h attendance reminder tracking (avoid spamming the thread).
ALTER TABLE "Trip" ADD COLUMN "attendanceNudgeSentAt" TIMESTAMP(3);
