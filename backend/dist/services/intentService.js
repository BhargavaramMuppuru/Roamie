"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseIntent = parseIntent;
const openai_1 = __importDefault(require("openai"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const json_1 = require("../utils/json");
const userId_1 = require("../utils/userId");
const openai = new openai_1.default({
    apiKey: env_1.env.OPENAI_API_KEY,
});
/** Matches common spend nouns — amount may appear before OR after (e.g. "Lunch at X $20"). */
const EXPENSE_KEYWORDS = /\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b/i;
function tryParseExpenseLine(message) {
    const m = message.trim();
    const subgroupLabel = extractSubgroupLabel(message);
    // $20 lunch / 15.50 for dinner / paid $8 uber
    const forward = m.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s+[^$\d]{0,120}?\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b/i);
    if (forward) {
        return {
            intent: "ADD_EXPENSE",
            amount: Number(forward[1]),
            description: forward[2],
            subgroupLabel,
        };
    }
    // lunch ... $20 / Dinner at Joe's $45.00
    const reverse = m.match(/\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b[\s\S]{0,160}?\$?\s*(\d+(?:\.\d{1,2})?)\s*$/i);
    if (reverse) {
        return {
            intent: "ADD_EXPENSE",
            amount: Number(reverse[2]),
            description: reverse[1],
            subgroupLabel,
        };
    }
    // Keyword present + any dollar amount in the message (e.g. long descriptions)
    if (EXPENSE_KEYWORDS.test(m)) {
        const amt = m.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
        if (amt) {
            return {
                intent: "ADD_EXPENSE",
                amount: Number(amt[1]),
                description: m.slice(0, 120),
                subgroupLabel,
            };
        }
    }
    return null;
}
const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
function monthNumber(name) {
    const index = MONTHS.indexOf(name.toLowerCase());
    return index === -1 ? null : index + 1;
}
function toIsoDate(monthName, day) {
    const month = monthNumber(monthName);
    if (!month) {
        return undefined;
    }
    const year = new Date().getFullYear();
    return `${year}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}
/**
 * Pull trip dates from free text. Supports:
 * - Same month: "April 20-25", "April 20 – 25", "may 13-16"
 * - Cross month: "April 20 to May 3", "April 20 - May 3" (spaces optional around dash/to)
 */
function parseTripDateRange(message) {
    const month = "(january|february|march|april|may|june|july|august|september|october|november|december)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    // Same calendar month: "April 20-25", "April 20 to 25", "may 13-16"
    const sameMonth = message.match(new RegExp(`\\b${month}\\s+${day}\\s*(?:to|[-–])\\s*${day}\\b`, "i"));
    if (sameMonth) {
        return {
            startMonth: sameMonth[1],
            startDay: sameMonth[2],
            endMonth: sameMonth[1],
            endDay: sameMonth[3],
        };
    }
    // e.g. "April 28 to May 2", "April 28 - May 2"
    const crossMonth = message.match(new RegExp(`\\b${month}\\s+${day}\\s*(?:to|[-–])\\s*(?:${month}\\s+)?${day}\\b`, "i"));
    if (crossMonth) {
        return {
            startMonth: crossMonth[1],
            startDay: crossMonth[2],
            endMonth: crossMonth[3] ?? crossMonth[1],
            endDay: crossMonth[4],
        };
    }
    return null;
}
function parseCreateTripDetails(text) {
    const message = text.trim();
    if (!/\b(trip|weekend|getaway|vacation)\b/i.test(message)) {
        return null;
    }
    const destinationMatch = message.match(/^([a-zA-Z][a-zA-Z\s]+?)\s+(trip|weekend|getaway|vacation)\b/i);
    const budgetMatch = message.match(/\$ ?(\d+(?:\.\d{1,2})?)/i);
    const attendeesMatch = message.match(/\b(\d+)\s+(people|friends|guys|girls|travelers|travellers)\b/i);
    const range = parseTripDateRange(message);
    const startMonth = range?.startMonth;
    const startDay = range?.startDay;
    const endMonth = range?.endMonth;
    const endDay = range?.endDay;
    return {
        intent: "CREATE_TRIP",
        title: destinationMatch?.[1]?.trim(),
        destination: destinationMatch?.[1]?.trim(),
        budget: budgetMatch ? Number(budgetMatch[1]) : undefined,
        attendees: attendeesMatch ? Number(attendeesMatch[1]) : undefined,
        startDate: startMonth && startDay ? toIsoDate(startMonth, startDay) : undefined,
        endDate: endMonth && endDay ? toIsoDate(endMonth, endDay) : undefined,
    };
}
function extractSubgroupLabel(message) {
    const q = message.match(/\bsubgroup\s+["']?([^"'\n]+?)["']?(?:\s|$)/i);
    if (q) {
        return q[1].trim();
    }
    const forThe = message.match(/\bfor\s+the\s+([\w\s-]{1,40})\s+subgroup/i);
    if (forThe) {
        return forThe[1].trim();
    }
    return undefined;
}
function parseGroupTripInvite(text) {
    const matches = text.match(/(?:\+1\d{10}|\+?\d{10,15})/g) ?? [];
    if (matches.length === 0) {
        return null;
    }
    const invitees = Array.from(new Set(matches.map(userId_1.normalizeParticipantId)));
    const inviteMessage = text.replace(/(?:\+1\d{10}|\+?\d{10,15})/g, "").replace(/\s+/g, " ").trim();
    return {
        intent: "CREATE_GROUP_TRIP",
        invitees,
        inviteMessage: inviteMessage || "Are you interested in joining the trip?",
    };
}
function ruleBasedIntent(text) {
    const message = text.trim();
    if (!message) {
        return { intent: "UNKNOWN" };
    }
    const appendIt = message.match(/^(?:add to itinerary|itinerary note)\s*:?\s*(.+)$/is);
    if (appendIt?.[1]?.trim()) {
        return { intent: "APPEND_ITINERARY", itineraryLine: appendIt[1].trim() };
    }
    const tagSub = message.match(/^(?:my\s+subgroup\s+is|subgroup|tag)\s*:?\s*(.+)$/i);
    if (tagSub?.[1]?.trim()) {
        return { intent: "TAG_SUBGROUP", subgroupTag: tagSub[1].trim().slice(0, 80) };
    }
    if (/^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u.test(message)) {
        return { intent: "CONFIRM_ATTENDANCE", arrivalNote: "Confirmed with emoji" };
    }
    if (/^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿)$/u.test(message)) {
        return { intent: "DECLINE_ATTENDANCE" };
    }
    if (/^(yes|i'm in|im in|count me in)\b/i.test(message)) {
        return {
            intent: "CONFIRM_ATTENDANCE",
            arrivalNote: message,
        };
    }
    if (/^(no|can't make it|cant make it|out)\b/i.test(message)) {
        return { intent: "DECLINE_ATTENDANCE" };
    }
    const expenseIntent = tryParseExpenseLine(message);
    if (expenseIntent) {
        return expenseIntent;
    }
    if (/\b(?:more|other|different|another)\s+(?:hotel|stay|stays|accommodation|options?)\b/i.test(message) ||
        /\b(?:hotel|stay)\s+(?:options?|ideas?)\s+(?:please|more|again|other)\b/i.test(message) ||
        (/\b(?:want|need)\s+(?:more|different|other)\b/i.test(message) &&
            /\b(?:hotel|stay|accommodation|options?)\b/i.test(message)) ||
        (/\bnot\s+(?:my\s+)?(?:preference|preferences|style|vibe)\b/i.test(message) &&
            /\b(?:hotel|stay|these|options?)\b/i.test(message))) {
        return { intent: "REQUEST_MORE_HOTELS" };
    }
    if (/\bhotels?\b|\bstays?\b|find\s+(?:a\s+)?(?:hotel|stay|accommodation)|book\s+(?:a\s+)?(?:hotel|stay)|where\s+should\s+(?:we|i)\s+stay/i.test(message)) {
        return { intent: "REQUEST_HOTELS" };
    }
    if (/\bitinerary\b|plan the (?:day|itinerary)|what are (?:we|i) doing/i.test(message)) {
        return { intent: "REQUEST_ITINERARY" };
    }
    if (/paid|sent it|venmoed|zelle'd|zelled/i.test(message)) {
        return { intent: "MARK_PAID" };
    }
    if (/settle up|who owes|split up|what do i owe|balance/i.test(message)) {
        return { intent: "REQUEST_SETTLEMENT" };
    }
    if (/we'?re here|trip started|start the trip|we arrived/i.test(message)) {
        return { intent: "START_TRIP" };
    }
    if (/close trip|wrap it up|done with the trip|end trip/i.test(message)) {
        return { intent: "CLOSE_TRIP" };
    }
    const groupTripInvite = parseGroupTripInvite(message);
    if (groupTripInvite) {
        return groupTripInvite;
    }
    const tripDetails = parseCreateTripDetails(message);
    if (tripDetails) {
        return tripDetails;
    }
    return null;
}
const ALLOWED_INTENTS = new Set([
    "CREATE_GROUP_TRIP",
    "CREATE_TRIP",
    "CONFIRM_ATTENDANCE",
    "DECLINE_ATTENDANCE",
    "REQUEST_HOTELS",
    "REQUEST_MORE_HOTELS",
    "REQUEST_ITINERARY",
    "ADD_EXPENSE",
    "REQUEST_SETTLEMENT",
    "MARK_PAID",
    "START_TRIP",
    "CLOSE_TRIP",
    "ADVANCE_STAGE",
    "TAG_SUBGROUP",
    "APPEND_ITINERARY",
    "UNKNOWN",
]);
function tripPlanningExtractHasData(p) {
    return Boolean(p.destination?.trim() ||
        (p.budget != null && !Number.isNaN(Number(p.budget))) ||
        p.startDate?.trim() ||
        p.endDate?.trim() ||
        p.appendItineraryNote?.trim());
}
function coerceNumber(v) {
    if (v == null || v === "") {
        return undefined;
    }
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
}
function normalizeParsedIntent(raw) {
    const intentRaw = raw.intent;
    const intent = typeof intentRaw === "string" && ALLOWED_INTENTS.has(intentRaw)
        ? intentRaw
        : "UNKNOWN";
    const out = {
        intent,
        destination: typeof raw.destination === "string" ? raw.destination : undefined,
        title: typeof raw.title === "string" ? raw.title : undefined,
        budget: coerceNumber(raw.budget),
        amount: coerceNumber(raw.amount),
        description: typeof raw.description === "string" ? raw.description : undefined,
        attendees: coerceNumber(raw.attendees),
        startDate: typeof raw.startDate === "string" ? raw.startDate : undefined,
        endDate: typeof raw.endDate === "string" ? raw.endDate : undefined,
        arrivalNote: typeof raw.arrivalNote === "string" ? raw.arrivalNote : undefined,
        subgroupLabel: typeof raw.subgroupLabel === "string" ? raw.subgroupLabel : undefined,
        subgroupTag: typeof raw.subgroupTag === "string" ? raw.subgroupTag : undefined,
        itineraryLine: typeof raw.itineraryLine === "string" ? raw.itineraryLine : undefined,
        inviteMessage: typeof raw.inviteMessage === "string" ? raw.inviteMessage : undefined,
        invitees: Array.isArray(raw.invitees) ? raw.invitees.filter((x) => typeof x === "string") : undefined,
    };
    const tpe = raw.tripPlanningExtract;
    if (tpe && typeof tpe === "object" && !Array.isArray(tpe)) {
        const patch = tpe;
        if (tripPlanningExtractHasData(patch)) {
            out.tripPlanningExtract = patch;
        }
    }
    return out;
}
const INTENT_JSON_SYSTEM_PROMPT = [
    "You classify and extract structured data from short SMS-style messages for Roamie (group trip assistant).",
    "Return ONE JSON object only. Use camelCase keys exactly as specified.",
    'Required key: "intent" — one of: CREATE_GROUP_TRIP, CREATE_TRIP, CONFIRM_ATTENDANCE, DECLINE_ATTENDANCE, REQUEST_HOTELS, REQUEST_MORE_HOTELS, REQUEST_ITINERARY, ADD_EXPENSE, REQUEST_SETTLEMENT, MARK_PAID, START_TRIP, CLOSE_TRIP, ADVANCE_STAGE, TAG_SUBGROUP, APPEND_ITINERARY, UNKNOWN.',
    "Include optional fields only when clearly stated:",
    "- CREATE_TRIP / CREATE_GROUP_TRIP: destination, title, budget, attendees, startDate, endDate (ISO yyyy-mm-dd). Same-month ranges like 'April 20-25' are April 20 through April 25; invitees (E.164 phones), inviteMessage.",
    "- ADD_EXPENSE: amount (number), description (short), subgroupLabel if they name a subgroup.",
    "- APPEND_ITINERARY: itineraryLine.",
    "- TAG_SUBGROUP: subgroupTag.",
    "- tripPlanningExtract (optional object): use when the message adds or refines trip facts even if intent is UNKNOWN or chatty — destination, budget (number), startDate, endDate (ISO), appendItineraryNote (short, e.g. budget split). Omit tripPlanningExtract if nothing new.",
    "ADD_EXPENSE: any phrasing with a spend and amount — e.g. 'Lunch at Cheesecake $20', '$15 uber', 'paid 40 for gas'.",
    "REQUEST_MORE_HOTELS: user wants different/more stay options or did not like prior picks.",
    "CONFIRM_ATTENDANCE / DECLINE_ATTENDANCE: yes/no, thumbs, can't make it.",
    "Use UNKNOWN only when nothing else fits; you may still fill tripPlanningExtract if they only shared dates/budget.",
    "Do not invent amounts, dates, or destinations you are not confident about.",
].join(" ");
async function parseIntentWithOpenAI(text) {
    const response = await openai.chat.completions.create({
        model: env_1.env.OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: INTENT_JSON_SYSTEM_PROMPT },
            { role: "user", content: text },
        ],
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsedObj = (0, json_1.safeJsonParse)((0, json_1.stripCodeFences)(raw), {});
    return normalizeParsedIntent(parsedObj);
}
/**
 * OpenAI for natural language + optional tripPlanningExtract.
 * Regex expense lines run first when they match — the model often mislabels
 * "Lunch at X $20" as chat/planning, which would skip rule fallback entirely.
 */
async function parseIntent(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return { intent: "UNKNOWN" };
    }
    const expenseLine = tryParseExpenseLine(trimmed);
    if (expenseLine) {
        try {
            const ai = await parseIntentWithOpenAI(trimmed);
            if (ai.intent === "ADD_EXPENSE" && ai.amount != null && ai.description?.trim()) {
                return ai;
            }
            if (ai.tripPlanningExtract && tripPlanningExtractHasData(ai.tripPlanningExtract)) {
                return { ...expenseLine, tripPlanningExtract: ai.tripPlanningExtract };
            }
        }
        catch {
            /* use expense line below */
        }
        return expenseLine;
    }
    try {
        const ai = await parseIntentWithOpenAI(trimmed);
        if (ai.intent !== "UNKNOWN") {
            return ai;
        }
    }
    catch (error) {
        logger_1.logger.warn("OpenAI intent parse failed; using rule fallback", { err: String(error) });
    }
    const fromRules = ruleBasedIntent(trimmed);
    if (fromRules && fromRules.intent !== "UNKNOWN") {
        return fromRules;
    }
    const trip = parseCreateTripDetails(trimmed);
    if (trip) {
        return trip;
    }
    return { intent: "UNKNOWN" };
}
