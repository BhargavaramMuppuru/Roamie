"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBudgetStatus = getBudgetStatus;
const client_1 = require("../db/client");
async function getBudgetStatus(tripId) {
    const trip = await client_1.db.trip.findUnique({
        where: { id: tripId },
        include: {
            expenses: true,
            participants: true,
        },
    });
    if (!trip || !trip.budget || !trip.endDate) {
        return null;
    }
    const totalSpent = trip.expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const percentUsed = (totalSpent / trip.budget) * 100;
    const confirmedCount = trip.participants.filter((person) => person.status === "CONFIRMED").length || 1;
    const msRemaining = trip.endDate.getTime() - Date.now();
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    const perPersonPerDay = (trip.budget - totalSpent) / confirmedCount / daysRemaining;
    return {
        totalSpent,
        percentUsed,
        perPersonPerDay,
        isOverBudget: totalSpent > trip.budget,
        shouldAlert: percentUsed >= 80,
    };
}
