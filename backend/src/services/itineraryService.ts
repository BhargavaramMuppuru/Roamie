export function buildStarterItinerary(input: {
  destination?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
}) {
  const destination = input.destination ?? "the city";
  const start = input.startDate ? input.startDate.toISOString().slice(0, 10) : "day 1";
  const end = input.endDate ? input.endDate.toISOString().slice(0, 10) : "day 3";

  return [
    `Day 1 (${start}): arrive, settle in, grab dinner nearby, keep the night easy.`,
    `Day 2: pick one main plan in ${destination}, leave the afternoon flexible, then do a group dinner.`,
    `Day 3 (${end}): slow morning, one last stop, then head out.`,
  ];
}

export function renderStarterItinerary(input: {
  destination?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  itineraryNotes?: string | null;
}) {
  const items = buildStarterItinerary(input);
  const lines = ["Here’s a simple starter itinerary:", ...items];
  if (input.itineraryNotes?.trim()) {
    lines.push("", "Saved group notes:", input.itineraryNotes.trim());
  }
  return lines.join("\n");
}
