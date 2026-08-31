import { MessageAction } from "@prisma/client";
import { db } from "../db/client";
import type { LinqWebhookEvent } from "../types/linq";
import { normalizeParticipantId } from "../utils/userId";
import { markUserSettled } from "./ledgerService";
import { sendPlainMessage } from "./notificationService";
import { applyLinqParticipantNamesToTrip, hydrateParticipantNamesFromLinqChatIfStale } from "./tripService";
import { buildPaymentConfirmationReply, getParticipantDisplayLabel } from "./settlementService";
import { messageBlocks } from "../utils/chatCopy";
import { safeJsonParse } from "../utils/json";

type RsvpPayload = {
  kind: string;
  title: string;
  votes: Record<string, "in" | "out">;
};

function tallyRsvp(votes: Record<string, "in" | "out">): { ins: number; outs: number } {
  let ins = 0;
  let outs = 0;
  for (const v of Object.values(votes)) {
    if (v === "in") {
      ins += 1;
    } else if (v === "out") {
      outs += 1;
    }
  }
  return { ins, outs };
}

export async function handleReaction(event: LinqWebhookEvent) {
  if (!event.message_id || !event.reaction) {
    return;
  }

  const actorId = event.user_id ? normalizeParticipantId(event.user_id) : undefined;

  const context = await db.messageContext.findUnique({
    where: { messageId: event.message_id },
    include: { trip: true },
  });

  if (!context) {
    return;
  }

  await applyLinqParticipantNamesToTrip(context.tripId, event);
  await hydrateParticipantNamesFromLinqChatIfStale(context.tripId, context.trip.threadId, {
    force: !event.sender_display_name?.trim(),
  });

  if (context.actionType === MessageAction.ATTENDANCE_CONFIRM && actorId) {
    const nameFromEvent = event.sender_display_name?.trim();
    const nameFields = nameFromEvent ? { name: nameFromEvent } : {};
    if (event.reaction === "👍") {
      await db.participant.upsert({
        where: {
          tripId_userId: {
            tripId: context.tripId,
            userId: actorId,
          },
        },
        update: {
          status: "CONFIRMED",
          arrivalNote: "Confirmed by reaction",
          ...nameFields,
        },
        create: {
          tripId: context.tripId,
          userId: actorId,
          phoneNumber: actorId.startsWith("+") ? actorId : undefined,
          status: "CONFIRMED",
          arrivalNote: "Confirmed by reaction",
          ...nameFields,
        },
      });
      const label = await getParticipantDisplayLabel(context.tripId, actorId);
      await sendPlainMessage(context.trip.threadId, `${label} is in.`);
      return;
    }

    if (event.reaction === "👎") {
      await db.participant.upsert({
        where: {
          tripId_userId: {
            tripId: context.tripId,
            userId: actorId,
          },
        },
        update: {
          status: "DECLINED",
          arrivalNote: "Declined by reaction",
          ...nameFields,
        },
        create: {
          tripId: context.tripId,
          userId: actorId,
          phoneNumber: actorId.startsWith("+") ? actorId : undefined,
          status: "DECLINED",
          arrivalNote: "Declined by reaction",
          ...nameFields,
        },
      });
      const label = await getParticipantDisplayLabel(context.tripId, actorId);
      await sendPlainMessage(context.trip.threadId, `${label} is out for this one.`);
      return;
    }
  }

  if (context.actionType === MessageAction.HOTEL_VOTE) {
    if (event.reaction === "👍" || event.reaction === "👎") {
      await sendPlainMessage(
        context.trip.threadId,
        "Votes are by number on this poll — reply 1, 2, or 3 in the chat (tapbacks aren’t counted).",
      );
    }
    return;
  }

  if (context.actionType === MessageAction.RSVP_POLL && actorId) {
    const side =
      event.reaction === "👍"
        ? ("in" as const)
        : event.reaction === "👎"
          ? ("out" as const)
          : null;
    if (!side) {
      return;
    }
    const payload = safeJsonParse<RsvpPayload>(context.payload ?? "{}", { kind: "", title: "", votes: {} });
    if (payload.kind !== "rsvp" || !payload.title) {
      return;
    }
    const votes = { ...(payload.votes ?? {}), [actorId]: side };
    await db.messageContext.update({
      where: { messageId: context.messageId },
      data: { payload: JSON.stringify({ ...payload, votes }) },
    });
    const { ins, outs } = tallyRsvp(votes);
    const label = await getParticipantDisplayLabel(context.tripId, actorId);
    await sendPlainMessage(
      context.trip.threadId,
      messageBlocks(
        `Recorded ${label} as ${side.toUpperCase()} for “${payload.title}”.`,
        `So far: ${ins} in, ${outs} out.`,
      ),
    );
    return;
  }

  if (context.actionType === MessageAction.PAYMENT_CONFIRM && event.reaction === "👍" && actorId) {
    const result = await markUserSettled(context.tripId, actorId);
    if (result.settledCount > 0) {
      const text = await buildPaymentConfirmationReply(context.tripId, actorId);
      await sendPlainMessage(context.trip.threadId, text);
    }
  }
}

