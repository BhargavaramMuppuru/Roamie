import { ParticipantStatus, Prisma, TripState } from "@prisma/client";
import { env } from "../config/env";
import { db } from "../db/client";
import { fetchChatRoster, fetchMessageSenderDisplayName } from "./linqClient";
import type { LinqWebhookEvent } from "../types/linq";
import { logger } from "../utils/logger";
import { normalizeParticipantId } from "../utils/userId";

export async function getTripByThreadId(threadId: string) {
  return db.trip.findUnique({
    where: { threadId },
    include: {
      participants: true,
      expenses: true,
    },
  });
}

export async function createTrip(input: {
  threadId: string;
  destination?: string;
  title?: string;
  budget?: number;
  startDate?: string;
  endDate?: string;
  createdBy?: string;
}) {
  return db.trip.create({
    data: {
      threadId: input.threadId,
      title: input.title,
      destination: input.destination,
      budget: input.budget,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      createdBy: input.createdBy,
      currentState: TripState.ATTENDANCE,
    },
  });
}

export async function updateTripDetails(
  tripId: string,
  input: {
    destination?: string;
    title?: string;
    budget?: number;
    startDate?: string;
    endDate?: string;
  },
) {
  return db.trip.update({
    where: { id: tripId },
    data: {
      title: input.title ?? undefined,
      destination: input.destination ?? undefined,
      budget: input.budget ?? undefined,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
    },
  });
}

export async function setTripFinalPlanningPick(tripId: string, pick: Prisma.InputJsonValue) {
  return db.trip.update({
    where: { id: tripId },
    data: { finalPlanningPick: pick },
  });
}

/** Overwrites `Participant.name` when Linq sends a display name (webhook or roster). */
export async function mergeParticipantDisplayName(tripId: string, userId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  await db.participant.updateMany({
    where: { tripId, userId },
    data: { name: trimmed },
  });
}

/**
 * Apply manual phone → name labels for people already on this trip (participant rows).
 * Unknown numbers are skipped — they usually need to appear in the chat once first.
 */
export async function applyContactNamesToTrip(
  tripId: string,
  pairs: Array<{ phone: string; name: string }>,
): Promise<{ savedLabels: string[]; notFoundPhones: string[] }> {
  const savedLabels: string[] = [];
  const notFoundPhones: string[] = [];
  for (const { phone, name } of pairs) {
    const uid = normalizeParticipantId(phone);
    const existing = await db.participant.findUnique({
      where: { tripId_userId: { tripId, userId: uid } },
    });
    if (!existing) {
      notFoundPhones.push(uid);
      continue;
    }
    await mergeParticipantDisplayName(tripId, uid, name);
    savedLabels.push(name.trim());
  }
  return { savedLabels, notFoundPhones };
}

/**
 * If the webhook omitted contact name, GET /messages/{id} may still include name-like
 * fields on `from_handle` (best-effort; often still phone-only).
 */
export async function enrichSenderDisplayNameFromLinqMessageApi(
  tripId: string,
  userId: string,
  event: LinqWebhookEvent,
): Promise<LinqWebhookEvent> {
  if (event.isFromMe) {
    return event;
  }
  if (event.sender_display_name?.trim()) {
    return event;
  }
  const mid = event.message_id;
  if (!mid) {
    return event;
  }
  const name = await fetchMessageSenderDisplayName(mid);
  if (!name?.trim()) {
    return event;
  }
  const uid = normalizeParticipantId(userId);
  await mergeParticipantDisplayName(tripId, uid, name.trim());
  return { ...event, sender_display_name: name.trim() };
}

/**
 * `participant.added` webhook (Linq SDK: `data.participant` is a `ChatHandle`, optional
 * contact fields at runtime). Upserts display name + phone when Linq includes them.
 */
export async function handleParticipantAddedWebhook(event: LinqWebhookEvent): Promise<void> {
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }
  const d = data as Record<string, unknown>;
  const chatId = typeof d.chat_id === "string" ? d.chat_id.trim() : "";
  if (!chatId) {
    return;
  }

  const trip = await getTripByThreadId(chatId);
  if (!trip) {
    return;
  }

  const participant = d.participant;
  let handleStr: string | undefined;
  let name: string | undefined;

  if (participant && typeof participant === "object") {
    const p = participant as Record<string, unknown>;
    handleStr = typeof p.handle === "string" ? p.handle.trim() : undefined;
    name =
      (typeof p.name === "string" && p.name.trim()) ||
      (typeof p.display_name === "string" && p.display_name.trim()) ||
      (typeof p.displayName === "string" && p.displayName.trim()) ||
      undefined;
  }
  if (!handleStr && typeof d.handle === "string") {
    handleStr = d.handle.trim();
  }

  if (!handleStr) {
    logger.debug("participant.added: no handle", { chatId });
    return;
  }

  const uid = normalizeParticipantId(handleStr);
  const botId = normalizeParticipantId(env.LINQ_FROM_PHONE);
  if (uid === botId) {
    return;
  }

  const phone = uid.startsWith("+") ? uid : undefined;

  if (!name?.trim()) {
    logger.debug("participant.added: no display name on payload", { chatId, userId: uid });
    return;
  }

  const trimmed = name.trim();
  await db.participant.upsert({
    where: { tripId_userId: { tripId: trip.id, userId: uid } },
    create: {
      tripId: trip.id,
      userId: uid,
      name: trimmed,
      phoneNumber: phone,
      status: ParticipantStatus.PENDING,
      arrivalNote: "Joined chat",
    },
    update: {
      name: trimmed,
      ...(phone ? { phoneNumber: phone } : {}),
    },
  });
}

/**
 * Persists `sender_handle.name` / `chat.participants[].name` from a normalized Linq event
 * onto existing trip participants.
 */
export async function applyLinqParticipantNamesToTrip(tripId: string, event: LinqWebhookEvent): Promise<void> {
  const chat = event.chat ?? event.data?.chat;
  const participants = chat?.participants;
  if (participants?.length) {
    for (const p of participants) {
      const raw = p.user_id ?? p.handle;
      if (!raw) {
        continue;
      }
      const uid = normalizeParticipantId(raw);
      const n = p.name?.trim() || p.display_name?.trim();
      if (!n) {
        continue;
      }
      await mergeParticipantDisplayName(tripId, uid, n);
    }
  }

  const sender = event.sender_display_name?.trim();
  const sid = event.user_id ?? event.handle;
  if (sender && sid) {
    await mergeParticipantDisplayName(tripId, normalizeParticipantId(sid), sender);
  }
}

const rosterHydrateAt = new Map<string, number>();
const ROSTER_HYDRATE_MS = 90_000;

/**
 * Fetches chat roster from Linq (names often omitted on each webhook) and upserts
 * participants so settle-up / polls show contact names. Debounced per thread.
 */
export async function hydrateParticipantNamesFromLinqChatIfStale(
  tripId: string,
  threadId: string,
  options?: { force?: boolean },
): Promise<void> {
  const now = Date.now();
  if (!options?.force) {
    const last = rosterHydrateAt.get(threadId) ?? 0;
    if (now - last < ROSTER_HYDRATE_MS) {
      return;
    }
  }
  rosterHydrateAt.set(threadId, now);

  const roster = await fetchChatRoster(threadId);
  const botId = normalizeParticipantId(env.LINQ_FROM_PHONE);

  for (const p of roster) {
    const raw = p.user_id ?? p.handle;
    if (!raw) {
      continue;
    }
    const uid = normalizeParticipantId(raw);
    if (uid === botId) {
      continue;
    }
    const n = p.name?.trim() || p.display_name?.trim();
    if (!n) {
      continue;
    }
    const phone = uid.startsWith("+") ? uid : undefined;
    await db.participant.updateMany({
      where: { tripId, userId: uid },
      data: {
        name: n,
        ...(phone ? { phoneNumber: phone } : {}),
      },
    });
  }
}

/** Ensures the sender has a Participant row and merges phone / display name from the webhook. */
export async function ensureParticipantFromInboundEvent(
  tripId: string,
  userId: string,
  event: LinqWebhookEvent,
): Promise<void> {
  const name = event.sender_display_name?.trim();
  const phone = userId.startsWith("+") ? userId : undefined;
  const existing = await db.participant.findUnique({
    where: { tripId_userId: { tripId, userId } },
  });
  if (!existing) {
    await db.participant.create({
      data: {
        tripId,
        userId,
        name: name || undefined,
        phoneNumber: phone,
        status: ParticipantStatus.PENDING,
        arrivalNote: "Seen in chat",
      },
    });
    return;
  }
  const patch: { name?: string; phoneNumber?: string } = {};
  if (name && !existing.name?.trim()) {
    patch.name = name;
  }
  if (phone && !existing.phoneNumber?.trim()) {
    patch.phoneNumber = phone;
  }
  if (Object.keys(patch).length > 0) {
    await db.participant.update({
      where: { tripId_userId: { tripId, userId } },
      data: patch,
    });
  }
}

/** Ensures a participant row exists before vote labels (user may only reply `1` / `2` / `3`). */
export async function ensureParticipantStub(tripId: string, userId: string): Promise<void> {
  const phone = userId.startsWith("+") ? userId : undefined;
  await db.participant.upsert({
    where: { tripId_userId: { tripId, userId } },
    create: {
      tripId,
      userId,
      phoneNumber: phone,
      status: ParticipantStatus.PENDING,
      arrivalNote: "Poll vote",
    },
    update: {
      ...(phone ? { phoneNumber: phone } : {}),
    },
  });
}

export async function upsertParticipant(input: {
  tripId: string;
  userId: string;
  name?: string;
  phoneNumber?: string;
  subgroupTag?: string | null;
  arrivalNote?: string;
  status: ParticipantStatus;
}) {
  return db.participant.upsert({
    where: {
      tripId_userId: {
        tripId: input.tripId,
        userId: input.userId,
      },
    },
    update: {
      name: input.name,
      phoneNumber: input.phoneNumber,
      subgroupTag: input.subgroupTag === undefined ? undefined : input.subgroupTag,
      arrivalNote: input.arrivalNote,
      status: input.status,
    },
    create: {
      tripId: input.tripId,
      userId: input.userId,
      name: input.name,
      phoneNumber: input.phoneNumber,
      subgroupTag: input.subgroupTag ?? undefined,
      arrivalNote: input.arrivalNote,
      status: input.status,
    },
  });
}

export async function appendItineraryNotes(tripId: string, line: string) {
  const trip = await db.trip.findUnique({ where: { id: tripId } });
  const prev = trip?.itineraryNotes ?? "";
  const bullet = line.trim();
  const next = prev ? `${prev}\n• ${bullet}` : `• ${bullet}`;
  return db.trip.update({
    where: { id: tripId },
    data: { itineraryNotes: next },
  });
}

export async function moveTripToState(tripId: string, state: TripState) {
  return db.trip.update({
    where: { id: tripId },
    data: { currentState: state },
  });
}
