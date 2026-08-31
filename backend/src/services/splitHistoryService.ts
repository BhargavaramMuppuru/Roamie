import { db } from "../db/client";
import { messageBlocks } from "../utils/chatCopy";
import { getParticipantDisplayLabel } from "./settlementService";
import { splitBalanceDue, SPLIT_PAY_EPS } from "./ledgerService";

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Group-wide ledger: who paid each expense, each person’s share / paid / remaining, recent payment events.
 */
export async function buildGroupSplitHistoryText(tripId: string): Promise<string> {
  const [splits, payments] = await Promise.all([
    db.expenseSplit.findMany({
      where: { expense: { tripId } },
      include: { expense: true },
      orderBy: { expense: { createdAt: "desc" } },
    }),
    db.splitPayment.findMany({
      where: { tripId },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  if (splits.length === 0) {
    return "No split expenses yet. Log spending with something like “$25 lunch”.";
  }

  const expenseIds = [...new Set(splits.map((s) => s.expenseId))];
  const lines: string[] = ["Group split history", "Share → paid → still owed", ""];

  for (const eid of expenseIds) {
    const exp = splits.find((s) => s.expenseId === eid)?.expense;
    if (!exp) {
      continue;
    }
    const payer = await getParticipantDisplayLabel(tripId, exp.paidByUserId);
    lines.push(
      `• ${exp.description} — ${payer} paid ${fmtMoney(exp.amount)}${exp.isSubgroup && exp.subgroupLabel ? ` (${exp.subgroupLabel})` : ""}`,
    );
    const forExp = splits.filter((s) => s.expenseId === eid && s.userId !== exp.paidByUserId);
    if (forExp.length === 0) {
      continue;
    }
    for (const sp of forExp) {
      const who = await getParticipantDisplayLabel(tripId, sp.userId);
      const due = splitBalanceDue(sp.shareAmount, sp.paidAmount);
      const paid = sp.paidAmount;
      const status = due <= SPLIT_PAY_EPS ? "✓ paid up" : `owes ${fmtMoney(due)}`;
      lines.push(`  ${who}: share ${fmtMoney(sp.shareAmount)}, paid ${fmtMoney(paid)} — ${status}`);
    }
  }

  if (payments.length > 0) {
    lines.push("", "Recent payments");
    for (const p of payments) {
      const who = await getParticipantDisplayLabel(tripId, p.payerUserId);
      const src = p.source === "reaction_full" ? "full settle 👍" : "partial";
      const when = p.createdAt.toISOString().slice(0, 10);
      lines.push(`• ${when} ${who}: ${fmtMoney(p.totalAmount)} (${src})`);
    }
  }

  return lines.join("\n");
}

/**
 * One person’s split lines and total still owed on this trip.
 */
export async function buildUserSplitHistoryText(tripId: string, userId: string): Promise<string> {
  const splits = await db.expenseSplit.findMany({
    where: {
      userId,
      expense: {
        tripId,
        paidByUserId: { not: userId },
      },
    },
    include: { expense: true },
    orderBy: { expense: { createdAt: "desc" } },
  });

  if (splits.length === 0) {
    return "You don’t have any split lines on this trip yet (or you weren’t included on logged expenses).";
  }

  const label = await getParticipantDisplayLabel(tripId, userId);
  const lines: string[] = [`Your splits — ${label}`, ""];
  let totalDue = 0;

  for (const sp of splits) {
    const exp = sp.expense;
    const payer = await getParticipantDisplayLabel(tripId, exp.paidByUserId);
    const due = splitBalanceDue(sp.shareAmount, sp.paidAmount);
    totalDue += due;
    const status = due <= SPLIT_PAY_EPS ? "paid up ✓" : `still owe ${fmtMoney(due)}`;
    lines.push(
      `• ${exp.description} (${payer} paid ${fmtMoney(exp.amount)}): your share ${fmtMoney(sp.shareAmount)}, you paid ${fmtMoney(sp.paidAmount)} — ${status}`,
    );
  }

  lines.push("");
  if (totalDue <= SPLIT_PAY_EPS) {
    lines.push("Total still owed on splits: $0.00", "You’re caught up on recorded lines.");
  } else {
    lines.push(`Total still owed: ${fmtMoney(totalDue)}`, `Pay down with e.g. “$20 partial” or 👍 on a payment prompt when fully paid.`);
  }

  return messageBlocks(...lines.filter((l) => l !== ""));
}
