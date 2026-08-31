import { MessageAction, ParticipantStatus } from "@prisma/client";
import { db } from "../db/client";
import { safeJsonParse } from "../utils/json";
import { messageBlocks } from "../utils/chatCopy";
import { sendPlainMessage } from "./notificationService";
import { getParticipantDisplayLabel } from "./settlementService";
import { ensureParticipantStub, setTripFinalPlanningPick } from "./tripService";
import type { HotelOption } from "./hotelService";

export type PollKind = "stay" | "food" | "activity";

export type OptionPollPayload = {
  kind: string;
  pollKind?: PollKind;
  options: HotelOption[];
  votes: Record<string, string>;
};

const OPTION_POLL_ACTIONS: MessageAction[] = [MessageAction.HOTEL_VOTE];

function isOptionPollPayload(payload: OptionPollPayload): boolean {
  return (
    (payload.kind === "option_poll" || payload.kind === "hotel_vote") &&
    Array.isArray(payload.options) &&
    payload.options.length >= 1
  );
}

export async function findLatestOptionPoll(tripId: string) {
  return db.messageContext.findFirst({
    where: { tripId, actionType: { in: OPTION_POLL_ACTIONS } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findLatestRsvpPoll(tripId: string) {
  return db.messageContext.findFirst({
    where: { tripId, actionType: MessageAction.RSVP_POLL },
    orderBy: { createdAt: "desc" },
  });
}

function tallyOptionVotes(votes: Record<string, string>, optionCount: number): number[] {
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const v of Object.values(votes)) {
    const n = Number(v);
    if (n >= 1 && n <= optionCount) {
      counts[n - 1] += 1;
    }
  }
  return counts;
}

function formatOptionTally(options: HotelOption[], counts: number[]): string {
  return options
    .map((opt, i) => `${i + 1}: ${counts[i] ?? 0}`)
    .join(", ");
}

/** 1-based index; ties → smallest index among those tied with max votes. */
function pluralityWinnerIndex(counts: number[]): number {
  let max = -1;
  let bestIdx = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > max) {
      max = counts[i];
      bestIdx = i;
    }
  }
  if (max <= 0) {
    return 0;
  }
  return bestIdx + 1;
}

export type FinalPlanningPickRecord = {
  pollKind: PollKind;
  optionIndex: number;
  label: string;
  vibe?: string;
  nightlyRate?: number;
  decidedAt: string;
  source: "plurality" | "explicit";
};

/**
 * Chooses winning option (plurality or explicit), saves on Trip, returns chat line.
 */
export async function finalizeOptionPoll(input: {
  tripId: string;
  threadId: string;
  explicitOptionIndex?: 1 | 2 | 3;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const latest = await findLatestOptionPoll(input.tripId);
  if (!latest?.payload) {
    return { ok: false, message: "There’s no open option poll in this trip yet — ask for hotels, food, or activities first." };
  }
  const payload = safeJsonParse<OptionPollPayload>(latest.payload, { kind: "", options: [], votes: {} });
  if (!isOptionPollPayload(payload)) {
    return { ok: false, message: "Couldn’t read the last poll — try sending a fresh poll first." };
  }
  const n = payload.options.length;
  const counts = tallyOptionVotes(payload.votes ?? {}, n);
  const tallyLine = formatOptionTally(payload.options, counts);

  let chosen: number;
  let source: "plurality" | "explicit";

  if (input.explicitOptionIndex != null) {
    if (input.explicitOptionIndex < 1 || input.explicitOptionIndex > n) {
      return { ok: false, message: `Pick a number between 1 and ${n} for this poll.` };
    }
    chosen = input.explicitOptionIndex;
    source = "explicit";
  } else {
    const win = pluralityWinnerIndex(counts);
    if (win === 0) {
      return {
        ok: false,
        message: messageBlocks(
          `No votes yet (tallies: ${tallyLine}).`,
          "Have people reply 1, 2, or 3, or say e.g. “finalize 2” to lock an option.",
        ),
      };
    }
    chosen = win;
    source = "plurality";
  }

  const opt = payload.options[chosen - 1];
  const pollKind = payload.pollKind ?? "stay";
  const record: FinalPlanningPickRecord = {
    pollKind,
    optionIndex: chosen,
    label: opt.label,
    vibe: opt.vibe,
    nightlyRate: opt.nightlyRate,
    decidedAt: new Date().toISOString(),
    source,
  };

  await setTripFinalPlanningPick(input.tripId, record);

  const kindLabel =
    pollKind === "stay" ? "Stay" : pollKind === "food" ? "Food" : "Activity";
  const rateBit =
    pollKind === "stay"
      ? `$${opt.nightlyRate}/night`
      : `~$${opt.nightlyRate}/person`;

  const maxVotes = Math.max(...counts, 0);
  const headline =
    maxVotes > 0
      ? `${kindLabel} pick (closed): ${opt.label} — ${maxVotes} vote${maxVotes === 1 ? "" : "s"} for this option (${rateBit}; ${opt.vibe}).`
      : `${kindLabel} pick (closed): ${opt.label} (${rateBit}; ${opt.vibe}).`;

  const ballotCount = Object.keys(payload.votes ?? {}).length;
  const confirmedCount = await db.participant.count({
    where: { tripId: input.tripId, status: ParticipantStatus.CONFIRMED },
  });
  const turnoutLine =
    confirmedCount > 0
      ? `Turnout: ${ballotCount} of ${confirmedCount} people voted (any option).`
      : `Turnout: ${ballotCount} vote${ballotCount === 1 ? "" : "s"} cast.`;

  const voterIds = Object.entries(payload.votes ?? {}).filter(
    ([, v]) => Number(v) === chosen,
  ).map(([uid]) => uid);
  const voterLabels =
    voterIds.length > 0
      ? await Promise.all(voterIds.map((uid) => getParticipantDisplayLabel(input.tripId, uid)))
      : [];

  let assigneeLine: string;
  if (voterLabels.length === 1) {
    assigneeLine = `Next step: ${voterLabels[0]} voted for this — they’re a good default to book or coordinate.`;
  } else if (voterLabels.length >= 2) {
    const shown = voterLabels.slice(0, 4);
    const extra = voterLabels.length - shown.length;
    const roll = extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
    assigneeLine = `Next step: ${roll} voted for this — pick one person to book or split tasks.`;
  } else {
    assigneeLine = "Next step: No votes recorded for this option — decide who books or confirm in thread.";
  }

  const message = messageBlocks(
    headline,
    turnoutLine,
    assigneeLine,
    `Tallies: ${tallyLine}.`,
    source === "plurality"
      ? "Winner = most votes (ties → lower number wins)."
      : "Locked by your explicit choice.",
    "Saved on this trip for everyone.",
  );

  return { ok: true, message };
}

export async function recordOptionPollVote(input: {
  tripId: string;
  threadId: string;
  userId: string;
  choice: 1 | 2 | 3;
}): Promise<boolean> {
  const latest = await findLatestOptionPoll(input.tripId);
  if (!latest?.payload) {
    return false;
  }
  const payload = safeJsonParse<OptionPollPayload>(latest.payload, { kind: "", options: [], votes: {} });
  if (!isOptionPollPayload(payload)) {
    return false;
  }
  const n = payload.options.length;
  if (input.choice < 1 || input.choice > n) {
    return false;
  }

  const votes = { ...(payload.votes ?? {}), [input.userId]: String(input.choice) };
  await db.messageContext.update({
    where: { messageId: latest.messageId },
    data: { payload: JSON.stringify({ ...payload, votes }) },
  });

  await ensureParticipantStub(input.tripId, input.userId);

  const picked = payload.options[input.choice - 1];
  const counts = tallyOptionVotes(votes, n);
  const tallyLine = formatOptionTally(payload.options, counts);

  const label = await getParticipantDisplayLabel(input.tripId, input.userId);
  await sendPlainMessage(
    input.threadId,
    messageBlocks(
      `Got it — ${label} voted ${input.choice} (${picked?.label ?? "option"}).`,
      `Tallies: ${tallyLine}.`,
    ),
  );
  return true;
}

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

function isRsvpIn(text: string): boolean {
  const t = text.trim();
  return (
    /^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u.test(t) ||
    /^(in|yes|y|yep|yeah|sure|definitely|i'?m\s+in|count\s+me\s+in)\b/i.test(t)
  );
}

function isRsvpOut(text: string): boolean {
  const t = text.trim();
  return (
    /^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿)$/u.test(t) ||
    /^(out|no|nope|pass|can'?t|skip|i'?m\s+out)\b/i.test(t)
  );
}

export async function tryHandleRsvpTextReply(input: {
  tripId: string;
  threadId: string;
  userId: string;
  text: string;
}): Promise<boolean> {
  const latest = await findLatestRsvpPoll(input.tripId);
  if (!latest?.payload) {
    return false;
  }
  const payload = safeJsonParse<RsvpPayload>(latest.payload, { kind: "", title: "", votes: {} });
  if (payload.kind !== "rsvp" || !payload.title) {
    return false;
  }

  let side: "in" | "out" | null = null;
  if (isRsvpIn(input.text)) {
    side = "in";
  } else if (isRsvpOut(input.text)) {
    side = "out";
  }
  if (!side) {
    return false;
  }

  const votes = { ...(payload.votes ?? {}), [input.userId]: side };
  await db.messageContext.update({
    where: { messageId: latest.messageId },
    data: { payload: JSON.stringify({ ...payload, votes }) },
  });

  const { ins, outs } = tallyRsvp(votes);
  const label = await getParticipantDisplayLabel(input.tripId, input.userId);
  await sendPlainMessage(
    input.threadId,
    messageBlocks(
      `Recorded ${label} as ${side.toUpperCase()} for “${payload.title}”.`,
      `So far: ${ins} in, ${outs} out.`,
    ),
  );
  return true;
}
