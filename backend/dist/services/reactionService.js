"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleReaction = handleReaction;
exports.recordHotelVoteByText = recordHotelVoteByText;
const client_1 = require("@prisma/client");
const client_2 = require("../db/client");
const userId_1 = require("../utils/userId");
const ledgerService_1 = require("./ledgerService");
const notificationService_1 = require("./notificationService");
const json_1 = require("../utils/json");
async function handleReaction(event) {
    if (!event.message_id || !event.reaction) {
        return;
    }
    const actorId = event.user_id ? (0, userId_1.normalizeParticipantId)(event.user_id) : undefined;
    const context = await client_2.db.messageContext.findUnique({
        where: { messageId: event.message_id },
        include: { trip: true },
    });
    if (!context) {
        return;
    }
    if (context.actionType === client_1.MessageAction.ATTENDANCE_CONFIRM && actorId) {
        if (event.reaction === "👍") {
            await client_2.db.participant.upsert({
                where: {
                    tripId_userId: {
                        tripId: context.tripId,
                        userId: actorId,
                    },
                },
                update: {
                    status: "CONFIRMED",
                    arrivalNote: "Confirmed by reaction",
                },
                create: {
                    tripId: context.tripId,
                    userId: actorId,
                    phoneNumber: actorId.startsWith("+") ? actorId : undefined,
                    status: "CONFIRMED",
                    arrivalNote: "Confirmed by reaction",
                },
            });
            await (0, notificationService_1.sendPlainMessage)(context.trip.threadId, `${actorId} is in.`);
            return;
        }
        if (event.reaction === "👎") {
            await client_2.db.participant.upsert({
                where: {
                    tripId_userId: {
                        tripId: context.tripId,
                        userId: actorId,
                    },
                },
                update: {
                    status: "DECLINED",
                    arrivalNote: "Declined by reaction",
                },
                create: {
                    tripId: context.tripId,
                    userId: actorId,
                    phoneNumber: actorId.startsWith("+") ? actorId : undefined,
                    status: "DECLINED",
                    arrivalNote: "Declined by reaction",
                },
            });
            await (0, notificationService_1.sendPlainMessage)(context.trip.threadId, `${actorId} is out for this one.`);
            return;
        }
    }
    if (context.actionType === client_1.MessageAction.HOTEL_VOTE && event.reaction === "👍") {
        const payload = (0, json_1.safeJsonParse)(context.payload ?? "{}", {});
        payload.votes = {
            ...(payload.votes ?? {}),
            [actorId ?? "unknown"]: "👍",
        };
        await client_2.db.messageContext.update({
            where: { messageId: context.messageId },
            data: {
                payload: JSON.stringify(payload),
            },
        });
        await (0, notificationService_1.sendPlainMessage)(context.trip.threadId, `${actorId ?? "Someone"} is good with those stay options.`);
        return;
    }
    if (context.actionType === client_1.MessageAction.PAYMENT_CONFIRM && event.reaction === "👍" && actorId) {
        const result = await (0, ledgerService_1.markUserSettled)(context.tripId, actorId);
        if (result.settledCount > 0) {
            await (0, notificationService_1.sendPlainMessage)(context.trip.threadId, `${actorId} is marked paid.`);
        }
    }
}
async function recordHotelVoteByText(input) {
    const latest = await client_2.db.messageContext.findFirst({
        where: { tripId: input.tripId, actionType: client_1.MessageAction.HOTEL_VOTE },
        orderBy: { createdAt: "desc" },
    });
    if (!latest) {
        return false;
    }
    const payload = (0, json_1.safeJsonParse)(latest.payload ?? "{}", {});
    const emoji = input.positive ? "👍" : "👎";
    payload.votes = {
        ...(payload.votes ?? {}),
        [input.userId]: emoji,
    };
    await client_2.db.messageContext.update({
        where: { messageId: latest.messageId },
        data: { payload: JSON.stringify(payload) },
    });
    await (0, notificationService_1.sendPlainMessage)(input.threadId, input.positive
        ? "Got it — I marked you as good with those stay options."
        : "Got it — I noted that those stay options are a pass for you.");
    return true;
}
