"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addExpense = addExpense;
exports.markUserSettled = markUserSettled;
const client_1 = require("../db/client");
async function addExpense(input) {
    const confirmed = await client_1.db.participant.findMany({
        where: {
            tripId: input.tripId,
            status: "CONFIRMED",
        },
    });
    let splitTargets = confirmed;
    let usedSubgroupFallback = false;
    if (input.subgroupLabel) {
        const tag = input.subgroupLabel.trim().toLowerCase();
        const tagged = confirmed.filter((p) => p.subgroupTag !== null && p.subgroupTag.trim().toLowerCase() === tag);
        if (tagged.length > 0) {
            splitTargets = tagged;
        }
        else if (confirmed.length > 0) {
            usedSubgroupFallback = true;
            splitTargets = confirmed;
        }
    }
    const expense = await client_1.db.expense.create({
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
    if (splitTargets.length === 0) {
        return { expense, splitCount: 0, usedSubgroupFallback };
    }
    const share = Number((input.amount / splitTargets.length).toFixed(2));
    await client_1.db.expenseSplit.createMany({
        data: splitTargets.map((participant) => ({
            expenseId: expense.id,
            userId: participant.userId,
            shareAmount: share,
        })),
    });
    return {
        expense,
        splitCount: splitTargets.length,
        usedSubgroupFallback,
    };
}
async function markUserSettled(tripId, userId) {
    const openSplits = await client_1.db.expenseSplit.findMany({
        where: {
            userId,
            settled: false,
            expense: {
                tripId,
            },
        },
        include: {
            expense: true,
        },
    });
    if (openSplits.length === 0) {
        return { settledCount: 0 };
    }
    await client_1.db.expenseSplit.updateMany({
        where: {
            id: {
                in: openSplits.map((split) => split.id),
            },
        },
        data: {
            settled: true,
            settledAt: new Date(),
        },
    });
    return { settledCount: openSplits.length };
}
