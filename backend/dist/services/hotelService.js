"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nightsBetween = nightsBetween;
exports.buildHotelOptions = buildHotelOptions;
exports.renderHotelVoteMessage = renderHotelVoteMessage;
function nightsBetween(start, end) {
    if (!start || !end) {
        return 3;
    }
    const ms = end.getTime() - start.getTime();
    const d = Math.ceil(ms / 86_400_000);
    return Math.max(1, Math.min(d, 21));
}
function buildHotelOptions(input) {
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
function renderHotelVoteMessage(input) {
    const options = buildHotelOptions(input);
    const nights = nightsBetween(input.startDate, input.endDate);
    return {
        options,
        text: [
            `Stay options for ${input.destination ?? "the trip"} (~${nights} night${nights === 1 ? "" : "s"}):`,
            ...options.map((option, index) => `${index + 1}. ${option.label} - $${option.nightlyRate}/night - ${option.vibe}`),
            "Reply with your favorite, or react 👍 to this message if one of these works for you.",
        ].join("\n"),
    };
}
