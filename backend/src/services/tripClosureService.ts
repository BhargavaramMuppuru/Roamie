import { db } from "../db/client";
import { logger } from "../utils/logger";
import { generateTripClosureMemoryNarrative } from "./openaiTripContent";
import { getParticipantDisplayLabel } from "./settlementService";

function formatMoney(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (Number.isInteger(r)) {
    return `$${r.toLocaleString("en-US")}`;
  }
  return `$${r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function formatTripDates(start?: Date | null, end?: Date | null): string {
  if (!start && !end) {
    return "dates not set";
  }
  const a = start ? start.toISOString().slice(0, 10) : "?";
  const b = end ? end.toISOString().slice(0, 10) : "?";
  return `${a} → ${b}`;
}

type ClosureSnapshot = {
  destination: string | null;
  title: string | null;
  datesLine: string;
  itineraryNotes: string | null;
  planningPickJson: string | null;
  expenseLines: string[];
  travelerNames: string[];
  totalSpent: number;
  biggestExpenseLabel: string;
  biggestExpenseAmount: number;
  smoothestPayerLabel: string;
};

async function computeSmoothestPayerLabel(
  tripId: string,
  expenses: Array<{ paidByUserId: string; amount: number }>,
  splits: Array<{ userId: string; settled: boolean; settledAt: Date | null }>,
): Promise<string> {
  const userIds = new Set(splits.map((s) => s.userId));
  const pending = new Map<string, number>();
  for (const s of splits) {
    if (!s.settled) {
      pending.set(s.userId, (pending.get(s.userId) ?? 0) + 1);
    }
  }

  const completionTimes: Array<{ uid: string; t: number }> = [];
  for (const uid of userIds) {
    if ((pending.get(uid) ?? 0) > 0) {
      continue;
    }
    const times = splits
      .filter((s) => s.userId === uid && s.settled && s.settledAt)
      .map((s) => s.settledAt!.getTime());
    if (times.length === 0) {
      continue;
    }
    completionTimes.push({ uid, t: Math.max(...times) });
  }

  if (completionTimes.length > 0) {
    completionTimes.sort((a, b) => a.t - b.t);
    return getParticipantDisplayLabel(tripId, completionTimes[0].uid);
  }

  const fronted = new Map<string, number>();
  for (const e of expenses) {
    fronted.set(e.paidByUserId, (fronted.get(e.paidByUserId) ?? 0) + e.amount);
  }
  let maxAmt = 0;
  let maxUid: string | null = null;
  for (const [uid, amt] of fronted) {
    if (amt > maxAmt) {
      maxAmt = amt;
      maxUid = uid;
    }
  }
  if (maxUid && maxAmt > 0) {
    return getParticipantDisplayLabel(tripId, maxUid);
  }

  return "the crew";
}

async function loadClosureSnapshot(tripId: string): Promise<ClosureSnapshot> {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      participants: {
        where: { status: "CONFIRMED" },
      },
      expenses: {
        include: { splits: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!trip) {
    throw new Error("Trip not found");
  }

  const expenses = trip.expenses;
  const totalSpent = expenses.reduce((sum, e) => sum + e.amount, 0);

  let biggest = expenses[0];
  for (const e of expenses) {
    if (!biggest || e.amount > biggest.amount) {
      biggest = e;
    }
  }
  const biggestExpenseAmount = biggest?.amount ?? 0;
  const biggestExpenseLabel =
    biggestExpenseAmount > 0 && biggest ? truncate(biggest.description, 48) : "—";

  const allSplits = expenses.flatMap((e) => e.splits);
  const smoothestPayerLabel = await computeSmoothestPayerLabel(
    tripId,
    expenses.map((e) => ({ paidByUserId: e.paidByUserId, amount: e.amount })),
    allSplits.map((s) => ({
      userId: s.userId,
      settled: s.settled,
      settledAt: s.settledAt,
    })),
  );

  const travelerNames: string[] = [];
  for (const p of trip.participants) {
    travelerNames.push(await getParticipantDisplayLabel(tripId, p.userId));
  }

  const expenseLines = expenses.map(
    (e) => `${truncate(e.description, 60)} — ${formatMoney(e.amount)}`,
  );

  const planningPickJson = trip.finalPlanningPick
    ? JSON.stringify(trip.finalPlanningPick).slice(0, 2000)
    : null;

  return {
    destination: trip.destination,
    title: trip.title,
    datesLine: formatTripDates(trip.startDate, trip.endDate),
    itineraryNotes: trip.itineraryNotes,
    planningPickJson,
    expenseLines,
    travelerNames,
    totalSpent,
    biggestExpenseLabel,
    biggestExpenseAmount,
    smoothestPayerLabel,
  };
}

function formatClosureStatsLine(s: ClosureSnapshot): string {
  const total = formatMoney(s.totalSpent);
  const big = s.biggestExpenseAmount > 0 ? truncate(s.biggestExpenseLabel, 40) : "—";
  return `Total spent ${total} · Biggest expense: ${big} · Smoothest payer: ${s.smoothestPayerLabel}`;
}

/**
 * AI memory journal + deterministic stats, sent when the trip moves to CLOSED.
 */
export async function buildTripClosureMessage(tripId: string): Promise<string> {
  const snapshot = await loadClosureSnapshot(tripId);
  const statsLine = formatClosureStatsLine(snapshot);

  let narrative: string | null = null;
  try {
    narrative = await generateTripClosureMemoryNarrative({
      destination: snapshot.destination,
      title: snapshot.title,
      datesLine: snapshot.datesLine,
      itineraryNotes: snapshot.itineraryNotes,
      planningPickJson: snapshot.planningPickJson,
      expenseLines: snapshot.expenseLines,
      travelerNames: snapshot.travelerNames,
    });
  } catch (error) {
    logger.warn("Trip closure narrative failed", { err: String(error) });
  }

  const destBit = snapshot.destination?.trim() ? ` on ${snapshot.destination.trim()}` : "";
  const fallbackOpening = `That’s a wrap${destBit}. I’ll keep the ledger history here if you want to look back.`;

  const body = narrative?.trim()
    ? `${narrative.trim()}\n\n${statsLine}`
    : `${fallbackOpening}\n\n${statsLine}`;

  return body;
}
