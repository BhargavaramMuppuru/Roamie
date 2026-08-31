"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimEvent = claimEvent;
exports.isDuplicate = isDuplicate;
exports.markProcessed = markProcessed;
const client_1 = require("@prisma/client");
const client_2 = require("../db/client");
/**
 * Atomically records that we are handling this webhook event. Call once at the
 * start of handling so duplicate deliveries (e.g. while outbound sends retry)
 * are ignored without re-running the state machine.
 */
async function claimEvent(eventId) {
    if (!eventId) {
        return true;
    }
    try {
        await client_2.db.processedEvent.create({
            data: { eventId },
        });
        return true;
    }
    catch (error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002") {
            return false;
        }
        throw error;
    }
}
async function isDuplicate(eventId) {
    if (!eventId) {
        return false;
    }
    const existing = await client_2.db.processedEvent.findUnique({
        where: { eventId },
    });
    return Boolean(existing);
}
async function markProcessed(eventId) {
    if (!eventId) {
        return;
    }
    await client_2.db.processedEvent.create({
        data: { eventId },
    });
}
