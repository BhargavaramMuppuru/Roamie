import { MessageAction, ParticipantStatus, TripState } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import type { LinqWebhookEvent } from "../types/linq";
import { messageLooksLikeTripPlanningDetail } from "../utils/planningHeuristics";
import { messageBlocks } from "../utils/chatCopy";
import { normalizeParticipantId } from "../utils/userId";
import { formatExpenseBudgetFollowUp, getBudgetStatus } from "./budgetService";
import {
  buildDefaultActivityOptions,
  buildDefaultFoodOptions,
  renderHotelVoteMessage,
  renderOptionPollLines,
} from "./hotelService";
import type { ParsedIntent } from "./intentService";
import { parseIntent, ruleBasedIntent } from "./intentService";
import {
  addExpense,
  deleteExpenseForTrip,
  recordPartialPayment,
  resolveMutableExpense,
  SPLIT_PAY_EPS,
  updateExpenseForTrip,
} from "./ledgerService";
import { resolveParticipantsByNames } from "./participantNameResolve";
import {
  extractTripPlanningPatch,
  generateHotelAlternativesFromAi,
  generateItineraryNarrative,
  generateContextualReply,
  generateOptionPollFromAi,
  type TripPlanningPatch,
} from "./openaiTripContent";
import { renderStarterItinerary } from "./itineraryService";
import { fetchTripWeatherSummary, formatTripWeatherChatReply } from "./weatherService";
import { createChat, startTypingIndicator } from "./linqClient";
import {
  listReceiptImageCandidates,
  parseReceiptImageUrl,
} from "./receiptParseService";
import { transcribeVoiceAudioUrl } from "./voiceTranscriptionService";
import { finalizeOptionPoll, recordOptionPollVote, tryHandleRsvpTextReply } from "./pollService";
import { sendPlainMessage, sendTrackedMessage } from "./notificationService";
import { buildGroupSplitHistoryText, buildUserSplitHistoryText } from "./splitHistoryService";
import { getParticipantDisplayLabel, renderSettlementSummary } from "./settlementService";
import { buildTripClosureMessage } from "./tripClosureService";
import {
  appendItineraryNotes,
  applyContactNamesToTrip,
  applyLinqParticipantNamesToTrip,
  enrichSenderDisplayNameFromLinqMessageApi,
  ensureParticipantFromInboundEvent,
  hydrateParticipantNamesFromLinqChatIfStale,
  createTrip,
  getTripByThreadId,
  moveTripToState,
  mergeParticipantDisplayName,
  updateTripDetails,
  upsertParticipant,
} from "./tripService";

/** Linq `sender_handle.name` / roster names — stored on Participant for display in replies. */
function senderProfileFromEvent(event: LinqWebhookEvent): { name?: string } {
  const n = event.sender_display_name?.trim();
  return n ? { name: n } : {};
}

function getThreadId(event: LinqWebhookEvent): string | undefined {
  return event.thread_id ?? event.chat_id;
}

function getUserId(event: LinqWebhookEvent): string {
  const raw = event.user_id ?? event.handle ?? "unknown";
  return normalizeParticipantId(raw);
}

/** True when the whole message is only a thumb up/down emoji (text message, not a reaction). */
function formatTripDates(start?: Date | null, end?: Date | null): string {
  if (!start && !end) {
    return "TBD";
  }
  const a = start ? start.toISOString().slice(0, 10) : "?";
  const b = end ? end.toISOString().slice(0, 10) : "?";
  return `${a} → ${b}`;
}

function isStandaloneThumbEmoji(text: string): boolean {
  const t = text.trim();
  return (
    /^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u.test(t) ||
    /^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿)$/u.test(t)
  );
}

/**
 * Group chat: treat a message as addressed to Roamie if "roamie" appears anywhere (not only at the start).
 * Strip @Roamie / Roamie tokens for intent parsing.
 */
function messageMentionsRoamie(text: string): { rest: string; hadRoamie: boolean } {
  const t = text.trim();
  if (!/\broamie\b/i.test(t)) {
    return { rest: t, hadRoamie: false };
  }
  const rest = t
    .replace(/\s*@?roamie\b[\s,:]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { rest: rest.length > 0 ? rest : t.trim(), hadRoamie: true };
}

async function buildInboundMessageText(event: LinqWebhookEvent): Promise<string> {
  const base = event.text ?? event.message?.body ?? "";
  const bits: string[] = [];
  if (base.trim()) {
    bits.push(base.trim());
  }

  let voiceTranscript: string | undefined;
  const voiceUrl = event.voiceUrls?.[0];
  if (voiceUrl) {
    voiceTranscript = (await transcribeVoiceAudioUrl(voiceUrl)) ?? undefined;
  }
  if (voiceTranscript) {
    bits.push(voiceTranscript);
  } else if (event.hasVoiceAttachment) {
    bits.push("[voice note — send text if you need a precise split]");
  }

  if ((event.mediaUrls?.length ?? 0) > 0 && !base.trim() && !voiceTranscript) {
    bits.push("[image attached]");
  }
  return bits.join(" ").trim();
}

/** Receipt OCR can promote UNKNOWN → ADD_EXPENSE in any phase where expenses may be logged. */
const TRIP_STATES_FOR_RECEIPT_PARSE: readonly TripState[] = [
  TripState.ATTENDANCE,
  TripState.PLANNING,
  TripState.ITINERARY,
  TripState.ACTIVE,
  TripState.SETTLEMENT,
];

async function mergeReceiptExpenseIntent(
  intent: ParsedIntent,
  event: LinqWebhookEvent,
  trip: NonNullable<Awaited<ReturnType<typeof getTripByThreadId>>>,
): Promise<{ intent: ParsedIntent; receiptImageUrl?: string }> {
  if (!TRIP_STATES_FOR_RECEIPT_PARSE.includes(trip.currentState) || !env.RECEIPT_PARSE_ENABLED) {
    return { intent };
  }
  const candidates = listReceiptImageCandidates(event.mediaUrls);
  if (candidates.length === 0) {
    return { intent };
  }

  for (const url of candidates) {
    const guess = await parseReceiptImageUrl(url);
    if (!guess?.amount) {
      continue;
    }
    if (intent.intent === "ADD_EXPENSE") {
      return {
        intent: {
          ...intent,
          amount: intent.amount ?? guess.amount,
          description: intent.description ?? guess.merchant ?? "receipt",
        },
        receiptImageUrl: url,
      };
    }
    if (intent.intent === "UNKNOWN") {
      return {
        intent: {
          intent: "ADD_EXPENSE",
          amount: guess.amount,
          description: guess.merchant ?? "receipt",
        },
        receiptImageUrl: url,
      };
    }
    return { intent };
  }

  return { intent };
}

function distributeEqualCents(totalCents: number, n: number): number[] {
  if (n <= 0) {
    return [];
  }
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const out = Array.from({ length: n }, () => base);
  for (let i = 0; i < remainder; i++) {
    out[i] += 1;
  }
  return out;
}

async function logExpenseForTrip(params: {
  tripId: string;
  userId: string;
  intent: ParsedIntent;
  receiptUrl?: string;
}): Promise<string> {
  const { tripId, userId, intent, receiptUrl } = params;
  if (!intent.amount || !intent.description) {
    return "";
  }

  if (intent.splitExplicitAmounts && intent.splitExplicitAmounts.length >= 2) {
    const pairs = intent.splitExplicitAmounts;
    const sumS = pairs.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(sumS - intent.amount) > 0.05) {
      return `Those shares add up to $${sumS.toFixed(2)} but the expense total is $${intent.amount.toFixed(2)}.`;
    }
    const rows: Array<{ userId: string; shareAmount: number }> = [];
    for (const p of pairs) {
      const r = await resolveParticipantsByNames(tripId, [p.name]);
      if (r.unmatched.length > 0) {
        return `Couldn’t match “${p.name}” — check spelling.`;
      }
      const uid = r.userIds[0];
      if (uid === userId) {
        continue;
      }
      rows.push({ userId: uid, shareAmount: p.amount });
    }
    if (rows.length === 0) {
      return `Include only people who owe you — don’t list yourself in the split amounts.`;
    }
    const sumRows = rows.reduce((s, r) => s + r.shareAmount, 0);
    if (Math.abs(sumRows - intent.amount) > 0.05) {
      return `After removing your line, shares add to $${sumRows.toFixed(2)} but the expense is $${intent.amount.toFixed(2)}. Adjust the numbers.`;
    }

    const { usedSubgroupFallback } = await addExpense({
      tripId,
      paidByUserId: userId,
      amount: intent.amount,
      description: intent.description,
      subgroupLabel: intent.subgroupLabel,
      customSplits: rows,
      receiptUrl,
    });

    const breakdown = await Promise.all(
      rows.map(async (row) => {
        const label = await getParticipantDisplayLabel(tripId, row.userId);
        return `${label} $${row.shareAmount.toFixed(2)}`;
      }),
    );

    let msg = `Logged ${intent.description} for $${intent.amount.toFixed(2)} (split: ${breakdown.join(", ")})`;
    if (usedSubgroupFallback && intent.subgroupLabel) {
      msg += `. No one was tagged “${intent.subgroupLabel}” — split among all confirmed for now.`;
    }
    if (receiptUrl) {
      msg += " Receipt linked.";
    }
    return msg;
  }

  if (intent.splitBonuses?.length && !intent.splitAmongNames?.length) {
    return `Say who splits the base first (e.g. “$20 uber split between Sam and Jordan”), then add-ons like “for Jordan +$10”.`;
  }

  let splitAmongUserIds: string[] | undefined;
  if (intent.splitAmongNames?.length) {
    const { userIds, unmatched } = await resolveParticipantsByNames(tripId, intent.splitAmongNames);
    if (unmatched.length > 0) {
      return `Couldn’t match these names to confirmed travelers: ${unmatched.join(", ")}. Use names from the trip or +phone numbers.`;
    }
    const owe = userIds.filter((id) => id !== userId);
    if (owe.length === 0) {
      return `Add at least one other person who owes their share. You paid, so you aren’t included in the split — list who should owe (e.g. “uber $20 for Sam and Jordan”).`;
    }
    splitAmongUserIds = owe;

    if (intent.splitBonuses?.length) {
      const baseCents = Math.round(intent.amount * 100);
      const bases = distributeEqualCents(baseCents, owe.length);
      const shareCents = new Map<string, number>();
      owe.forEach((id, i) => {
        shareCents.set(id, bases[i] ?? 0);
      });

      for (const b of intent.splitBonuses) {
        const r = await resolveParticipantsByNames(tripId, [b.name]);
        if (r.unmatched.length > 0) {
          return `Couldn’t match “${b.name}” for the extra amount — check spelling.`;
        }
        const uid = r.userIds[0];
        if (!owe.includes(uid)) {
          return `“${b.name}” must be one of the people splitting this expense (the payer isn’t included).`;
        }
        shareCents.set(uid, (shareCents.get(uid) ?? 0) + Math.round(b.addAmount * 100));
      }

      const finalCents = Array.from(shareCents.values()).reduce((a, b) => a + b, 0);
      const customSplits = owe.map((id) => ({
        userId: id,
        shareAmount: (shareCents.get(id) ?? 0) / 100,
      }));

      const { usedSubgroupFallback, splitCount } = await addExpense({
        tripId,
        paidByUserId: userId,
        amount: finalCents / 100,
        description: intent.description,
        subgroupLabel: intent.subgroupLabel,
        customSplits,
        receiptUrl,
      });

      const breakdown = await Promise.all(
        owe.map(async (id) => {
          const row = customSplits.find((c) => c.userId === id);
          const label = await getParticipantDisplayLabel(tripId, id);
          return `${label} $${(row?.shareAmount ?? 0).toFixed(2)}`;
        }),
      );

      let msg = `Logged ${intent.description} for $${(finalCents / 100).toFixed(2)} (split: ${breakdown.join(", ")})`;
      if (usedSubgroupFallback && intent.subgroupLabel) {
        msg += `. No one was tagged “${intent.subgroupLabel}” — split among all confirmed for now.`;
      }
      if (receiptUrl) {
        msg += " Receipt linked.";
      }
      return msg;
    }
  }

  const { usedSubgroupFallback, splitCount } = await addExpense({
    tripId,
    paidByUserId: userId,
    amount: intent.amount,
    description: intent.description,
    subgroupLabel: intent.subgroupLabel,
    splitAmongUserIds,
    receiptUrl,
  });
  let msg = `Logged ${intent.description} for $${intent.amount.toFixed(2)}`;
  if (splitCount > 0) {
    msg += ` (split ${splitCount} way${splitCount === 1 ? "" : "s"}`;
    if (splitAmongUserIds?.length) {
      const labels = await Promise.all(splitAmongUserIds.map((id) => getParticipantDisplayLabel(tripId, id)));
      msg +=
        labels.length === 1
          ? ` — ${labels[0]} owes you`
          : ` — ${labels.join(", ")} owe you`;
    }
    msg += ")";
  }
  if (usedSubgroupFallback && intent.subgroupLabel) {
    msg += `. No one was tagged “${intent.subgroupLabel}” — split among all confirmed for now.`;
  }
  if (receiptUrl) {
    msg += " Receipt linked.";
  }
  return msg;
}

async function handleAttendance(tripId: string, userId: string, text: string, status: ParticipantStatus) {
  await upsertParticipant({
    tripId,
    userId,
    status,
    arrivalNote: text,
  });
}

async function handleAttendanceReply(input: {
  tripId: string;
  threadId: string;
  userId: string;
  text: string;
  intent: ParsedIntent;
}) {
  if (input.intent.intent === "CONFIRM_ATTENDANCE") {
    await handleAttendance(
      input.tripId,
      input.userId,
      input.intent.arrivalNote ?? input.text,
      ParticipantStatus.CONFIRMED,
    );
    await sendBestEffortReply(input.threadId, "You’re in. I’ve got your attendance down.");
    return true;
  }

  if (input.intent.intent === "DECLINE_ATTENDANCE") {
    await handleAttendance(input.tripId, input.userId, input.text, ParticipantStatus.DECLINED);
    await sendBestEffortReply(input.threadId, "Got it — I marked you as out for this trip.");
    return true;
  }

  return false;
}

async function sendBestEffortReply(chatId: string, text: string) {
  try {
    await sendPlainMessage(chatId, text);
  } catch (error) {
    logger.error("Outgoing Linq reply failed", error);
  }
}

/** After an expense is persisted, append real-time budget pacing (and threshold / over-budget lines when relevant). */
async function sendExpenseLineWithBudget(
  threadId: string,
  tripId: string,
  expenseLine: string,
  expenseAmount: number,
) {
  const status = await getBudgetStatus(tripId, { expenseAmountJustAdded: expenseAmount });
  if (!status) {
    await sendBestEffortReply(threadId, expenseLine);
    return;
  }
  await sendBestEffortReply(threadId, `${expenseLine}\n\n${formatExpenseBudgetFollowUp(status)}`);
}

async function sendBestEffortTrackedReply(input: Parameters<typeof sendTrackedMessage>[0]) {
  try {
    await sendTrackedMessage(input);
  } catch (error) {
    logger.error("Outgoing tracked Linq reply failed", error);
  }
}

function hasTripPlanningData(patch: TripPlanningPatch): boolean {
  return Boolean(
    patch.destination?.trim() ||
      (patch.budget != null && !Number.isNaN(Number(patch.budget))) ||
      patch.startDate?.trim() ||
      patch.endDate?.trim() ||
      patch.appendItineraryNote?.trim(),
  );
}

async function applyTripPlanningPatchToDb(tripId: string, patch: TripPlanningPatch): Promise<void> {
  const detail: Parameters<typeof updateTripDetails>[1] = {};
  if (patch.destination?.trim()) {
    detail.destination = patch.destination.trim();
  }
  if (patch.budget != null && !Number.isNaN(Number(patch.budget))) {
    detail.budget = Number(patch.budget);
  }
  if (patch.startDate?.trim()) {
    detail.startDate = patch.startDate.trim();
  }
  if (patch.endDate?.trim()) {
    detail.endDate = patch.endDate.trim();
  }

  if (Object.keys(detail).length > 0) {
    await updateTripDetails(tripId, detail);
  }
  if (patch.appendItineraryNote?.trim()) {
    await appendItineraryNotes(tripId, patch.appendItineraryNote.trim());
  }
}

async function captureTripPlanningDetailsFromMessage(
  tripId: string,
  message: string,
  trip: NonNullable<Awaited<ReturnType<typeof getTripByThreadId>>>,
  parsedIntent: ParsedIntent,
): Promise<void> {
  const fromAi = parsedIntent.tripPlanningExtract;
  if (fromAi && hasTripPlanningData(fromAi)) {
    await applyTripPlanningPatchToDb(tripId, fromAi);
    return;
  }

  if (!messageLooksLikeTripPlanningDetail(message)) {
    return;
  }

  const patch = await extractTripPlanningPatch({
    message,
    existingDestination: trip.destination,
    existingBudget: trip.budget,
    existingStart: trip.startDate ? trip.startDate.toISOString().slice(0, 10) : null,
    existingEnd: trip.endDate ? trip.endDate.toISOString().slice(0, 10) : null,
    existingNotes: trip.itineraryNotes,
  });

  if (!patch || !hasTripPlanningData(patch)) {
    return;
  }

  await applyTripPlanningPatchToDb(tripId, patch);
}

async function applyTripDetailsUpdate(input: {
  tripId: string;
  threadId: string;
  intent: ParsedIntent;
  currentState: TripState;
}) {
  await updateTripDetails(input.tripId, {
    title: input.intent.title,
    destination: input.intent.destination,
    budget: input.intent.budget,
    startDate: input.intent.startDate,
    endDate: input.intent.endDate,
  });

  if (input.currentState === TripState.ATTENDANCE) {
    await sendBestEffortTrackedReply({
      chatId: input.threadId,
      tripId: input.tripId,
      actionType: MessageAction.ATTENDANCE_CONFIRM,
      text: messageBlocks(
        "Updated the trip details.",
        "Next up is headcount: react 👍 if you’re in or 👎 if you’re out, or just reply yes/no.",
        "Optional: “my name is …” or “names: +1… — Sam, +1… — Jordan” so we’re not phone-only.",
      ),
      payload: {
        kind: "attendance_confirm",
      },
    });
    return;
  }

  await sendBestEffortReply(input.threadId, "Updated the trip details.");
}

async function sendHotelOptionsForTrip(input: {
  tripId: string;
  threadId: string;
  destination?: string | null;
  budget?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
}) {
  const hotelVote = renderHotelVoteMessage({
    destination: input.destination,
    budget: input.budget,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  await sendBestEffortTrackedReply({
    chatId: input.threadId,
    tripId: input.tripId,
    actionType: MessageAction.HOTEL_VOTE,
    text: hotelVote.text,
    payload: {
      kind: "option_poll",
      pollKind: "stay",
      options: hotelVote.options,
      votes: {},
    },
  });
}

type TripRecord = NonNullable<Awaited<ReturnType<typeof getTripByThreadId>>>;

const ARRIVAL_NOTE_BOILERPLATE = /^(trip creator|invited|invite pending)/i;

/** Confirmed participants only; skips default invite/creator strings so the model sees real timing notes. */
function buildParticipantArrivalSummary(participants: TripRecord["participants"]): string | undefined {
  const lines: string[] = [];
  for (const p of participants) {
    if (p.status !== ParticipantStatus.CONFIRMED) {
      continue;
    }
    const note = p.arrivalNote?.trim();
    if (!note || note.length < 3) {
      continue;
    }
    if (ARRIVAL_NOTE_BOILERPLATE.test(note)) {
      continue;
    }
    const label = p.name?.trim() || p.phoneNumber?.trim() || p.userId;
    lines.push(`${label}: ${note}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

async function sendItineraryForTrip(input: {
  threadId: string;
  destination?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  itineraryNotes?: string | null;
  budget?: number | null;
  participants?: TripRecord["participants"];
}) {
  await startTypingIndicator(input.threadId);
  const arrivalSummary = input.participants?.length
    ? buildParticipantArrivalSummary(input.participants)
    : undefined;
  const aiText = await generateItineraryNarrative({
    destination: input.destination,
    startDate: input.startDate,
    endDate: input.endDate,
    budget: input.budget,
    itineraryNotes: input.itineraryNotes,
    participantArrivalSummary: arrivalSummary,
  });

  let body =
    aiText ??
    renderStarterItinerary({
      destination: input.destination,
      startDate: input.startDate,
      endDate: input.endDate,
      itineraryNotes: input.itineraryNotes,
    });

  if (aiText && input.itineraryNotes?.trim()) {
    body = `${body}\n\nGroup itinerary notes:\n${input.itineraryNotes.trim()}`;
  }

  if (!aiText && input.destination?.trim()) {
    const wx = await fetchTripWeatherSummary({
      destination: input.destination,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (wx) {
      body = `${body}\n\n${wx}`;
    }
  }

  await sendBestEffortReply(input.threadId, body);
}

async function sendMealRsvpPoll(input: { tripId: string; threadId: string; title: string }) {
  const title = input.title.trim() || "Group meal";
  const text = messageBlocks(
    `RSVP — ${title}`,
    "Reply IN or OUT (👍 / 👎 on this message works too). I’ll keep a running headcount.",
  );
  await sendBestEffortTrackedReply({
    chatId: input.threadId,
    tripId: input.tripId,
    actionType: MessageAction.RSVP_POLL,
    text,
    payload: {
      kind: "rsvp",
      title,
      votes: {},
    },
  });
}

async function sendFoodOptionPoll(trip: TripRecord, threadId: string, userMessage: string, preferFreshAi: boolean) {
  if (trip.currentState === TripState.ATTENDANCE) {
    await moveTripToState(trip.id, TripState.PLANNING);
  }
  const hint = preferFreshAi ? userMessage : userMessage || "Places to eat as a group";
  await startTypingIndicator(threadId);
  const ai = await generateOptionPollFromAi({
    variant: "food",
    destination: trip.destination,
    budget: trip.budget,
    startDate: trip.startDate,
    endDate: trip.endDate,
    userMessage: hint,
  });
  let options;
  let text: string;
  if (ai) {
    options = ai.options;
    text = ai.text;
  } else {
    options = buildDefaultFoodOptions(trip.destination);
    text = renderOptionPollLines({
      intro: `Food poll for ${trip.destination ?? "the trip"}:`,
      options,
      pollKind: "food",
    });
  }
  await sendBestEffortTrackedReply({
    chatId: threadId,
    tripId: trip.id,
    actionType: MessageAction.HOTEL_VOTE,
    text,
    payload: {
      kind: "option_poll",
      pollKind: "food",
      options,
      votes: {},
    },
  });
}

async function sendActivityOptionPoll(trip: TripRecord, threadId: string, userMessage: string, preferFreshAi: boolean) {
  if (trip.currentState === TripState.ATTENDANCE) {
    await moveTripToState(trip.id, TripState.PLANNING);
  }
  const hint = preferFreshAi ? userMessage : userMessage || "Things to do as a group";
  await startTypingIndicator(threadId);
  const ai = await generateOptionPollFromAi({
    variant: "activity",
    destination: trip.destination,
    budget: trip.budget,
    startDate: trip.startDate,
    endDate: trip.endDate,
    userMessage: hint,
  });
  let options;
  let text: string;
  if (ai) {
    options = ai.options;
    text = ai.text;
  } else {
    options = buildDefaultActivityOptions(trip.destination);
    text = renderOptionPollLines({
      intro: `Activity poll for ${trip.destination ?? "the trip"}:`,
      options,
      pollKind: "activity",
    });
  }
  await sendBestEffortTrackedReply({
    chatId: threadId,
    tripId: trip.id,
    actionType: MessageAction.HOTEL_VOTE,
    text,
    payload: {
      kind: "option_poll",
      pollKind: "activity",
      options,
      votes: {},
    },
  });
}

type TripMessageContext = {
  trip: TripRecord;
  threadId: string;
  userId: string;
  intent: ParsedIntent;
  receiptUrl?: string;
  userMessage: string;
};

async function moveTripToActiveWithExpense(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent !== "ADD_EXPENSE" || !context.intent.amount || !context.intent.description) {
    return false;
  }

  await moveTripToState(context.trip.id, TripState.ACTIVE);
  const line = await logExpenseForTrip({
    tripId: context.trip.id,
    userId: context.userId,
    intent: context.intent,
    receiptUrl: context.receiptUrl,
  });
  await sendExpenseLineWithBudget(context.threadId, context.trip.id, `Trip is live now. ${line}`, context.intent.amount);
  return true;
}

async function handleAttendancePhase(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent === "REQUEST_HOTELS" || context.intent.intent === "ADVANCE_STAGE") {
    await moveTripToState(context.trip.id, TripState.PLANNING);
    await sendHotelOptionsForTrip({
      tripId: context.trip.id,
      threadId: context.threadId,
      destination: context.trip.destination,
      budget: context.trip.budget,
      startDate: context.trip.startDate,
      endDate: context.trip.endDate,
    });
    return true;
  }

  return moveTripToActiveWithExpense(context);
}

async function handlePlanningPhase(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent === "REQUEST_ITINERARY" || context.intent.intent === "ADVANCE_STAGE") {
    await moveTripToState(context.trip.id, TripState.ITINERARY);
    await sendItineraryForTrip({
      threadId: context.threadId,
      destination: context.trip.destination,
      startDate: context.trip.startDate,
      endDate: context.trip.endDate,
      itineraryNotes: context.trip.itineraryNotes,
      budget: context.trip.budget,
      participants: context.trip.participants,
    });
    return true;
  }

  return moveTripToActiveWithExpense(context);
}

async function handleItineraryPhase(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent === "START_TRIP" || context.intent.intent === "ADVANCE_STAGE") {
    await moveTripToState(context.trip.id, TripState.ACTIVE);
    await sendBestEffortReply(
      context.threadId,
      "Trip is now active. Send expenses, quick updates, or ask for settle-up anytime.",
    );
    return true;
  }

  return moveTripToActiveWithExpense(context);
}

async function handleActivePhase(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent === "REQUEST_SETTLEMENT") {
    await moveTripToState(context.trip.id, TripState.SETTLEMENT);
    await sendBestEffortReply(context.threadId, await renderSettlementSummary(context.trip.id));
    return true;
  }

  if (context.intent.intent === "ADD_EXPENSE" && context.intent.amount && context.intent.description) {
    const line = await logExpenseForTrip({
      tripId: context.trip.id,
      userId: context.userId,
      intent: context.intent,
      receiptUrl: context.receiptUrl,
    });

    await sendExpenseLineWithBudget(context.threadId, context.trip.id, line, context.intent.amount);
    return true;
  }

  if (context.intent.intent === "MARK_PAID") {
    await moveTripToState(context.trip.id, TripState.SETTLEMENT);
    await sendBestEffortTrackedReply({
      chatId: context.threadId,
      tripId: context.trip.id,
      actionType: MessageAction.PAYMENT_CONFIRM,
      text: "We’re moving into settle-up mode. React 👍 on this message once you’ve paid.",
      payload: {
        kind: "payment_confirm",
      },
    });
    return true;
  }

  return false;
}

async function handleSettlementPhase(context: TripMessageContext): Promise<boolean> {
  if (context.intent.intent === "REQUEST_SETTLEMENT") {
    await sendBestEffortReply(context.threadId, await renderSettlementSummary(context.trip.id));
    return true;
  }

  if (context.intent.intent === "ADD_EXPENSE" && context.intent.amount && context.intent.description) {
    const line = await logExpenseForTrip({
      tripId: context.trip.id,
      userId: context.userId,
      intent: context.intent,
      receiptUrl: context.receiptUrl,
    });
    await sendExpenseLineWithBudget(context.threadId, context.trip.id, line, context.intent.amount);
    return true;
  }

  if (context.intent.intent === "MARK_PAID") {
    await sendBestEffortTrackedReply({
      chatId: context.threadId,
      tripId: context.trip.id,
      actionType: MessageAction.PAYMENT_CONFIRM,
      text: "Got it. React 👍 on this message once the transfer is done.",
      payload: {
        kind: "payment_confirm",
        requestedBy: context.userId,
      },
    });
    return true;
  }

  if (context.intent.intent === "ADVANCE_STAGE" || context.intent.intent === "CLOSE_TRIP") {
    await moveTripToState(context.trip.id, TripState.CLOSED);
    const closureText = await buildTripClosureMessage(context.trip.id);
    await sendBestEffortReply(context.threadId, closureText);
    return true;
  }

  return false;
}

export async function runStateMachine(incoming: LinqWebhookEvent) {
  let event = incoming;
  const threadId = getThreadId(event);
  if (!threadId) {
    return;
  }

  const userId = getUserId(event);
  const baseText = (event.text ?? event.message?.body ?? "").trim();
  const gateText = baseText;
  let trip = await getTripByThreadId(threadId);

  const { rest: restAfterRoamie, hadRoamie } = messageMentionsRoamie(gateText);
  const quickRules = ruleBasedIntent(gateText);
  const allowBarePollReply = trip?.currentState !== TripState.CLOSED && /^\s*[123]\s*$/.test(gateText);
  const hasAttachmentInput =
    Boolean(event.hasVoiceAttachment) || (event.voiceUrls?.length ?? 0) > 0 || (event.mediaUrls?.length ?? 0) > 0;
  const allowUnprefixedAttachmentInput = trip?.currentState !== TripState.CLOSED && hasAttachmentInput;
  const allowBareRsvpReply =
    trip?.currentState !== TripState.CLOSED &&
    quickRules != null &&
    (quickRules.intent === "CONFIRM_ATTENDANCE" || quickRules.intent === "DECLINE_ATTENDANCE");
  const attendanceUnprefixed =
    trip?.currentState === TripState.ATTENDANCE &&
    !hadRoamie &&
    quickRules != null &&
    (quickRules.intent === "CONFIRM_ATTENDANCE" || quickRules.intent === "DECLINE_ATTENDANCE");

  if (
    !hadRoamie &&
    !attendanceUnprefixed &&
    !allowBarePollReply &&
    !allowBareRsvpReply &&
    !allowUnprefixedAttachmentInput
  ) {
    return;
  }

  if (trip) {
    event = await enrichSenderDisplayNameFromLinqMessageApi(trip.id, userId, event);
    await applyLinqParticipantNamesToTrip(trip.id, event);
    await ensureParticipantFromInboundEvent(trip.id, userId, event);
    await hydrateParticipantNamesFromLinqChatIfStale(trip.id, threadId);
  }

  const compositeText = await buildInboundMessageText(event);

  if (trip && trip.currentState !== TripState.CLOSED) {
    const onlyDigit = compositeText.match(/^\s*([123])\s*$/);
    if (onlyDigit) {
      const picked = await recordOptionPollVote({
        tripId: trip.id,
        threadId,
        userId,
        choice: Number(onlyDigit[1]) as 1 | 2 | 3,
      });
      if (picked) {
        return;
      }
    }
    if (await tryHandleRsvpTextReply({ tripId: trip.id, threadId, userId, text: compositeText })) {
      return;
    }
  }

  const textForIntent = hadRoamie ? (restAfterRoamie.trim() || compositeText.trim()) : compositeText;

  await startTypingIndicator(threadId);

  let intent: ParsedIntent;
  if (attendanceUnprefixed && !hadRoamie) {
    intent = quickRules;
  } else {
    intent = await parseIntent(textForIntent);
  }

  let receiptImageUrl: string | undefined;
  if (trip) {
    const merged = await mergeReceiptExpenseIntent(intent, event, trip);
    intent = merged.intent;
    receiptImageUrl = merged.receiptImageUrl;
  }

  if (
    trip &&
    trip.currentState !== TripState.CLOSED &&
    intent.intent !== "ADD_EXPENSE" &&
    intent.intent !== "DELETE_EXPENSE" &&
    intent.intent !== "EDIT_EXPENSE" &&
    intent.intent !== "SET_DISPLAY_NAME" &&
    intent.intent !== "SET_CONTACT_NAMES" &&
    intent.intent !== "APPEND_ITINERARY" &&
    intent.intent !== "TAG_SUBGROUP" &&
    !isStandaloneThumbEmoji(compositeText) &&
    textForIntent.trim().length >= 2 &&
    messageLooksLikeTripPlanningDetail(textForIntent)
  ) {
    await captureTripPlanningDetailsFromMessage(trip.id, textForIntent, trip, intent);
    const refreshed = await getTripByThreadId(threadId);
    if (refreshed) {
      trip = refreshed;
    }
  }

  if (!trip) {
    if (intent.intent === "CREATE_GROUP_TRIP" && intent.invitees && intent.invitees.length > 0) {
      try {
        const chat = await createChat(intent.invitees, intent.inviteMessage ?? "Are you interested in joining the trip?");
        const groupThreadId = chat.chatId;

        if (!groupThreadId) {
          throw new Error("Linq did not return a chat id for the new group thread.");
        }

        const createdTrip = await createTrip({
          threadId: groupThreadId,
          createdBy: userId,
        });

        await upsertParticipant({
          tripId: createdTrip.id,
          userId,
          ...senderProfileFromEvent(event),
          phoneNumber: userId.startsWith("+") ? userId : undefined,
          status: ParticipantStatus.CONFIRMED,
          arrivalNote: "Trip creator",
        });

        for (const invitee of intent.invitees) {
          await upsertParticipant({
            tripId: createdTrip.id,
            userId: invitee,
            phoneNumber: invitee,
            status: ParticipantStatus.PENDING,
            arrivalNote: "Invited to group trip",
          });
        }

        logger.info("Created Roamie group trip", { groupThreadId, fromThreadId: threadId });
        return;
      } catch (error) {
        logger.warn("Group trip API failed; using current thread fallback", {
          status: error && typeof error === "object" && "isAxiosError" in error ? "linq_error" : String(error),
        });

        const fallbackTrip = await createTrip({
          threadId,
          createdBy: userId,
        });

        await upsertParticipant({
          tripId: fallbackTrip.id,
          userId,
          ...senderProfileFromEvent(event),
          phoneNumber: userId.startsWith("+") ? userId : undefined,
          status: ParticipantStatus.CONFIRMED,
          arrivalNote: "Trip creator",
        });

        for (const invitee of intent.invitees) {
          await upsertParticipant({
            tripId: fallbackTrip.id,
            userId: invitee,
            phoneNumber: invitee,
            status: ParticipantStatus.PENDING,
            arrivalNote: "Invite pending manual group thread",
          });
        }

        await sendBestEffortReply(
          threadId,
          "I couldn’t open the shared group thread automatically, so I started the trip here and saved the invitees. If you create the group manually in Linq, we can keep going there.",
        );
        return;
      }
    }

    /** CREATE_GROUP_TRIP without E.164 invitees in the message is treated like CREATE_TRIP in this thread. */
    const canCreateTripInThread =
      intent.intent === "CREATE_TRIP" ||
      (intent.intent === "CREATE_GROUP_TRIP" && (!intent.invitees || intent.invitees.length === 0));

    if (!canCreateTripInThread) {
      const text =
        intent.intent === "UNKNOWN"
          ? await generateContextualReply({
              userMessage: textForIntent,
              hasTrip: false,
            })
          : "Start with the trip details, like: Miami trip May 15 to May 18, 6 people, $1200 budget.";
      await sendBestEffortReply(threadId, text);
      return;
    }

    const createdTrip = await createTrip({
      threadId,
      title: intent.title,
      destination: intent.destination,
      budget: intent.budget,
      startDate: intent.startDate,
      endDate: intent.endDate,
      createdBy: userId,
    });

    await upsertParticipant({
      tripId: createdTrip.id,
      userId,
      ...senderProfileFromEvent(event),
      status: ParticipantStatus.CONFIRMED,
      arrivalNote: "Trip creator",
    });

    await sendBestEffortTrackedReply({
      chatId: threadId,
      tripId: createdTrip.id,
      actionType: MessageAction.ATTENDANCE_CONFIRM,
      text: messageBlocks(
        "Trip’s open.",
        "First step is headcount: react 👍 if you’re in or 👎 if you’re out, or just reply yes/no.",
        "Optional: set how your name appears — e.g. “my name is Alex” or a roster line like “names: +1… — Sam, +1… — Jordan”.",
      ),
      payload: {
        kind: "attendance_confirm",
      },
    });
    return;
  }

  if (intent.intent === "CREATE_TRIP") {
    await applyTripDetailsUpdate({
      tripId: trip.id,
      threadId,
      intent,
      currentState: trip.currentState,
    });
    return;
  }

  if (
    trip.currentState === TripState.ATTENDANCE &&
    (intent.intent === "CONFIRM_ATTENDANCE" || intent.intent === "DECLINE_ATTENDANCE")
  ) {
    const handled = await handleAttendanceReply({
      tripId: trip.id,
      threadId,
      userId,
      text: compositeText,
      intent,
    });

    if (handled) {
    return;
    }
  }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_HOTELS") {
    if (trip.currentState === TripState.ATTENDANCE) {
      await moveTripToState(trip.id, TripState.PLANNING);
    }

    await sendHotelOptionsForTrip({
      tripId: trip.id,
      threadId,
      destination: trip.destination,
      budget: trip.budget,
      startDate: trip.startDate,
      endDate: trip.endDate,
    });
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_MORE_HOTELS") {
    if (trip.currentState === TripState.ATTENDANCE) {
        await moveTripToState(trip.id, TripState.PLANNING);
    }

    const alt = await generateHotelAlternativesFromAi({
          destination: trip.destination,
          budget: trip.budget,
      startDate: trip.startDate,
      endDate: trip.endDate,
      userMessage: textForIntent,
        });

    if (alt) {
      await sendBestEffortTrackedReply({
          chatId: threadId,
          tripId: trip.id,
          actionType: MessageAction.HOTEL_VOTE,
        text: alt.text,
          payload: {
          kind: "option_poll",
          pollKind: "stay",
          options: alt.options,
            votes: {},
          },
        });
    } else {
      await sendHotelOptionsForTrip({
        tripId: trip.id,
          threadId,
            destination: trip.destination,
        budget: trip.budget,
            startDate: trip.startDate,
            endDate: trip.endDate,
      });
    }
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_MEAL_RSVP") {
    await sendMealRsvpPoll({
          tripId: trip.id,
      threadId,
      title: intent.rsvpTopic ?? "Group meal",
    });
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_RESTAURANTS") {
    await sendFoodOptionPoll(trip, threadId, textForIntent, false);
    return;
  }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_MORE_RESTAURANTS") {
    await sendFoodOptionPoll(trip, threadId, textForIntent, true);
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_ACTIVITIES") {
    await sendActivityOptionPoll(trip, threadId, textForIntent, false);
    return;
  }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_MORE_ACTIVITIES") {
    await sendActivityOptionPoll(trip, threadId, textForIntent, true);
    return;
  }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "FINALIZE_POLL") {
    const result = await finalizeOptionPoll({
      tripId: trip.id,
          threadId,
      explicitOptionIndex: intent.finalizeOptionIndex,
    });
    await sendBestEffortReply(threadId, result.message);
    return;
  }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_ITINERARY") {
    if (trip.currentState === TripState.ATTENDANCE || trip.currentState === TripState.PLANNING) {
      await moveTripToState(trip.id, TripState.ITINERARY);
    }

    await sendItineraryForTrip({
      threadId,
            destination: trip.destination,
            startDate: trip.startDate,
            endDate: trip.endDate,
      itineraryNotes: trip.itineraryNotes,
      budget: trip.budget,
      participants: trip.participants,
    });
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "REQUEST_WEATHER") {
    await startTypingIndicator(threadId);
    const text = await formatTripWeatherChatReply({
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
    });
    await sendBestEffortReply(threadId, text);
        return;
      }

  const expenseCount = trip.expenses?.length ?? 0;

  if (trip.currentState !== TripState.CLOSED && expenseCount > 0 && intent.intent === "REQUEST_SPLIT_HISTORY") {
    await startTypingIndicator(threadId);
    const text = await buildGroupSplitHistoryText(trip.id);
    await sendBestEffortReply(threadId, text);
        return;
      }

  if (trip.currentState !== TripState.CLOSED && expenseCount > 0 && intent.intent === "REQUEST_MY_SPLITS") {
    await startTypingIndicator(threadId);
    const text = await buildUserSplitHistoryText(trip.id, userId);
    await sendBestEffortReply(threadId, text);
    return;
  }

  if (trip.currentState !== TripState.CLOSED && expenseCount > 0 && intent.intent === "DELETE_EXPENSE") {
    await startTypingIndicator(threadId);
    const r = await deleteExpenseForTrip(trip.id, userId, {
      indexFromRecent: intent.targetExpenseIndex ?? 1,
      descriptionContains: intent.targetExpenseDescription,
    });
    if (!r.ok) {
      await sendBestEffortReply(threadId, r.message);
      return;
    }
    await sendBestEffortReply(threadId, `Removed “${r.description}” ($${r.amount.toFixed(2)}).`);
        return;
      }

  if (trip.currentState !== TripState.CLOSED && expenseCount > 0 && intent.intent === "EDIT_EXPENSE") {
    await startTypingIndicator(threadId);
    const resolved = await resolveMutableExpense(trip.id, userId, {
      indexFromRecent: intent.targetExpenseIndex ?? 1,
      descriptionContains: intent.targetExpenseDescription,
    });
    if ("error" in resolved) {
      await sendBestEffortReply(threadId, resolved.error);
      return;
    }
    const upd = await updateExpenseForTrip({
          tripId: trip.id,
      expenseId: resolved.expense.id,
      actorUserId: userId,
      newAmount: intent.editExpenseNewAmount,
      newDescription: intent.editExpenseNewDescription,
    });
    if (!upd.ok) {
      await sendBestEffortReply(threadId, upd.message);
      return;
    }
    await sendBestEffortReply(threadId, "Updated that expense.");
        return;
      }

  if (
    trip.currentState !== TripState.CLOSED &&
    expenseCount > 0 &&
    intent.intent === "RECORD_PARTIAL_PAYMENT" &&
    intent.amount != null &&
    intent.amount > 0
  ) {
    await startTypingIndicator(threadId);
    const r = await recordPartialPayment({
          tripId: trip.id,
      payerUserId: userId,
      amount: intent.amount,
      note: textForIntent.slice(0, 240),
      source: "chat_partial",
    });
    if (!r.ok) {
      await sendBestEffortReply(threadId, r.message);
        return;
      }
    const parts: string[] = [
      `Recorded $${r.appliedAmount.toFixed(2)} toward your split lines (${r.splitsTouched} line(s) updated).`,
    ];
    if (r.splitsClosed > 0) {
      parts.push(`Fully closed ${r.splitsClosed} split line(s).`);
    }
    if (r.cappedOverpay > SPLIT_PAY_EPS) {
      parts.push(
        `(Only $${r.appliedAmount.toFixed(2)} was needed — $${r.cappedOverpay.toFixed(2)} above your remaining balance was not applied.)`,
      );
    }
    await sendBestEffortReply(threadId, messageBlocks(...parts));
    return;
  }

  if (trip.currentState === TripState.CLOSED && (intent.intent === "TAG_SUBGROUP" || intent.intent === "APPEND_ITINERARY")) {
    await sendBestEffortReply(threadId, "This trip is closed.");
        return;
      }

  if (trip.currentState !== TripState.CLOSED && intent.intent === "SET_DISPLAY_NAME" && intent.manualDisplayName?.trim()) {
    await startTypingIndicator(threadId);
    const label = intent.manualDisplayName.trim();
    await mergeParticipantDisplayName(trip.id, userId, label);
    await sendBestEffortReply(threadId, `Got it — I’ll show you as “${label}” on this trip.`);
        return;
      }

  if (
    trip.currentState !== TripState.CLOSED &&
    intent.intent === "SET_CONTACT_NAMES" &&
    intent.phoneNamePairs &&
    intent.phoneNamePairs.length > 0
  ) {
    await startTypingIndicator(threadId);
    const { savedLabels, notFoundPhones } = await applyContactNamesToTrip(trip.id, intent.phoneNamePairs);
    const parts: string[] = [];
    if (savedLabels.length > 0) {
      parts.push(`Saved ${savedLabels.length} name(s): ${savedLabels.join(", ")}.`);
    }
    if (notFoundPhones.length > 0) {
      parts.push(
        `Couldn’t match a traveler on this trip for: ${notFoundPhones.join(", ")}. They may need to send a message here first.`,
      );
    }
    if (parts.length === 0) {
      parts.push("No names were saved.");
    }
    await sendBestEffortReply(threadId, messageBlocks(...parts));
        return;
      }

  if (intent.intent === "TAG_SUBGROUP" && intent.subgroupTag) {
    const self = trip.participants.find((p) => p.userId === userId);
    await upsertParticipant({
      tripId: trip.id,
      userId,
      ...senderProfileFromEvent(event),
      status: self?.status ?? ParticipantStatus.CONFIRMED,
      subgroupTag: intent.subgroupTag,
      arrivalNote: self?.arrivalNote ?? `Subgroup: ${intent.subgroupTag}`,
    });
    await sendBestEffortReply(threadId, `Tagged you for splits as “${intent.subgroupTag}”.`);
    return;
  }

  if (intent.intent === "APPEND_ITINERARY" && intent.itineraryLine) {
    if (trip.currentState === TripState.INIT || trip.currentState === TripState.ATTENDANCE) {
      await sendBestEffortReply(threadId, "Confirm the trip and move past attendance first, then we can build itinerary notes.");
      return;
    }
    await appendItineraryNotes(trip.id, intent.itineraryLine);
    await sendBestEffortReply(threadId, "Added that to the shared itinerary notes.");
      return;
    }

  const tripContext: TripMessageContext = {
    trip,
    threadId,
    userId,
    intent,
    receiptUrl: receiptImageUrl ?? event.mediaUrls?.[0],
    userMessage: textForIntent,
  };

  switch (trip.currentState) {
    case TripState.ATTENDANCE:
      if (await handleAttendancePhase(tripContext)) return;
      break;
    case TripState.PLANNING:
      if (await handlePlanningPhase(tripContext)) return;
      break;
    case TripState.ITINERARY:
      if (await handleItineraryPhase(tripContext)) return;
      break;
    case TripState.ACTIVE:
      if (await handleActivePhase(tripContext)) return;
      break;
    case TripState.SETTLEMENT:
      if (await handleSettlementPhase(tripContext)) return;
      break;
    case TripState.CLOSED:
      await sendBestEffortReply(threadId, "This trip is already closed. Start a fresh thread whenever you want to open a new one.");
      return;
    case TripState.INIT:
    default:
      break;
  }

  await sendBestEffortReply(
    threadId,
    await generateContextualReply({
      userMessage: textForIntent,
      hasTrip: true,
      tripState: trip.currentState,
      destination: trip.destination,
      budget: trip.budget,
      datesLabel: formatTripDates(trip.startDate, trip.endDate),
      itineraryNotesPreview: trip.itineraryNotes,
      hasItineraryNotes: Boolean(trip.itineraryNotes?.trim()),
    }),
  );
}
