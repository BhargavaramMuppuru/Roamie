import { env } from "../config/env";
import { logger } from "../utils/logger";
import { handleReaction } from "../services/reactionService";
import { runStateMachine } from "../services/stateMachine";
import { handleParticipantAddedWebhook } from "../services/tripService";
import type { LinqWebhookEvent } from "../types/linq";
import { normalizeLinqEvent } from "../utils/linqEvent";
import { claimEvent } from "../utils/idempotency";

/** Linq fires many lifecycle webhooks; we only handle inbound messages + reactions. */
const IGNORED_LINQ_EVENT_TYPES = new Set([
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
  "message.sent",
  "message.delivered",
  "message.read",
]);

function rawEventType(event: LinqWebhookEvent): string {
  return String(event.event_type ?? event.type ?? "").trim().toLowerCase();
}

export async function handleEvent(event: LinqWebhookEvent): Promise<void> {
  const typeKey = rawEventType(event);
  if (IGNORED_LINQ_EVENT_TYPES.has(typeKey)) {
    return;
  }

  logger.debug("Inbound Linq webhook", {
    rawEvent: env.NODE_ENV === "development" ? event : { id: event.id ?? event.event_id, type: event.type ?? event.event_type },
  });

  const normalizedEvent = normalizeLinqEvent(event);
  const eventId = normalizedEvent.event_id ?? normalizedEvent.id;
  const eventType = normalizedEvent.type ?? normalizedEvent.event_type;

  if (!(await claimEvent(eventId))) {
    return;
  }

  if (typeKey === "participant.added") {
    await handleParticipantAddedWebhook(event);
    return;
  }

  const isInboundMessage =
    eventType === "message" ||
    eventType === "message.received";

  /** Only tapback *additions* — `reaction.removed` still carries reaction_type for the old emoji. */
  const isReactionAdded =
    eventType === "reaction" || eventType === "reaction.added";

  if (!isInboundMessage && !isReactionAdded) {
    return;
  }

  if (normalizedEvent.isFromMe) {
    return;
  }

  const senderHandle = normalizedEvent.user_id ?? normalizedEvent.handle;
  if (senderHandle === env.LINQ_FROM_PHONE) {
    return;
  }

  logger.info("Linq event normalized", {
    eventId,
    type: normalizedEvent.type,
    threadId: normalizedEvent.thread_id ?? normalizedEvent.chat_id,
    userId: normalizedEvent.user_id ?? normalizedEvent.handle,
    senderDisplayName: normalizedEvent.sender_display_name ?? null,
    hasText: Boolean(normalizedEvent.text?.trim()),
    messageId: normalizedEvent.message_id,
    reaction: normalizedEvent.reaction,
    isFromMe: normalizedEvent.isFromMe,
    mediaCount: normalizedEvent.mediaUrls?.length ?? 0,
    voiceUrlCount: normalizedEvent.voiceUrls?.length ?? 0,
  });

  if (isReactionAdded) {
    await handleReaction(normalizedEvent);
    return;
  }

  await runStateMachine(normalizedEvent);
}
