"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateItineraryNarrative = generateItineraryNarrative;
exports.generateHotelAlternativesFromAi = generateHotelAlternativesFromAi;
exports.extractTripPlanningPatch = extractTripPlanningPatch;
exports.generateContextualReply = generateContextualReply;
const openai_1 = __importDefault(require("openai"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const json_1 = require("../utils/json");
const hotelService_1 = require("./hotelService");
const openai = new openai_1.default({
    apiKey: env_1.env.OPENAI_API_KEY,
});
function tripDatesLabel(start, end) {
    if (!start && !end) {
        return "dates TBD";
    }
    const a = start ? start.toISOString().slice(0, 10) : "?";
    const b = end ? end.toISOString().slice(0, 10) : "?";
    return `${a} → ${b}`;
}
async function generateItineraryNarrative(input) {
    const dest = input.destination?.trim() || "the destination";
    const dates = tripDatesLabel(input.startDate, input.endDate);
    const budgetHint = input.budget != null ? `Approximate group budget context: around $${Math.round(input.budget)} total.` : "";
    const notes = input.itineraryNotes?.trim()
        ? `The group already added these notes — weave them in where sensible:\n${input.itineraryNotes.trim()}`
        : "";
    try {
        const response = await openai.chat.completions.create({
            model: env_1.env.OPENAI_MODEL,
            temperature: 0.65,
            max_tokens: 900,
            messages: [
                {
                    role: "system",
                    content: [
                        "You are Roamie, a sharp group-trip copilot.",
                        "Write a day-by-day itinerary as plain text for iMessage/SMS (no markdown tables, no links).",
                        "Use vivid but realistic suggestions: neighborhoods, types of venues, pacing (morning / afternoon / evening).",
                        "Match the number of days to the trip length implied by the dates; if unclear, use 3 days.",
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
    }
    catch (error) {
        logger_1.logger.warn("OpenAI itinerary generation failed", { err: String(error) });
        return null;
    }
}
/**
 * Three fresh stay ideas (illustrative, not real bookings) based on user preferences.
 */
async function generateHotelAlternativesFromAi(input) {
    const dest = input.destination?.trim() || "the destination";
    const nights = (0, hotelService_1.nightsBetween)(input.startDate, input.endDate);
    const budget = input.budget ?? 900;
    const stayPortion = Math.round(budget * 0.45);
    const hint = input.userMessage.trim();
    try {
        const response = await openai.chat.completions.create({
            model: env_1.env.OPENAI_MODEL,
            temperature: 0.5,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: [
                        "You help groups pick stay styles for a trip (illustrative options only — not real bookings).",
                        "Return JSON only with shape:",
                        '{"intro":"short SMS-friendly line","options":[{"key":"a","label":"short name","nightlyRate":120,"vibe":"one line"}]}',
                        "Exactly 3 options. nightlyRate should be plausible USD for the destination and ~",
                        String(stayPortion),
                        " total stay budget spread across",
                        String(nights),
                        " nights (rough heuristic).",
                        "Reflect the user's preferences in the vibe/labels (quiet, party, walkable, boutique, etc.).",
                    ].join(" "),
                },
                {
                    role: "user",
                    content: `Destination: ${dest}. ~${nights} night(s). User said: "${hint}"`,
                },
            ],
        });
        const raw = response.choices[0]?.message?.content ?? "{}";
        const parsed = (0, json_1.safeJsonParse)((0, json_1.stripCodeFences)(raw), { intro: "", options: [] });
        if (!parsed.options?.length) {
            return null;
        }
        const options = parsed.options.slice(0, 3).map((o, i) => ({
            key: o.key ?? ["alt_a", "alt_b", "alt_c"][i] ?? `alt_${i}`,
            label: o.label.slice(0, 80),
            nightlyRate: Math.max(50, Math.round(Number(o.nightlyRate) || 100)),
            vibe: o.vibe.slice(0, 120),
        }));
        const intro = parsed.intro?.trim() ||
            `More stay ideas for ${dest} (~${nights} night${nights === 1 ? "" : "s"}) — pick a vibe:`;
        const text = [
            intro,
            ...options.map((option, index) => `${index + 1}. ${option.label} - $${option.nightlyRate}/night - ${option.vibe}`),
            "Reply with a favorite, or react 👍 to this message if one of these feels closer to what you want.",
        ].join("\n");
        return { options, text };
    }
    catch (error) {
        logger_1.logger.warn("OpenAI hotel alternatives failed", { err: String(error) });
        return null;
    }
}
async function extractTripPlanningPatch(input) {
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
            model: env_1.env.OPENAI_MODEL,
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
        const parsed = (0, json_1.safeJsonParse)((0, json_1.stripCodeFences)(raw), {});
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return parsed;
    }
    catch (error) {
        logger_1.logger.warn("OpenAI trip planning extract failed", { err: String(error) });
        return null;
    }
}
function phaseAntiRepetitionRules(tripState) {
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
async function generateContextualReply(ctx) {
    const trimmed = ctx.userMessage.trim();
    if (!trimmed) {
        return "Send a quick note about the trip — dates, budget, or who’s in.";
    }
    try {
        const notes = ctx.itineraryNotesPreview?.trim().slice(0, 450) ??
            "";
        const phaseRule = phaseAntiRepetitionRules(ctx.tripState);
        const notesHint = ctx.hasItineraryNotes && notes
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
            model: env_1.env.OPENAI_MODEL,
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
    }
    catch (error) {
        logger_1.logger.warn("OpenAI chat reply failed", { err: String(error) });
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
