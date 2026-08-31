import { Prisma } from "@prisma/client";
import { db } from "../db/client";

/**
 * Atomically records that we are handling this webhook event. Call once at the
 * start of handling so duplicate deliveries (e.g. while outbound sends retry)
 * are ignored without re-running the state machine.
 */
export async function claimEvent(eventId?: string): Promise<boolean> {
  if (!eventId) {
    return true;
  }

  try {
    await db.processedEvent.create({
      data: { eventId },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

export async function isDuplicate(eventId?: string): Promise<boolean> {
  if (!eventId) {
    return false;
  }

  const existing = await db.processedEvent.findUnique({
    where: { eventId },
  });

  return Boolean(existing);
}

export async function markProcessed(eventId?: string): Promise<void> {
  if (!eventId) {
    return;
  }

  await db.processedEvent.create({
    data: { eventId },
  });
}
