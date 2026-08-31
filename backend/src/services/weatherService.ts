import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

function tripWindowLabel(start?: Date | null, end?: Date | null): string {
  if (!start && !end) {
    return "trip dates not set — use typical seasonal patterns for the destination";
  }
  const a = start ? start.toISOString().slice(0, 10) : "?";
  const b = end ? end.toISOString().slice(0, 10) : "?";
  return `${a} through ${b}`;
}

/**
 * Weather copy is generated with OpenAI only (no external weather APIs).
 * Framed as general travel-season guidance, not a live forecast.
 */
async function generateWeatherOutlook(input: {
  destination: string;
  startDate?: Date | null;
  endDate?: Date | null;
  compact: boolean;
}): Promise<string | null> {
  if (!env.OPENAI_API_KEY?.trim()) {
    logger.debug("OPENAI_API_KEY missing; skipping weather outlook");
    return null;
  }
  const dest = input.destination.trim();
  if (!dest) {
    return null;
  }
  const window = tripWindowLabel(input.startDate, input.endDate);

  const system =
    "You help group-trip travelers with plain-text SMS/iMessage. Output plain text only (no markdown). " +
    "You do not have live weather data: write typical seasonal expectations and packing hints for the destination and dates. " +
    "Clearly say this is general guidance, not a real-time forecast or official warning.";

  const user = input.compact
    ? `Destination: ${dest}. Window: ${window}.\n` +
        "Reply with ONE short paragraph (max ~400 characters) suitable as context inside a longer itinerary prompt."
    : `Destination: ${dest}\nTrip window: ${window}\n\n` +
        "Write a short weather outlook for travelers:\n" +
        "- If dates span multiple days, use a few bullet lines with • (max ~8 lines).\n" +
        "- Mention typical highs/lows tendency, rain/snow likelihood in that season, and one packing tip.\n" +
        "- End with a line that this is general guidance from a model, not live conditions.";

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.45,
      max_tokens: input.compact ? 200 : 500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim();
    if (!text || text.length < 12) {
      return null;
    }
    return text;
  } catch (error) {
    logger.warn("OpenAI weather outlook failed", { err: String(error) });
    return null;
  }
}

/**
 * Multi-line block for chat replies and itinerary context.
 */
export async function fetchTripWeatherSummary(input: {
  destination: string;
  startDate?: Date | null;
  endDate?: Date | null;
}): Promise<string | null> {
  return generateWeatherOutlook({
    destination: input.destination,
    startDate: input.startDate,
    endDate: input.endDate,
    compact: false,
  });
}

/** Compact paragraph for LLM context (itinerary generation). */
export async function fetchTripWeatherContextLine(input: {
  destination: string;
  startDate?: Date | null;
  endDate?: Date | null;
}): Promise<string | undefined> {
  const full = await generateWeatherOutlook({
    destination: input.destination,
    startDate: input.startDate,
    endDate: input.endDate,
    compact: true,
  });
  if (!full) {
    return undefined;
  }
  return full.slice(0, 550);
}

export async function formatTripWeatherChatReply(input: {
  destination?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
}): Promise<string> {
  const dest = input.destination?.trim();
  if (!dest) {
    return "Set a trip destination first, then ask again — I’ll tailor guidance to that place.";
  }
  const summary = await fetchTripWeatherSummary({
    destination: dest,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  if (!summary) {
    return `Couldn’t generate a weather outlook for “${dest}” right now. Check your OpenAI configuration and try again.`;
  }
  return `Here’s a quick outlook (model guidance, not live radar):\n\n${summary}`;
}
