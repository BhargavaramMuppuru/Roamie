"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPlainMessage = sendPlainMessage;
exports.sendTrackedMessage = sendTrackedMessage;
const client_1 = require("../db/client");
const linqClient_1 = require("./linqClient");
async function sendPlainMessage(chatId, text) {
    return (0, linqClient_1.sendMessage)(chatId, text);
}
async function sendTrackedMessage(input) {
    const result = await (0, linqClient_1.sendMessage)(input.chatId, input.text);
    if (!result.messageId) {
        return result;
    }
    await client_1.db.messageContext.upsert({
        where: {
            messageId: result.messageId,
        },
        update: {
            actionType: input.actionType,
            payload: input.payload ? JSON.stringify(input.payload) : null,
            tripId: input.tripId,
        },
        create: {
            messageId: result.messageId,
            tripId: input.tripId,
            actionType: input.actionType,
            payload: input.payload ? JSON.stringify(input.payload) : null,
        },
    });
    return result;
}
