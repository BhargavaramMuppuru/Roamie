import { ParticipantStatus, TripState } from "@prisma/client";
import cron from "node-cron";
import { db } from "../db/client";
import { getBudgetStatus } from "./budgetService";
import { sendPlainMessage } from "./notificationService";
import { renderSettlementSummary } from "./settlementService";

let started = false;

export function startScheduler() {
  if (started) {
    return;
  }

  started = true;

  cron.schedule("0 9 * * *", async () => {
    const trips = await db.trip.findMany({
      where: { currentState: TripState.ACTIVE },
    });

    for (const trip of trips) {
      const budget = await getBudgetStatus(trip.id);
      if (!budget?.shouldAlert) {
        continue;
      }

      await sendPlainMessage(
        trip.threadId,
        `Morning budget pulse: ${Math.round(budget.percentUsed)}% of the trip budget is gone.`,
      );
    }
  });

  cron.schedule("0 */12 * * *", async () => {
    const trips = await db.trip.findMany({
      where: { currentState: TripState.SETTLEMENT },
    });

    for (const trip of trips) {
      const summary = await renderSettlementSummary(trip.id);
      await sendPlainMessage(trip.threadId, `Roamie reminder:\n${summary}`);
    }
  });

  /** ~24h after trip creation: one nudge if RSVP still outstanding. */
  cron.schedule("15 */6 * * *", async () => {
    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const trips = await db.trip.findMany({
      where: {
        currentState: TripState.ATTENDANCE,
        attendanceNudgeSentAt: null,
        createdAt: { lte: threshold },
      },
      include: { participants: true },
    });

    for (const trip of trips) {
      const pending = trip.participants.filter((p) => p.status === ParticipantStatus.PENDING);
      const confirmed = trip.participants.filter((p) => p.status === ParticipantStatus.CONFIRMED);
      if (pending.length === 0) {
        continue;
      }

      const n = pending.length;
      const c = confirmed.length;
      const line =
        c > 0
          ? `${n} ${n === 1 ? "person hasn’t" : "people haven’t"} RSVP’d yet (${c} confirmed). Want to ping them, or keep planning with who’s in?`
          : `Still waiting on ${n} RSVP${n === 1 ? "" : "s"}. Reply in thread or give a nudge?`;

      await sendPlainMessage(trip.threadId, `Roamie — attendance check:\n${line}`);
      await db.trip.update({
        where: { id: trip.id },
        data: { attendanceNudgeSentAt: new Date() },
      });
    }
  });
}
