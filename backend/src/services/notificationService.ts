import { MessageAction } from "@prisma/client";
import { db } from "../db/client";
import type { LinqMessageResult } from "../types/linq";
import { sendMessage } from "./linqClient";

export async function sendPlainMessage(chatId: string, text: string): Promise<LinqMessageResult> {
  return sendMessage(chatId, text);
}

export async function sendTrackedMessage(input: {
  chatId: string;
  tripId: string;
  text: string;
  actionType: MessageAction;
  payload?: Record<string, unknown>;
}): Promise<LinqMessageResult> {
  const result = await sendMessage(input.chatId, input.text);

  if (!result.messageId) {
    return result;
  }

  await db.messageContext.upsert({
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
