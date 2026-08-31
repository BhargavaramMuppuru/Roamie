import { messageBlocks } from "../utils/chatCopy";

export type HotelOption = {
  key: string;
  label: string;
  nightlyRate: number;
  vibe: string;
};

export function nightsBetween(start?: Date | null, end?: Date | null): number {
  if (!start || !end) {
    return 3;
  }
  const ms = end.getTime() - start.getTime();
  const d = Math.ceil(ms / 86_400_000);
  return Math.max(1, Math.min(d, 21));
}

export function buildHotelOptions(input: {
  destination?: string | null;
  budget?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
}): HotelOption[] {
  const budget = input.budget ?? 900;
  const destination = input.destination ?? "your destination";
  const nights = nightsBetween(input.startDate, input.endDate);
  const stayBudgetPortion = budget * 0.45;
  const nightlyBase = Math.max(85, Math.round(stayBudgetPortion / Math.max(nights, 1)));

  return [
    {
      key: "budget",
      label: `${destination} Budget Pick`,
      nightlyRate: nightlyBase,
      vibe: "cheap, central, good enough for a group",
    },
    {
      key: "balanced",
      label: `${destination} Balanced Pick`,
      nightlyRate: nightlyBase + Math.round(55 + nights * 2),
      vibe: "solid amenities, easier for group coordination",
    },
    {
      key: "splashy",
      label: `${destination} Splashy Pick`,
      nightlyRate: nightlyBase + Math.round(120 + nights * 3),
      vibe: "nicer rooms, better social basecamp, pricier",
    },
  ];
}

export function renderHotelVoteMessage(input: {
  destination?: string | null;
  budget?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
}) {
  const options = buildHotelOptions(input);
  const nights = nightsBetween(input.startDate, input.endDate);

  const header = `Stay options for ${input.destination ?? "the trip"} (~${nights} night${nights === 1 ? "" : "s"}):`;
  const list = options
    .map((option, index) => `${index + 1}. ${option.label} — $${option.nightlyRate}/night — ${option.vibe}`)
    .join("\n");
  return {
    options,
    text: messageBlocks(
      header,
      list,
      "Reply with 1, 2, or 3 to vote (tapbacks don’t count).",
    ),
  };
}

/** Default 3-option food poll when AI is unavailable. */
export function buildDefaultFoodOptions(destination?: string | null): HotelOption[] {
  const d = destination?.trim() || "the area";
  return [
    {
      key: "casual",
      label: `${d} — casual & quick`,
      nightlyRate: 35,
      vibe: "easy spots, low stress",
    },
    {
      key: "sitdown",
      label: `${d} — sit-down group dinner`,
      nightlyRate: 70,
      vibe: "nicer meal, plan ahead",
    },
    {
      key: "special",
      label: `${d} — special night`,
      nightlyRate: 120,
      vibe: "celebration energy, splurge",
    },
  ];
}

/** Default 3-option activity poll when AI is unavailable. */
export function buildDefaultActivityOptions(destination?: string | null): HotelOption[] {
  const d = destination?.trim() || "the destination";
  return [
    {
      key: "chill",
      label: "Chill / low-key day",
      nightlyRate: 25,
      vibe: "coffee, walks, one light anchor",
    },
    {
      key: "classic",
      label: "Classic sights mix",
      nightlyRate: 55,
      vibe: "museums, neighborhoods, photo stops",
    },
    {
      key: "go",
      label: "High-energy day",
      nightlyRate: 90,
      vibe: "tour, show, or adventure block",
    },
  ];
}

export function renderOptionPollLines(input: {
  intro: string;
  options: HotelOption[];
  pollKind: "stay" | "food" | "activity";
}): string {
  const rate = (o: HotelOption, i: number) =>
    input.pollKind === "stay"
      ? `$${o.nightlyRate}/night`
      : `~$${o.nightlyRate}/person`;
  const list = input.options
    .map((option, index) => `${index + 1}. ${option.label} — ${rate(option, index)} — ${option.vibe}`)
    .join("\n");
  return messageBlocks(input.intro, list, "Reply with 1, 2, or 3 to vote (tapbacks don’t count).");
}
