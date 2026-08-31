"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startScheduler = startScheduler;
const client_1 = require("@prisma/client");
const node_cron_1 = __importDefault(require("node-cron"));
const client_2 = require("../db/client");
const budgetService_1 = require("./budgetService");
const notificationService_1 = require("./notificationService");
const settlementService_1 = require("./settlementService");
let started = false;
function startScheduler() {
    if (started) {
        return;
    }
    started = true;
    node_cron_1.default.schedule("0 9 * * *", async () => {
        const trips = await client_2.db.trip.findMany({
            where: { currentState: client_1.TripState.ACTIVE },
        });
        for (const trip of trips) {
            const budget = await (0, budgetService_1.getBudgetStatus)(trip.id);
            if (!budget?.shouldAlert) {
                continue;
            }
            await (0, notificationService_1.sendPlainMessage)(trip.threadId, `Morning budget pulse: ${Math.round(budget.percentUsed)}% of the trip budget is gone.`);
        }
    });
    node_cron_1.default.schedule("0 */12 * * *", async () => {
        const trips = await client_2.db.trip.findMany({
            where: { currentState: client_1.TripState.SETTLEMENT },
        });
        for (const trip of trips) {
            const summary = await (0, settlementService_1.renderSettlementSummary)(trip.id);
            await (0, notificationService_1.sendPlainMessage)(trip.threadId, `Roamie reminder:\n${summary}`);
        }
    });
}
