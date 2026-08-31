import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { safeJsonParse, stripCodeFences } from "../utils/json";
import type { HotelOption } from "./hotelService";
import { nightsBetween, renderOptionPollLines } from "./hotelService";
import { fetchTripWeatherContextLine } from "./weatherService";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

function tripDatesLabel(start?: Date | null, end?: Date | null): string {
  if (!start && !end) {
    return "dates TBD";
  }
  const a = start ? start.toISOString().slice(0, 10) : "?";
  const b = end ? end.toISOString().slice(0, 10) : "?";
  return `${a} → ${b}`;
}

export async function generateItineraryNarrative(input: {
  destination?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  budget?: number | null;
  itineraryNotes?: string | null;
  /** Per-person arrival / timing notes (e.g. late flights) — shapes Day 1 pacing. */
  participantArrivalSummary?: string | null;
}): Promise<string | null> {
  const dest = input.destination?.trim() || "the destination";
  const dates = tripDatesLabel(input.startDate, input.endDate);
  const budgetHint =
    input.budget != null ? `Approximate group budget context: around $${Math.round(input.budget)} total.` : "";
  const notes = input.itineraryNotes?.trim()
    ? `The group already added these notes — weave them in where sensible:\n${input.itineraryNotes.trim()}`
    : "";
  const arrivals = input.participantArrivalSummary?.trim()
    ? [
        "Participant arrival / timing (use this to avoid scheduling full-group blocks before late arrivals; call out who joins when):",
        input.participantArrivalSummary.trim(),
      ].join("\n")
    : "";

  const weatherLine = input.destination?.trim()
    ? await fetchTripWeatherContextLine({
        destination: input.destination.trim(),
        startDate: input.startDate,
        endDate: input.endDate,
      })
    : undefined;
  const weatherBlock = weatherLine
    ? `Rough public forecast for the trip window (use for packing / outdoor pacing; not official warnings):\n${weatherLine}`
    : "";

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.65,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content: [
            "You are Roamie, a sharp group-trip copilot.",
            "Write a day-by-day itinerary as plain text for iMessage/SMS (no markdown tables, no links).",
            "Use vivid but realistic suggestions: neighborhoods, types of venues, pacing (morning / afternoon / evening).",
            "When arrival notes say someone is late on Day 1, keep mandatory group activities to evening or Day 2+ for that day; mention who is absent earlier.",
            "Match the number of days to the trip length implied by the dates; if unclear, use 3 days.",
            "If a forecast snippet is provided, mention weather briefly (one clause per day or a single packing tip) — do not paste raw numbers as a table.",
            "Keep total length under 900 characters. Start with a one-line vibe header, then Day 1, Day 2, etc.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Destination: ${dest}`,
            `Trip dates: ${dates}`,
            budgetHint,
            notes,
            arrivals,
            weatherBlock,
            "Make it feel specific to this city, not generic filler.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text || text.length < 40) {
      return null;
    }
    return text;
  } catch (error) {
    logger.warn("OpenAI itinerary generation failed", { err: String(error) });
    return null;
  }
}

type HotelAiPayload = {
  intro: string;
  options: Array<{ key?: string; label: string; nightlyRate: number; vibe: string }>;
};

export type OptionPollVariant = "stay" | "food" | "activity";

/**
 * Three illustrative options for stays, dining direction, or activities (not real bookings).
 */
export async function generateOptionPollFromAi(input: {
  variant: OptionPollVariant;
  destination?: string | null;
  budget?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  userMessage: string;
}): Promise<{ options: HotelOption[]; text: string } | null> {
  const dest = input.destination?.trim() || "the destination";
  const nights = nightsBetween(input.startDate, input.endDate);
  const budget = input.budget ?? 900;
  const hint = input.userMessage.trim();

  const stayPortion = Math.round(budget * 0.45);
  const mealHint = Math.round((budget * 0.25) / Math.max(nights, 1));
  const activityHint = Math.round((budget * 0.2) / Math.max(nights, 1));

  let systemParts: string[];
  let userContent: string;

  if (input.variant === "stay") {
    systemParts = [
      "You help groups pick stay styles for a trip (illustrative options only — not real bookings).",
      "Return JSON only with shape:",
      '{"intro":"short SMS-friendly line","options":[{"key":"a","label":"short name","nightlyRate":120,"vibe":"one line"}]}',
      "Exactly 3 options. nightlyRate = plausible USD per night for the destination; total rough stay budget ~",
      String(stayPortion),
      " across",
      String(nights),
      " nights.",
      "Reflect user preferences (quiet, party, walkable, boutique, etc.).",
    ];
    userContent = `Destination: ${dest}. ~${nights} night(s). User said: "${hint}"`;
  } else if (input.variant === "food") {
    systemParts = [
      "You suggest three dining DIRECTIONS for a group trip (illustrative — not real reservations).",
      "Return JSON only:",
      '{"intro":"short line","options":[{"key":"a","label":"short name","nightlyRate":45,"vibe":"one line"}]}',
      "Exactly 3 options. nightlyRate = rough USD per person for that tier at this destination (~",
      String(mealHint),
      " per meal as a mid anchor if unsure).",
    ];
    userContent = `Destination: ${dest}. ~${nights} day(s) on trip. User said: "${hint}"`;
  } else {
    systemParts = [
      "You suggest three ACTIVITY DAY styles for a group trip (illustrative — not tickets or bookings).",
      "Return JSON only:",
      '{"intro":"short line","options":[{"key":"a","label":"short name","nightlyRate":50,"vibe":"one line"}]}',
      "Exactly 3 options. nightlyRate = rough USD per person for that day style (~",
      String(activityHint),
      " as a mid anchor).",
    ];
    userContent = `Destination: ${dest}. ~${nights} day(s). User said: "${hint}"`;
  }

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemParts.join(" ") },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = safeJsonParse<HotelAiPayload>(stripCodeFences(raw), { intro: "", options: [] });
    if (!parsed.options?.length) {
      return null;
    }

    const options: HotelOption[] = parsed.options.slice(0, 3).map((o, i) => ({
      key: o.key ?? ["alt_a", "alt_b", "alt_c"][i] ?? `alt_${i}`,
      label: o.label.slice(0, 80),
      nightlyRate: Math.max(15, Math.round(Number(o.nightlyRate) || 50)),
      vibe: o.vibe.slice(0, 120),
    }));

    const defaultIntro =
      input.variant === "stay"
        ? `More stay ideas for ${dest} (~${nights} night${nights === 1 ? "" : "s"}):`
        : input.variant === "food"
          ? `Dining directions for ${dest}:`
          : `Activity vibes for ${dest}:`;

    const intro = parsed.intro?.trim() || defaultIntro;
    const text = renderOptionPollLines({
      intro,
      options,
      pollKind: input.variant === "stay" ? "stay" : input.variant === "food" ? "food" : "activity",
    });

    return { options, text };
  } catch (error) {
    logger.warn("OpenAI option poll failed", { variant: input.variant, err: String(error) });
    return null;
  }
}

/**
 * Three fresh stay ideas (illustrative, not real bookings) based on user preferences.
 */
export async function generateHotelAlternativesFromAi(input: {
  destination?: string | null;
  budget?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  userMessage: string;
}): Promise<{ options: HotelOption[]; text: string } | null> {
  return generateOptionPollFromAi({ ...input, variant: "stay" });
}

/** Structured updates parsed from free-form planning messages (saved to Trip). */
export type TripPlanningPatch = {
  destination?: string | null;
  budget?: number | null;
  /** ISO yyyy-mm-dd */
  startDate?: string | null;
  /** ISO yyyy-mm-dd */
  endDate?: string | null;
  /** Short bullet for splits / prefs that do not fit other fields */
  appendItineraryNote?: string | null;
};

export async function extractTripPlanningPatch(input: {
  message: string;
  existingDestination?: string | null;
  existingBudget?: number | null;
  existingStart?: string | null;
  existingEnd?: string | null;
  existingNotes?: string | null;
}): Promise<TripPlanningPatch | null> {
  const msg = input.message.trim();
  if (msg.length < 2) {
    return null;
  }

  const year = new Date().getFullYear();
  const existing = [
    `destination: ${input.existingDestination ?? "unknown"}`,
    `budget: ${input.existingBudget != null ? `$${Math.round(input.existingBudget)}` : "unknown"}`,
    `startDate: ${input.existingStart ?? "unknown"}`,
    `endDate: ${input.existingEnd ?? "unknown"}`,
    input.existingNotes?.trim() ? `notes: ${input.existingNotes.trim().slice(0, 600)}` : "notes: (none)",
  ].join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.15,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You extract trip planning facts from the user's LATEST message only.",
            "Return JSON: { destination, budget, startDate, endDate, appendItineraryNote }.",
            "Use null for any field not clearly stated or changed in this message.",
            "Dates as ISO strings yyyy-mm-dd. If the user gives month/day without year, assume year",
            String(year),
            "unless they imply another year.",
            "budget is a single total trip budget number only when they describe overall budget or caps — not a one-off dinner/receipt amount unless they say it is their trip budget.",
            "appendItineraryNote: short clause for splits (e.g. $X food, $Y hotels), preferences, or neighborhood prefs — only when this message adds that; avoid repeating what is already in existing notes.",
            "If the message is only acknowledgement (ok, thanks, sounds good, got it, emoji), return all nulls.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Existing trip:\n${existing}\n\nUser message:\n${msg}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = safeJsonParse<TripPlanningPatch>(stripCodeFences(raw), {});
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn("OpenAI trip planning extract failed", { err: String(error) });
    return null;
  }
}

export type RoamieChatContext = {
  userMessage: string;
  hasTrip: boolean;
  tripState?: string;
  destination?: string | null;
  budget?: number | null;
  datesLabel?: string;
  itineraryNotesPreview?: string | null;
  hasItineraryNotes?: boolean;
};

function phaseAntiRepetitionRules(tripState: string | undefined): string {
  switch (tripState) {
    case "ATTENDANCE":
      return "ATTENDANCE: focus on who’s in/out. Do not prompt for hotels, full itinerary, or expenses unless the user asks.";
    case "PLANNING":
      return "PLANNING: hotels and activities are fair game, but do NOT re-ask for dates, destination, or total budget if already in Active trip context.";
    case "ITINERARY":
      return "ITINERARY: hotel/stay pick phase is behind you — do NOT ask again for hotel preferences or repeat a generic “hotels and activities in [city]?” opener. Build on what exists; refine days, timing, or offer to start the trip.";
    case "ACTIVE":
      return "ACTIVE: the trip is live — focus on expenses, logistics, quick tips. Do NOT ask broad planning questions about choosing hotels or drafting a first-pass itinerary unless the user explicitly asks.";
    case "SETTLEMENT":
      return "SETTLEMENT: balances and payments only — no hotel or itinerary planning prompts.";
    case "CLOSED":
      return "CLOSED: no new planning.";
    case "INIT":
      return "INIT: early setup only.";
    default:
      return "Use trip state to avoid repeating questions already settled.";
  }
}

export async function generateContextualReply(ctx: RoamieChatContext): Promise<string> {
  const trimmed = ctx.userMessage.trim();
  if (!trimmed) {
    return "Send a quick note about the trip — dates, budget, or who’s in.";
  }

  try {
    const notes =
      ctx.itineraryNotesPreview?.trim().slice(0, 450) ??
      "";

    const phaseRule = phaseAntiRepetitionRules(ctx.tripState);
    const notesHint =
      ctx.hasItineraryNotes && notes
        ? "The trip already has saved itinerary/planning notes (see below) — extend or adjust them, do not talk as if planning just started."
        : ctx.hasItineraryNotes
          ? "The trip already has saved itinerary/planning notes — do not restart from zero."
          : "";

    const tripContextSummary = ctx.hasTrip
      ? [
          `Active trip context: state=${ctx.tripState ?? "unknown"}, destination=${ctx.destination ?? "TBD"}, budget=${ctx.budget != null ? `$${Math.round(ctx.budget)}` : "TBD"}, dates=${ctx.datesLabel ?? "TBD"}.`,
          `Current phase rule: ${phaseRule}`,
          notesHint,
          notes ? `Saved planning notes from earlier messages: ${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "There is no open trip in this thread yet.";

    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.45,
      max_tokens: 350,
      messages: [
        {
          role: "system",
          content: [
            "You are Roamie, a warm, concise group-trip assistant in a text thread.",
            "Reply in plain text, under 500 characters, no markdown.",
            "If they thank you or chat casually, respond naturally and briefly.",
            "If off-topic, acknowledge lightly and steer toward what matters for their CURRENT phase (see Current phase rule) — do not default to the same hotel/itinerary question every time.",
            "Never claim you booked or verified real hotels/flights; you suggest and organize only.",
            "Do not repeat robotic disclaimers or repeat the same question you asked in a previous turn unless the user left it unanswered.",
            "If Active trip context already lists concrete dates, budget, or destination, treat them as locked unless the user is clearly changing them — do not ask again for dates or total budget.",
            "If something is still missing (e.g. only dates but no budget), ask only for what is still unknown.",
            "Never ask 'preferences for hotels or activities' when state is ITINERARY, ACTIVE, SETTLEMENT, or CLOSED — those phases are past broad hotel picking or are wrong mode.",
          ].join(" "),
        },
        {
          role: "user",
          content: `${tripContextSummary}\n\nUser message: ${trimmed}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (text && text.length > 0) {
      return text.slice(0, 1200);
    }
  } catch (error) {
    logger.warn("OpenAI chat reply failed", { err: String(error) });
  }

  if (!ctx.hasTrip) {
    return "Start with the trip details, like: Miami trip May 15 to May 18, 6 people, $1200 budget.";
  }

  switch (ctx.tripState) {
    case "SETTLEMENT":
      return "Want the latest settle-up summary, or do you want to know who still owes what?";
    case "ACTIVE":
      return "You can log an expense, share a quick update, or ask to settle up.";
    case "ITINERARY":
      return "Want to tweak the day-by-day plan, add a stop, or say when you’re ready to start the trip?";
    default:
      return "What do you want to tackle next: stays, itinerary, expenses, or settle-up?";
  }
}

export type TripClosureNarrativeInput = {
  destination: string | null;
  title: string | null;
  datesLine: string;
  itineraryNotes: string | null;
  planningPickJson: string | null;
  expenseLines: string[];
  travelerNames: string[];
};

/**
 * Warm “memory journal” closing copy — no spend totals (stats appended separately).
 */
export async function generateTripClosureMemoryNarrative(
  input: TripClosureNarrativeInput,
): Promise<string | null> {
  const dest = input.destination?.trim() || "this destination";

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.75,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: [
            "You write a short closing memory journal for a group trip, as Roamie: warm, specific, past tense.",
            "Plain text only — no markdown, no * bullets, no # headers. Short paragraphs and line breaks are fine.",
            "Naturally cover: places explored, where you stayed (only if hints exist in notes, picks, or expenses),",
            "food and drinks or new things tried — infer from itinerary notes, resolved planning JSON, and expense descriptions.",
            "If data is thin, stay warm and general without inventing fake hotel names, restaurants, or dollar amounts.",
            "Do NOT include total spend, rankings, or 'biggest expense' — a separate stats line will follow.",
            "Keep under ~450 words; stop before any tally or summary numbers.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            input.title?.trim() ? `Trip title: ${input.title.trim()}` : "",
            `Destination: ${dest}`,
            `Dates: ${input.datesLine}`,
            input.travelerNames.length > 0 ? `Travelers: ${input.travelerNames.join(", ")}` : "",
            input.itineraryNotes?.trim()
              ? `Planning / itinerary notes:\n${input.itineraryNotes.trim()}`
              : "",
            input.planningPickJson
              ? `Resolved planning pick (JSON): ${input.planningPickJson}`
              : "",
            input.expenseLines.length > 0
              ? `Logged expenses (hints for what you did — not totals):\n${input.expenseLines.slice(0, 45).join("\n")}`
              : "No expenses logged in Roamie.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text || text.length < 25) {
      return null;
    }
    return text.slice(0, 4000);
  } catch (error) {
    logger.warn("OpenAI trip closure journal failed", { err: String(error) });
    return null;
  }
}
