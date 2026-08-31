"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleEvent = handleEvent;
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const reactionService_1 = require("../services/reactionService");
const stateMachine_1 = require("../services/stateMachine");
const linqEvent_1 = require("../utils/linqEvent");
const idempotency_1 = require("../utils/idempotency");
/** Linq fires many lifecycle webhooks; we only handle inbound messages + reactions. */
const IGNORED_LINQ_EVENT_TYPES = new Set([
    "chat.typing_indicator.started",
    "chat.typing_indicator.stopped",
    "message.sent",
    "message.delivered",
    "message.read",
]);
function rawEventType(event) {
    return String(event.event_type ?? event.type ?? "").trim().toLowerCase();
}
async function handleEvent(event) {
    const typeKey = rawEventType(event);
    if (IGNORED_LINQ_EVENT_TYPES.has(typeKey)) {
        return;
    }
    logger_1.logger.debug("Inbound Linq webhook", {
        rawEvent: env_1.env.NODE_ENV === "development" ? event : { id: event.id ?? event.event_id, type: event.type ?? event.event_type },
    });
    const normalizedEvent = (0, linqEvent_1.normalizeLinqEvent)(event);
    const eventId = normalizedEvent.event_id ?? normalizedEvent.id;
    const eventType = normalizedEvent.type ?? normalizedEvent.event_type;
    if (!(await (0, idempotency_1.claimEvent)(eventId))) {
        return;
    }
    const isInboundMessage = eventType === "message" ||
        eventType === "message.received";
    const isReactionEvent = eventType === "reaction" ||
        eventType === "reaction.added" ||
        Boolean(normalizedEvent.reaction);
    if (!isInboundMessage && !isReactionEvent) {
        return;
    }
    if (normalizedEvent.isFromMe) {
        return;
    }
    const senderHandle = normalizedEvent.user_id ?? normalizedEvent.handle;
    if (senderHandle === env_1.env.LINQ_FROM_PHONE) {
        return;
    }
    logger_1.logger.info("Linq event normalized", {
        eventId,
        type: normalizedEvent.type,
        threadId: normalizedEvent.thread_id ?? normalizedEvent.chat_id,
        userId: normalizedEvent.user_id ?? normalizedEvent.handle,
        hasText: Boolean(normalizedEvent.text?.trim()),
        messageId: normalizedEvent.message_id,
        reaction: normalizedEvent.reaction,
        isFromMe: normalizedEvent.isFromMe,
        mediaCount: normalizedEvent.mediaUrls?.length ?? 0,
        voiceUrlCount: normalizedEvent.voiceUrls?.length ?? 0,
    });
    if (isReactionEvent) {
        await (0, reactionService_1.handleReaction)(normalizedEvent);
        return;
    }
    await (0, stateMachine_1.runStateMachine)(normalizedEvent);
}
