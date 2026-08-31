"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rebuildSettlementRecords = rebuildSettlementRecords;
exports.renderSettlementSummary = renderSettlementSummary;
const client_1 = require("../db/client");
async function rebuildSettlementRecords(tripId) {
    const trip = await client_1.db.trip.findUnique({
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
    const net = new Map();
    for (const participant of trip.participants) {
        net.set(participant.userId, 0);
    }
    for (const expense of trip.expenses) {
        net.set(expense.paidByUserId, (net.get(expense.paidByUserId) ?? 0) + expense.amount);
        for (const split of expense.splits) {
            net.set(split.userId, (net.get(split.userId) ?? 0) - split.shareAmount);
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
    const records = [];
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
    await client_1.db.settlementRecord.deleteMany({
        where: { tripId },
    });
    if (records.length > 0) {
        await client_1.db.settlementRecord.createMany({
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
async function renderSettlementSummary(tripId) {
    const [records, unsettledSplitLines, tripForMeta] = await Promise.all([
        rebuildSettlementRecords(tripId),
        client_1.db.expenseSplit.count({
            where: {
                settled: false,
                expense: { tripId },
            },
        }),
        client_1.db.trip.findUnique({
            where: { id: tripId },
            include: {
                participants: {
                    where: { status: "CONFIRMED" },
                },
                expenses: true,
            },
        }),
    ]);
    const totalSpend = tripForMeta?.expenses.reduce((sum, e) => sum + e.amount, 0) ?? 0;
    const hasExpenses = (tripForMeta?.expenses.length ?? 0) > 0;
    if (hasExpenses && unsettledSplitLines === 0) {
        const spendLine = totalSpend > 0
            ? ` Total trip spend logged: about $${totalSpend.toFixed(2)}.`
            : "";
        return [
            "Everything on the ledger is marked paid, so there’s nothing left to settle.",
            spendLine.trim(),
        ]
            .filter(Boolean)
            .join("");
    }
    if (records.length > 0) {
        const lines = [
            "Here’s the current settle-up snapshot:",
            ...records.map((record) => `${record.fromUserId} owes ${record.toUserId} $${record.amount.toFixed(2)}`),
        ];
        if (unsettledSplitLines > 0) {
            lines.push(`There are still ${unsettledSplitLines} unpaid split line(s) in Roamie — react 👍 on payment prompts as people settle up.`);
        }
        return lines.join("\n");
    }
    const trip = tripForMeta;
    const confirmed = trip?.participants.length ?? 0;
    if (confirmed <= 1 && totalSpend > 0) {
        return [
            "There’s no one else to split with yet, so nothing is owed between people right now.",
            `Trip spend logged so far: about $${totalSpend.toFixed(2)}. Once others reply yes or 👍, I can split it out properly.`,
        ].join("\n");
    }
    if (totalSpend > 0) {
        const even = [
            "The group is basically even right now, so no transfers are needed.",
            `Total trip spend logged: about $${totalSpend.toFixed(2)}.`,
        ];
        if (unsettledSplitLines > 0) {
            even.push(`${unsettledSplitLines} split line(s) still are not marked paid — use 👍 on payment messages as people pay each other back.`);
        }
        return even.join("\n");
    }
    return "No expenses are logged yet. Once spending starts, send something like “$25 lunch”.";
}
