import type { Expense } from "@prisma/client";
import { db } from "../db/client";

/** Treat shares within this tolerance (dollars) as fully paid. */
export const SPLIT_PAY_EPS = 0.004;

export function splitBalanceDue(shareAmount: number, paidAmount: number): number {
  return Math.max(0, Number((shareAmount - paidAmount).toFixed(2)));
}

export function isSplitFullyPaid(shareAmount: number, paidAmount: number): boolean {
  return splitBalanceDue(shareAmount, paidAmount) <= SPLIT_PAY_EPS;
}

export async function addExpense(input: {
  tripId: string;
  paidByUserId: string;
  amount: number;
  description: string;
  subgroupLabel?: string;
  /** When set, only these confirmed participants get split rows (equal shares). Payer is never included. */
  splitAmongUserIds?: string[];
  /** Exact share per person; sum must match `amount`. Overrides equal split from splitAmongUserIds. */
  customSplits?: Array<{ userId: string; shareAmount: number }>;
  receiptUrl?: string;
}): Promise<{
  expense: Expense;
  splitCount: number;
  usedSubgroupFallback: boolean;
}> {
  const confirmed = await db.participant.findMany({
    where: {
      tripId: input.tripId,
      status: "CONFIRMED",
    },
  });

  // Product rule: payer is not included in split targets.
  let splitTargets = confirmed.filter((p) => p.userId !== input.paidByUserId);
  let usedSubgroupFallback = false;

  if (input.splitAmongUserIds && input.splitAmongUserIds.length > 0) {
    const allow = new Set(input.splitAmongUserIds.filter((id) => id && id !== input.paidByUserId));
    splitTargets = confirmed.filter((p) => p.userId !== input.paidByUserId && allow.has(p.userId));
  } else if (input.subgroupLabel) {
    const tag = input.subgroupLabel.trim().toLowerCase();
    const tagged = confirmed.filter(
      (p) => p.subgroupTag !== null && p.subgroupTag.trim().toLowerCase() === tag,
    );
    if (tagged.length > 0) {
      splitTargets = tagged.filter((p) => p.userId !== input.paidByUserId);
    } else if (confirmed.length > 0) {
      usedSubgroupFallback = true;
      splitTargets = confirmed.filter((p) => p.userId !== input.paidByUserId);
    }
  }

  const expense = await db.expense.create({
    data: {
      tripId: input.tripId,
      paidByUserId: input.paidByUserId,
      amount: input.amount,
      description: input.description,
      isSubgroup: Boolean(input.subgroupLabel),
      subgroupLabel: input.subgroupLabel,
      receiptUrl: input.receiptUrl,
    },
  });

  if (input.customSplits && input.customSplits.length > 0) {
    const sum = input.customSplits.reduce((s, r) => s + r.shareAmount, 0);
    if (Math.abs(sum - input.amount) > 0.02) {
      throw new Error(`Split total ${sum.toFixed(2)} does not match expense amount ${input.amount.toFixed(2)}`);
    }
    await db.expenseSplit.createMany({
      data: input.customSplits.map((row) => ({
        expenseId: expense.id,
        userId: row.userId,
        shareAmount: Number(row.shareAmount.toFixed(2)),
        paidAmount: 0,
        settled: false,
      })),
    });
    return {
      expense,
      splitCount: input.customSplits.length,
      usedSubgroupFallback: false,
    };
  }

  if (splitTargets.length === 0) {
    return { expense, splitCount: 0, usedSubgroupFallback };
  }

  const share = Number((input.amount / splitTargets.length).toFixed(2));

  await db.expenseSplit.createMany({
    data: splitTargets.map((participant) => ({
      expenseId: expense.id,
      userId: participant.userId,
      shareAmount: share,
      paidAmount: 0,
      settled: false,
    })),
  });

  return {
    expense,
    splitCount: splitTargets.length,
    usedSubgroupFallback,
  };
}

export type RecordPartialPaymentResult =
  | {
      ok: true;
      appliedAmount: number;
      splitsTouched: number;
      splitsClosed: number;
      cappedOverpay: number;
    }
  | { ok: false; message: string };

/**
 * Apply dollars toward this user's open split lines (oldest expense first).
 * Creates SplitPayment + allocations for audit trail.
 */
export async function recordPartialPayment(input: {
  tripId: string;
  payerUserId: string;
  amount: number;
  note?: string;
  source?: "chat_partial" | "reaction_full";
}): Promise<RecordPartialPaymentResult> {
  const rounded = Number(input.amount.toFixed(2));
  if (rounded <= SPLIT_PAY_EPS) {
    return { ok: false, message: "Amount must be greater than zero." };
  }

  return db.$transaction(async (tx) => {
    const splits = await tx.expenseSplit.findMany({
      where: {
        userId: input.payerUserId,
        expense: {
          tripId: input.tripId,
          paidByUserId: { not: input.payerUserId },
        },
      },
      include: { expense: true },
      orderBy: { expense: { createdAt: "asc" } },
    });

    const withDue = splits
      .map((s) => ({
        split: s,
        due: splitBalanceDue(s.shareAmount, s.paidAmount),
      }))
      .filter((x) => x.due > SPLIT_PAY_EPS);

    const totalDue = Number(withDue.reduce((sum, x) => sum + x.due, 0).toFixed(2));
    if (totalDue <= SPLIT_PAY_EPS) {
      return { ok: false, message: "No outstanding split balance for you on this trip." };
    }

    const applyTotal = Math.min(rounded, totalDue);
    const cappedOverpay = Number((rounded - applyTotal).toFixed(2));

    let remaining = applyTotal;
    const plan: Array<{ expenseSplitId: string; amount: number }> = [];
    for (const row of withDue) {
      if (remaining <= SPLIT_PAY_EPS) {
        break;
      }
      const chunk = Number(Math.min(row.due, remaining).toFixed(2));
      if (chunk <= SPLIT_PAY_EPS) {
        continue;
      }
      plan.push({ expenseSplitId: row.split.id, amount: chunk });
      remaining = Number((remaining - chunk).toFixed(2));
    }

    if (plan.length === 0) {
      return { ok: false, message: "Could not allocate payment to any split line." };
    }

    await tx.splitPayment.create({
      data: {
        tripId: input.tripId,
        payerUserId: input.payerUserId,
        totalAmount: applyTotal,
        note: input.note?.trim() || null,
        source: input.source ?? "chat_partial",
        allocations: {
          create: plan.map((p) => ({
            expenseSplitId: p.expenseSplitId,
            amount: p.amount,
          })),
        },
      },
    });

    let splitsClosed = 0;
    for (const p of plan) {
      const s = await tx.expenseSplit.findUnique({ where: { id: p.expenseSplitId } });
      if (!s) {
        continue;
      }
      const newPaid = Number((s.paidAmount + p.amount).toFixed(2));
      const full = isSplitFullyPaid(s.shareAmount, newPaid);
      await tx.expenseSplit.update({
        where: { id: p.expenseSplitId },
        data: {
          paidAmount: newPaid,
          settled: full,
          settledAt: full ? new Date() : null,
        },
      });
      if (full) {
        splitsClosed += 1;
      }
    }

    return {
      ok: true,
      appliedAmount: applyTotal,
      splitsTouched: plan.length,
      splitsClosed,
      cappedOverpay,
    };
  });
}

export async function listMutableExpenses(tripId: string, actorUserId: string) {
  const trip = await db.trip.findUnique({ where: { id: tripId } });
  if (!trip) {
    return [];
  }
  const expenses = await db.expense.findMany({
    where: { tripId },
    orderBy: { createdAt: "desc" },
  });
  return expenses.filter((e) => e.paidByUserId === actorUserId || trip.createdBy === actorUserId);
}

export async function resolveMutableExpense(
  tripId: string,
  actorUserId: string,
  opts: { indexFromRecent?: number; descriptionContains?: string },
): Promise<{ expense: Expense } | { error: string }> {
  const list = await listMutableExpenses(tripId, actorUserId);
  if (list.length === 0) {
    return {
      error:
        "No expenses you can change yet. Only the person who paid for an expense or the trip creator can edit or delete.",
    };
  }
  let candidates = list;
  const sn = opts.descriptionContains?.trim();
  if (sn) {
    const lower = sn.toLowerCase();
    candidates = list.filter((e) => e.description.toLowerCase().includes(lower));
    if (candidates.length === 0) {
      return { error: `No expense matching “${sn}” that you’re allowed to change.` };
    }
  }
  const idx = (opts.indexFromRecent ?? 1) - 1;
  if (idx < 0 || idx >= candidates.length) {
    return {
      error: `That expense number doesn’t exist (you have ${candidates.length} changeable expense(s); 1 = most recent).`,
    };
  }
  return { expense: candidates[idx] };
}

export async function deleteExpenseForTrip(
  tripId: string,
  actorUserId: string,
  ref: { indexFromRecent?: number; descriptionContains?: string },
): Promise<{ ok: true; description: string; amount: number } | { ok: false; message: string }> {
  const r = await resolveMutableExpense(tripId, actorUserId, ref);
  if ("error" in r) {
    return { ok: false, message: r.error };
  }
  await db.expense.delete({ where: { id: r.expense.id } });
  return { ok: true, description: r.expense.description, amount: r.expense.amount };
}

export async function updateExpenseForTrip(input: {
  tripId: string;
  expenseId: string;
  actorUserId: string;
  newAmount?: number;
  newDescription?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const expense = await db.expense.findFirst({
    where: { id: input.expenseId, tripId: input.tripId },
    include: { splits: true },
  });
  if (!expense) {
    return { ok: false, message: "Expense not found." };
  }
  const trip = await db.trip.findUnique({ where: { id: input.tripId } });
  if (!trip) {
    return { ok: false, message: "Trip not found." };
  }
  if (expense.paidByUserId !== input.actorUserId && trip.createdBy !== input.actorUserId) {
    return { ok: false, message: "Only the person who paid or the trip creator can change this expense." };
  }

  const hasNewAmount = input.newAmount != null;
  const descTrim = input.newDescription?.trim() ?? "";
  const hasNewDesc = descTrim.length > 0;

  if (!hasNewAmount && !hasNewDesc) {
    return { ok: false, message: "Say what to change — new amount and/or new description." };
  }

  if (hasNewDesc && !hasNewAmount && descTrim === expense.description) {
    return { ok: false, message: "That’s already the description for this expense." };
  }

  if (!hasNewAmount && hasNewDesc) {
    await db.expense.update({
      where: { id: expense.id },
      data: { description: descTrim },
    });
    return { ok: true };
  }

  const amt = Number(input.newAmount!.toFixed(2));
  if (amt <= 0) {
    return { ok: false, message: "Amount must be greater than zero." };
  }

  const oldAmt = expense.amount;
  if (Math.abs(amt - oldAmt) <= 0.001 && !hasNewDesc) {
    return { ok: false, message: "That’s already the recorded amount." };
  }

  const finalDesc = hasNewDesc ? descTrim : expense.description;

  if (expense.splits.length === 0) {
    await db.expense.update({
      where: { id: expense.id },
      data: { amount: amt, description: finalDesc },
    });
    return { ok: true };
  }

  const factor = amt / oldAmt;
  const scaled = expense.splits.map((sp) => ({
    id: sp.id,
    shareAmount: Number((sp.shareAmount * factor).toFixed(2)),
    paidAmount: Number((sp.paidAmount * factor).toFixed(2)),
  }));
  const sumShares = scaled.reduce((s, x) => s + x.shareAmount, 0);
  const drift = Number((amt - sumShares).toFixed(2));
  if (scaled.length > 0) {
    scaled[scaled.length - 1].shareAmount = Number(
      (scaled[scaled.length - 1].shareAmount + drift).toFixed(2),
    );
  }

  await db.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id: expense.id },
      data: { amount: amt, description: finalDesc },
    });
    for (const row of scaled) {
      const cappedPaid = Math.min(row.paidAmount, row.shareAmount);
      const full = isSplitFullyPaid(row.shareAmount, cappedPaid);
      await tx.expenseSplit.update({
        where: { id: row.id },
        data: {
          shareAmount: row.shareAmount,
          paidAmount: cappedPaid,
          settled: full,
          settledAt: full ? new Date() : null,
        },
      });
    }
  });

  return { ok: true };
}

export async function markUserSettled(tripId: string, userId: string): Promise<{ settledCount: number }> {
  const splits = await db.expenseSplit.findMany({
    where: {
      userId,
      expense: {
        tripId,
        paidByUserId: { not: userId },
      },
    },
  });
  const totalDue = splits.reduce((sum, s) => sum + splitBalanceDue(s.shareAmount, s.paidAmount), 0);
  if (totalDue <= SPLIT_PAY_EPS) {
    return { settledCount: 0 };
  }

  const result = await recordPartialPayment({
    tripId,
    payerUserId: userId,
    amount: totalDue,
    source: "reaction_full",
  });

  if (!result.ok) {
    return { settledCount: 0 };
  }

  return { settledCount: result.splitsClosed };
}
