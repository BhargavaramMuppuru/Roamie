import { db } from "../db/client";
import { messageBlocks } from "../utils/chatCopy";
import { splitBalanceDue, SPLIT_PAY_EPS } from "./ledgerService";

/** Readable fallback when we only have E.164 (no contact name in DB). */
function formatE164ForDisplay(raw: string): string {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  if (!t.startsWith("+") || digits.length < 10) {
    return raw;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const r = digits.slice(1);
    return `+1 (${r.slice(0, 3)}) ${r.slice(3, 6)}-${r.slice(6)}`;
  }
  return raw;
}

function formatEnglishList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** When many people remain, show a few names then a count to keep messages short. */
function formatWaitingRollCall(sortedLabels: string[]): string {
  const maxFullNames = 4;
  if (sortedLabels.length <= maxFullNames) {
    return formatEnglishList(sortedLabels);
  }
  const head = sortedLabels.slice(0, 3);
  const rest = sortedLabels.length - 3;
  return `${formatEnglishList(head)}, and ${rest} other${rest === 1 ? "" : "s"}`;
}

export async function getParticipantDisplayLabel(tripId: string, userId: string): Promise<string> {
  const p = await db.participant.findUnique({
    where: { tripId_userId: { tripId, userId } },
  });
  if (p?.name?.trim()) {
    return p.name.trim();
  }
  if (p?.phoneNumber?.trim()) {
    return formatE164ForDisplay(p.phoneNumber.trim());
  }
  return formatE164ForDisplay(userId);
}

type SplitParticipantProgress = {
  totalPeople: number;
  markedPaidPeople: number;
  pendingUserIds: string[];
};

/**
 * Progress is by distinct people on expense splits: someone is "marked paid" when they have
 * no remaining unsettled split rows for this trip (same rule as 👍 on payment prompts).
 */
async function getSplitParticipantProgress(tripId: string): Promise<SplitParticipantProgress | null> {
  const splits = await db.expenseSplit.findMany({
    where: { expense: { tripId } },
    select: {
      userId: true,
      shareAmount: true,
      paidAmount: true,
      expense: { select: { paidByUserId: true } },
    },
  });
  if (splits.length === 0) {
    return null;
  }

  const validSplits = splits.filter((s) => s.userId !== s.expense.paidByUserId);
  const allUserIds = new Set(validSplits.map((s) => s.userId));
  const pendingUserIds = new Set<string>();
  for (const s of validSplits) {
    if (splitBalanceDue(s.shareAmount, s.paidAmount) > SPLIT_PAY_EPS) {
      pendingUserIds.add(s.userId);
    }
  }

  return {
    totalPeople: allUserIds.size,
    markedPaidPeople: allUserIds.size - pendingUserIds.size,
    pendingUserIds: [...pendingUserIds],
  };
}

/**
 * Full chat reply after a successful payment 👍: individual ack + group-wide settle-up progress.
 */
export async function buildPaymentConfirmationReply(tripId: string, actorUserId: string): Promise<string> {
  const [actorLabel, progress] = await Promise.all([
    getParticipantDisplayLabel(tripId, actorUserId),
    getSplitParticipantProgress(tripId),
  ]);

  const head = `${actorLabel} is marked paid.`;

  if (!progress) {
    return head;
  }

  const { totalPeople, markedPaidPeople, pendingUserIds } = progress;

  if (pendingUserIds.length === 0) {
    return messageBlocks(
      head,
      `Settle-up status\n${markedPaidPeople} of ${totalPeople} people with split lines are fully paid up.`,
    );
  }

  const pendingLabels = (
    await Promise.all(pendingUserIds.map((uid) => getParticipantDisplayLabel(tripId, uid)))
  ).sort((a, b) => a.localeCompare(b));
  const waiting = formatWaitingRollCall(pendingLabels);

  return messageBlocks(
    head,
    `Settle-up progress\n${markedPaidPeople} of ${totalPeople} people are paid up so far.`,
    `Still waiting on: ${waiting}`,
  );
}

export async function rebuildSettlementRecords(tripId: string) {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      expenses: {
        include: {
          splits: true,
        },
      },
      participants: true,
      settlements: true,
    },
  });

  if (!trip) {
    return [];
  }

  const net = new Map<string, number>();

  for (const participant of trip.participants) {
    net.set(participant.userId, 0);
  }

  for (const expense of trip.expenses) {
    for (const split of expense.splits) {
      if (split.userId === expense.paidByUserId) {
        continue;
      }
      const stillOwed = splitBalanceDue(split.shareAmount, split.paidAmount);
      if (stillOwed <= SPLIT_PAY_EPS) {
        continue;
      }
      // Settlement is based on what each non-payer still owes the payer.
      net.set(split.userId, (net.get(split.userId) ?? 0) - stillOwed);
      net.set(expense.paidByUserId, (net.get(expense.paidByUserId) ?? 0) + stillOwed);
    }
  }

  const debtors = Array.from(net.entries())
    .filter(([, amount]) => amount < -0.01)
    .map(([userId, amount]) => ({ userId, amount: Math.abs(amount) }))
    .sort((a, b) => b.amount - a.amount);

  const creditors = Array.from(net.entries())
    .filter(([, amount]) => amount > 0.01)
    .map(([userId, amount]) => ({ userId, amount }))
    .sort((a, b) => b.amount - a.amount);

  const records: Array<{ fromUserId: string; toUserId: string; amount: number }> = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Number(Math.min(debtor.amount, creditor.amount).toFixed(2));

    if (amount > 0) {
      records.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amount,
      });
    }

    debtor.amount = Number((debtor.amount - amount).toFixed(2));
    creditor.amount = Number((creditor.amount - amount).toFixed(2));

    if (debtor.amount <= 0.01) {
      debtorIndex += 1;
    }

    if (creditor.amount <= 0.01) {
      creditorIndex += 1;
    }
  }

  await db.settlementRecord.deleteMany({
    where: { tripId },
  });

  if (records.length > 0) {
    await db.settlementRecord.createMany({
      data: records.map((record) => ({
        tripId,
        fromUserId: record.fromUserId,
        toUserId: record.toUserId,
        amount: record.amount,
      })),
    });
  }

  return records;
}

export async function renderSettlementSummary(tripId: string) {
  const [records, splitsForCount, tripForMeta] = await Promise.all([
    rebuildSettlementRecords(tripId),
    db.expenseSplit.findMany({
      where: { expense: { tripId } },
      select: { shareAmount: true, paidAmount: true, userId: true, expense: { select: { paidByUserId: true } } },
    }),
    db.trip.findUnique({
      where: { id: tripId },
      include: {
        participants: {
          where: { status: "CONFIRMED" },
        },
        expenses: true,
      },
    }),
  ]);

  const unsettledSplitLines = splitsForCount.filter(
    (s) => s.userId !== s.expense.paidByUserId && splitBalanceDue(s.shareAmount, s.paidAmount) > SPLIT_PAY_EPS,
  ).length;

  const totalSpend = tripForMeta?.expenses.reduce((sum, e) => sum + e.amount, 0) ?? 0;
  const hasExpenses = (tripForMeta?.expenses.length ?? 0) > 0;

  if (hasExpenses && unsettledSplitLines === 0) {
    const spendLine =
      totalSpend > 0 ? `Total trip spend logged: about $${totalSpend.toFixed(2)}.` : "";
    return messageBlocks(
      "Everyone’s split lines are paid up — there’s nothing left to settle between people.",
      spendLine || undefined,
    );
  }

  if (records.length > 0) {
    const oweLines = await Promise.all(
      records.map(async (record) => {
        const [from, to] = await Promise.all([
          getParticipantDisplayLabel(tripId, record.fromUserId),
          getParticipantDisplayLabel(tripId, record.toUserId),
        ]);
        return `• ${from} → ${to}: $${record.amount.toFixed(2)}`;
      }),
    );
    const body = ["Who should pay whom", ...oweLines].join("\n");
    if (unsettledSplitLines > 0) {
      return messageBlocks(
        body,
        `Note: ${unsettledSplitLines} split line(s) in Roamie still need a payment pass (reply or 👍 on payment prompts as people pay).`,
      );
    }
    return body;
  }

  const trip = tripForMeta;
  const confirmed = trip?.participants.length ?? 0;

  if (confirmed <= 1 && totalSpend > 0) {
    return messageBlocks(
      "There’s no one else to split with yet, so nothing is owed between people.",
      `Trip spend so far: about $${totalSpend.toFixed(2)}.\nWhen others join (yes or 👍), splits will work properly.`,
    );
  }

  if (totalSpend > 0) {
    const tail =
      unsettledSplitLines > 0
        ? `${unsettledSplitLines} split line(s) still need a payment pass — use 👍 on payment messages as people pay each other back.`
        : "";
    return messageBlocks(
      "The group is roughly even — no big transfers needed right now.",
      `Total trip spend logged: about $${totalSpend.toFixed(2)}.`,
      tail || undefined,
    );
  }

  return "No expenses yet. Log one like: $25 lunch";
}
