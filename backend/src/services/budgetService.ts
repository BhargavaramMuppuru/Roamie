import { db } from "../db/client";
import { env } from "../config/env";
import { messageBlocks } from "../utils/chatCopy";

export type BudgetStatus = {
  totalSpent: number;
  budget: number;
  percentUsed: number;
  /** Remaining trip budget divided by confirmed people and calendar days left (needs end date). */
  perPersonPerDayRemaining: number | null;
  /** (budget - spent) / confirmed — always when budget exists. */
  perPersonTotalRemaining: number;
  daysRemaining: number | null;
  hasTripEndDate: boolean;
  confirmedCount: number;
  isOverBudget: boolean;
  /** This expense pushed spend from at/under budget to over. */
  justCrossedOverBudget: boolean;
  /** This expense pushed usage from below to at/above warning threshold (e.g. 80%). */
  justCrossedWarningThreshold: boolean;
  warningThresholdPercent: number;
  /** True when percent used >= warning threshold (for cron / digest). */
  shouldAlert: boolean;
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * @param expenseAmountJustAdded - pass the expense amount for this log to detect threshold crossings.
 */
export async function getBudgetStatus(
  tripId: string,
  opts?: { expenseAmountJustAdded?: number },
): Promise<BudgetStatus | null> {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      expenses: true,
      participants: true,
    },
  });

  if (!trip || trip.budget == null || trip.budget <= 0) {
    return null;
  }

  const budget = trip.budget;
  const totalSpent = trip.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const add = opts?.expenseAmountJustAdded ?? 0;
  const spentBefore = Math.max(0, totalSpent - add);

  const confirmedCount = Math.max(
    1,
    trip.participants.filter((p) => p.status === "CONFIRMED").length,
  );

  const percentUsed = (totalSpent / budget) * 100;
  const percentBefore = (spentBefore / budget) * 100;

  const warningThresholdPercent = env.BUDGET_WARNING_PERCENT;

  const remaining = budget - totalSpent;
  const perPersonTotalRemaining = remaining / confirmedCount;

  let daysRemaining: number | null = null;
  let perPersonPerDayRemaining: number | null = null;
  const hasTripEndDate = Boolean(trip.endDate);

  if (trip.endDate) {
    const msRemaining = trip.endDate.getTime() - Date.now();
    daysRemaining = Math.max(1, Math.ceil(msRemaining / 86_400_000));
    perPersonPerDayRemaining = remaining / confirmedCount / daysRemaining;
  }

  const isOverBudget = totalSpent > budget;
  const justCrossedOverBudget = isOverBudget && spentBefore <= budget;
  const justCrossedWarningThreshold =
    percentUsed >= warningThresholdPercent && percentBefore < warningThresholdPercent;

  return {
    totalSpent,
    budget,
    percentUsed,
    perPersonPerDayRemaining: perPersonPerDayRemaining != null ? roundMoney(perPersonPerDayRemaining) : null,
    perPersonTotalRemaining: roundMoney(perPersonTotalRemaining),
    daysRemaining,
    hasTripEndDate,
    confirmedCount,
    isOverBudget,
    justCrossedOverBudget,
    justCrossedWarningThreshold,
    warningThresholdPercent,
    shouldAlert: percentUsed >= warningThresholdPercent,
  };
}

/**
 * Human-readable block after logging an expense (combined with the expense line in chat).
 */
export function formatExpenseBudgetFollowUp(s: BudgetStatus): string {
  const pct = Math.round(s.percentUsed);
  const head = `Budget\n${pct}% of trip budget used ($${roundMoney(s.totalSpent).toFixed(0)} of $${Math.round(s.budget)})`;

  let pacing: string;
  if (s.hasTripEndDate && s.perPersonPerDayRemaining != null && s.daysRemaining != null) {
    const ppd = Math.max(0, s.perPersonPerDayRemaining);
    pacing = `Left to spend (per person)\nAbout $${Math.round(ppd)} / day · ${s.daysRemaining} day${s.daysRemaining === 1 ? "" : "s"} left in your trip dates`;
  } else {
    const left = Math.round(Math.max(0, s.perPersonTotalRemaining));
    pacing = `Left to spend (per person)\nAbout $${left} total · add a trip end date if you want daily pacing`;
  }

  const alerts: string[] = [];
  if (s.justCrossedWarningThreshold) {
    alerts.push(`Heads up: you crossed ${s.warningThresholdPercent}% of the trip budget.`);
  }
  if (s.justCrossedOverBudget) {
    const overBy = roundMoney(s.totalSpent - s.budget);
    alerts.push(
      `Over budget: this expense put the group past the $${Math.round(s.budget)} cap (about $${overBy.toFixed(0)} over).`,
    );
  }

  return messageBlocks(head, pacing, alerts.length ? alerts.join("\n") : undefined);
}
