import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { safeJsonParse, stripCodeFences } from "../utils/json";
import type { TripPlanningPatch } from "./openaiTripContent";
import { normalizeParticipantId } from "../utils/userId";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

export type ParsedIntent = {
  intent:
    | "CREATE_GROUP_TRIP"
    | "CREATE_TRIP"
    | "CONFIRM_ATTENDANCE"
    | "DECLINE_ATTENDANCE"
    | "REQUEST_HOTELS"
    | "REQUEST_MORE_HOTELS"
    | "REQUEST_RESTAURANTS"
    | "REQUEST_MORE_RESTAURANTS"
    | "REQUEST_ACTIVITIES"
    | "REQUEST_MORE_ACTIVITIES"
    | "REQUEST_MEAL_RSVP"
    | "REQUEST_ITINERARY"
    | "REQUEST_WEATHER"
    | "REQUEST_SPLIT_HISTORY"
    | "REQUEST_MY_SPLITS"
    | "RECORD_PARTIAL_PAYMENT"
    | "ADD_EXPENSE"
    | "DELETE_EXPENSE"
    | "EDIT_EXPENSE"
    | "REQUEST_SETTLEMENT"
    | "MARK_PAID"
    | "START_TRIP"
    | "CLOSE_TRIP"
    | "ADVANCE_STAGE"
    | "TAG_SUBGROUP"
    | "APPEND_ITINERARY"
    | "FINALIZE_POLL"
    | "SET_DISPLAY_NAME"
    | "SET_CONTACT_NAMES"
    | "UNKNOWN";
  destination?: string;
  title?: string;
  budget?: number;
  amount?: number;
  description?: string;
  attendees?: number;
  startDate?: string;
  endDate?: string;
  arrivalNote?: string;
  subgroupLabel?: string;
  subgroupTag?: string;
  itineraryLine?: string;
  invitees?: string[];
  inviteMessage?: string;
  /** Optional facts to merge onto Trip (from AI parse); same shape as heuristic planning extract. */
  tripPlanningExtract?: TripPlanningPatch;
  /** Short label for a meal / event RSVP poll (from user message). */
  rsvpTopic?: string;
  /** Lock option 1–3 when finalizing a poll (optional). */
  finalizeOptionIndex?: 1 | 2 | 3;
  /**
   * Who owes their share (equal split among them). The payer (message sender) is never included.
   * Parsed from e.g. "uber $20 for Sam and Jordan", "split between A and B", "$30 to Chris".
   */
  splitAmongNames?: string[];
  /**
   * Extra dollars on top of that person’s equal share of `amount` (total expense = amount + sum(bonuses)).
   * E.g. "$20 uber split between Sam and Jordan and for Jordan +$10" → Sam $10, Jordan $20, total $30.
   */
  splitBonuses?: Array<{ name: string; addAmount: number }>;
  /**
   * Fully custom shares that sum to `amount`, e.g. "$20 uber Sam $7 Jordan $13".
   * Names must match confirmed travelers; payer is omitted from this list.
   */
  splitExplicitAmounts?: Array<{ name: string; amount: number }>;
  /** 1 = most recent expense the sender is allowed to change (payer or trip creator). */
  targetExpenseIndex?: number;
  /** Match expense.description (substring, case-insensitive). */
  targetExpenseDescription?: string;
  editExpenseNewAmount?: number;
  editExpenseNewDescription?: string;
  /** Sender’s display name on this trip (when intent is SET_DISPLAY_NAME). */
  manualDisplayName?: string;
  /** Map E.164 handles to names for people already on the trip (SET_CONTACT_NAMES). */
  phoneNamePairs?: Array<{ phone: string; name: string }>;
};

/** Matches common spend nouns — amount may appear before OR after (e.g. "Lunch at X $20"). */
const EXPENSE_KEYWORDS =
  /\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b/i;

export function buildExpenseSplitFields(message: string, receiptAmount: number): Partial<ParsedIntent> {
  const explicitPairs = extractExplicitNameAmountPairs(message);
  if (explicitPairs.length >= 2) {
    const sumS = explicitPairs.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(sumS - receiptAmount) <= 0.051) {
      return { splitExplicitAmounts: explicitPairs };
    }
  }
  const splitBonuses = extractSplitBonuses(message);
  const stripped = stripSplitBonusClauses(message);
  const splitAmongNames = extractSplitAmongNames(stripped);
  return {
    ...(splitAmongNames?.length ? { splitAmongNames } : {}),
    ...(splitBonuses.length ? { splitBonuses } : {}),
  };
}

function tryParsePartialPayment(message: string): ParsedIntent | null {
  const m = message.trim();
  const patterns = [
    /^(?:paid|pay|sent|send|record)\s+\$?\s*(\d+(?:\.\d{1,2})?)\s+partial(?:\s+payment)?\b/i,
    /^partial(?:\s+payment)?\s+\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
    /^\$?\s*(\d+(?:\.\d{1,2})?)\s+partial(?:\s+payment)?$/i,
  ];
  for (const re of patterns) {
    const x = m.match(re);
    if (x?.[1]) {
      const amount = Number(x[1]);
      if (amount > 0) {
        return { intent: "RECORD_PARTIAL_PAYMENT", amount };
      }
    }
  }
  return null;
}

function tryParseExpenseLine(message: string): ParsedIntent | null {
  const m = message.trim();
  // Avoid treating edit/delete commands as brand-new expense logs.
  if (/^(?:edit|update|change|delete|remove|cancel)\b/i.test(m)) {
    return null;
  }
  const subgroupLabel = extractSubgroupLabel(message);

  // $20 lunch / 15.50 for dinner / paid $8 uber
  const forward = m.match(
    /\$?\s*(\d+(?:\.\d{1,2})?)\s+[^$\d]{0,120}?\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b/i,
  );
  if (forward) {
    const receiptAmount = Number(forward[1]);
    return {
      intent: "ADD_EXPENSE",
      amount: receiptAmount,
      description: forward[2],
      subgroupLabel,
      ...buildExpenseSplitFields(m, receiptAmount),
    };
  }

  // lunch ... $20 / Dinner at Joe's $45.00
  const reverse = m.match(
    /\b(dinner|lunch|breakfast|brunch|uber|lyft|taxi|hotel|airbnb|tickets|drinks|club|gas|coffee|meal|meals|food|snack|parking|restaurant|bar)\b[\s\S]{0,160}?\$?\s*(\d+(?:\.\d{1,2})?)\s*$/i,
  );
  if (reverse) {
    const receiptAmount = Number(reverse[2]);
    return {
      intent: "ADD_EXPENSE",
      amount: receiptAmount,
      description: reverse[1],
      subgroupLabel,
      ...buildExpenseSplitFields(m, receiptAmount),
    };
  }

  // Keyword present + any dollar amount in the message (e.g. long descriptions)
  if (EXPENSE_KEYWORDS.test(m)) {
    const amt = m.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    if (amt) {
      const receiptAmount = Number(amt[1]);
      return {
        intent: "ADD_EXPENSE",
        amount: receiptAmount,
        description: m.slice(0, 120),
        subgroupLabel,
        ...buildExpenseSplitFields(m, receiptAmount),
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
] as const;

function monthNumber(name: string): number | null {
  const index = MONTHS.indexOf(name.toLowerCase() as (typeof MONTHS)[number]);
  return index === -1 ? null : index + 1;
}

function toIsoDate(monthName: string, day: string): string | undefined {
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
function parseTripDateRange(message: string): {
  startMonth: string;
  startDay: string;
  endMonth: string;
  endDay: string;
} | null {
  const month =
    "(january|february|march|april|may|june|july|august|september|october|november|december)";
  const day = "(\\d{1,2})(?:st|nd|rd|th)?";

  // Same calendar month: "April 20-25", "April 20 to 25", "may 13-16"
  const sameMonth = message.match(
    new RegExp(`\\b${month}\\s+${day}\\s*(?:to|[-–])\\s*${day}\\b`, "i"),
  );
  if (sameMonth) {
    return {
      startMonth: sameMonth[1],
      startDay: sameMonth[2],
      endMonth: sameMonth[1],
      endDay: sameMonth[3],
    };
  }

  // e.g. "April 28 to May 2", "April 28 - May 2"
  const crossMonth = message.match(
    new RegExp(
      `\\b${month}\\s+${day}\\s*(?:to|[-–])\\s*(?:${month}\\s+)?${day}\\b`,
      "i",
    ),
  );
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

const MONTH_NAME_PATTERN =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december)";

/**
 * Destination for CREATE_TRIP: "Miami trip", "Vegas May 20-23", "go to Vegas May …", etc.
 * SMS users often omit the word "trip" — we still infer from place + dates/budget.
 */
function extractCreateTripDestination(message: string): string | undefined {
  const legacy = message.match(/^([a-zA-Z][a-zA-Z\s]+?)\s+(trip|weekend|getaway|vacation)\b/i);
  if (legacy?.[1]?.trim()) {
    return legacy[1].trim();
  }

  const goTo = message.match(
    new RegExp(
      `\\bgo\\s+to\\s+([A-Za-z][a-zA-Z0-9'\\s-]{0,40}?)\\s+${MONTH_NAME_PATTERN}\\b`,
      "i",
    ),
  );
  if (goTo?.[1]?.trim()) {
    return goTo[1].trim();
  }

  const titledBeforeMonth = message.match(
    new RegExp(
      `^([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+${MONTH_NAME_PATTERN}\\b`,
      "i",
    ),
  );
  if (titledBeforeMonth?.[1]?.trim()) {
    const cand = titledBeforeMonth[1].trim();
    if (!/^(We|They|I|You|Let|The|If|Oh|Hey|Hi)\b/.test(cand)) {
      return cand;
    }
  }

  const tripFor = message.match(/\btrip\s+(?:for|to)\s+([A-Za-z][a-zA-Z0-9'\s-]{1,40})\b/i);
  if (tripFor?.[1]?.trim()) {
    return tripFor[1].trim();
  }

  return undefined;
}

function parseCreateTripDetails(text: string): ParsedIntent | null {
  const message = text.trim();

  const destination = extractCreateTripDestination(message);
  const budgetMatch = message.match(/\$ ?(\d+(?:\.\d{1,2})?)/i);
  const attendeesMatch = message.match(/\b(\d+)\s+(people|friends|guys|girls|travelers|travellers)\b/i);
  const range = parseTripDateRange(message);

  const hasTripWord = /\b(trip|weekend|getaway|vacation)\b/i.test(message);
  if (!destination) {
    return null;
  }

  if (!hasTripWord && !range && !budgetMatch) {
    return null;
  }

  const startMonth = range?.startMonth;
  const startDay = range?.startDay;
  const endMonth = range?.endMonth;
  const endDay = range?.endDay;

  return {
    intent: "CREATE_TRIP",
    title: destination,
    destination,
    budget: budgetMatch ? Number(budgetMatch[1]) : undefined,
    attendees: attendeesMatch ? Number(attendeesMatch[1]) : undefined,
    startDate: startMonth && startDay ? toIsoDate(startMonth, startDay) : undefined,
    endDate: endMonth && endDay ? toIsoDate(endMonth, endDay) : undefined,
  };
}

function extractSubgroupLabel(message: string): string | undefined {
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

/** Remove "… and for Jordan +$10" clauses so split-between / for-name lists parse cleanly. */
export function stripSplitBonusClauses(message: string): string {
  return message
    .replace(/\b(?:and\s+)?for\s+[A-Za-z][a-zA-Z']*\s*\+\s*\$?\s*\d+(?:\.\d{1,2})?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Per-person add-ons like "for Jordan +$10" or "and for Sam +$5" (added on top of equal shares of `amount`).
 */
const NOT_PERSON_NAME_TOKENS = new Set([
  "uber",
  "lyft",
  "taxi",
  "dinner",
  "lunch",
  "breakfast",
  "brunch",
  "gas",
  "hotel",
  "airbnb",
  "tickets",
  "drinks",
  "split",
  "between",
  "among",
  "owed",
  "for",
  "the",
  "and",
  "with",
  "to",
  "a",
  "an",
  "total",
  "paid",
  "trip",
  "day",
  "days",
  "meal",
  "meals",
  "food",
  "snack",
  "parking",
  "restaurant",
  "bar",
  "coffee",
  "club",
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
]);

/**
 * "Sam $7 Jordan $13" style pairs. Caller should confirm sum matches receipt total before using.
 */
export function extractExplicitNameAmountPairs(message: string): Array<{ name: string; amount: number }> {
  const re = /\b([A-Za-z][a-zA-Z']{1,24})\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/g;
  const pairs: Array<{ name: string; amount: number }> = [];
  let m;
  while ((m = re.exec(message)) !== null) {
    const name = m[1];
    const lower = name.toLowerCase();
    if (NOT_PERSON_NAME_TOKENS.has(lower)) {
      continue;
    }
    pairs.push({ name, amount: Number(m[2]) });
  }
  return pairs;
}

export function extractSplitBonuses(message: string): Array<{ name: string; addAmount: number }> {
  const merged = new Map<string, number>();
  const re = /\b(?:and\s+)?for\s+([A-Za-z][a-zA-Z']*)\s*\+\s*\$?\s*(\d+(?:\.\d{1,2})?)/gi;
  let m;
  while ((m = re.exec(message)) !== null) {
    const name = m[1].trim();
    const add = Number(m[2]);
    if (!Number.isNaN(add) && add >= 0) {
      merged.set(name, (merged.get(name) ?? 0) + add);
    }
  }
  return Array.from(merged.entries()).map(([name, addAmount]) => ({ name, addAmount }));
}

function parseNameListFragment(fragment: string): string[] {
  const cleaned = fragment
    .replace(/\s+only\s*$/i, "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!cleaned || /\bsubgroup\b/i.test(cleaned)) {
    return [];
  }
  return cleaned
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Names of people who should owe an equal share (payer excluded later). Not subgroup labels.
 */
export function extractSplitAmongNames(message: string): string[] | undefined {
  const m = message.trim();

  const tryPatterns = [
    /\bsplit\s+between\s+(.+?)(?:\.|$)/i,
    /\bsplit\s+among\s+(.+?)(?:\.|$)/i,
    /\bowed\s+by\s+(.+?)(?:\.|$)/i,
    /\bto\s+(.+?)(?:\.|$)/i,
  ];

  for (const re of tryPatterns) {
    const match = m.match(re);
    if (match?.[1]) {
      const names = parseNameListFragment(match[1]);
      if (names.length > 0) {
        return names;
      }
    }
  }

  const forMatch = m.match(/\bfor\s+(.+?)(?:\.|$)/i);
  if (forMatch?.[1]) {
    const fragment = forMatch[1].trim();
    if (/^the\s+/i.test(fragment) && /\bsubgroup\b/i.test(fragment)) {
      return undefined;
    }
    if (/^the\s+\w+\s+subgroup$/i.test(fragment)) {
      return undefined;
    }
    const names = parseNameListFragment(fragment);
    if (names.length === 0) {
      return undefined;
    }
    if (
      names.length === 1 &&
      /^(dinner|lunch|breakfast|brunch|gas|uber|lyft|taxi|parking|snacks?)$/i.test(names[0])
    ) {
      return undefined;
    }
    return names;
  }

  return undefined;
}

function parseFinalizePollIntent(message: string): ParsedIntent | null {
  const m = message.trim();
  const explicit =
    m.match(/^(?:finalize|final|lock)\s*(?:in\s*)?(\d)\b/i) ||
    m.match(/^pick\s*(?:option\s*)?(\d)\s*(?:as\s+)?(?:final|the\s+winner|winner)\b/i) ||
    m.match(/^option\s*(\d)\s*(?:wins|is\s+(?:the\s+)?final)\b/i);
  if (explicit?.[1]) {
    const n = Number(explicit[1]);
    if (n >= 1 && n <= 3) {
      return { intent: "FINALIZE_POLL", finalizeOptionIndex: n as 1 | 2 | 3 };
    }
  }
  if (
    /^(?:finalize|final)\s*poll\b/i.test(m) ||
    /^(?:close|end)\s+(?:the\s+)?poll\b/i.test(m) ||
    /^pick\s+(?:a\s+)?winner\b/i.test(m) ||
    /^who\s+won\b/i.test(m) ||
    /^call\s+(?:the\s+)?vote\b/i.test(m)
  ) {
    return { intent: "FINALIZE_POLL" };
  }
  return null;
}

function parseGroupTripInvite(text: string): ParsedIntent | null {
  const matches = text.match(/(?:\+1\d{10}|\+?\d{10,15})/g) ?? [];
  if (matches.length === 0) {
    return null;
  }

  const invitees = Array.from(new Set(matches.map(normalizeParticipantId)));
  const inviteMessage = text.replace(/(?:\+1\d{10}|\+?\d{10,15})/g, "").replace(/\s+/g, " ").trim();

  return {
    intent: "CREATE_GROUP_TRIP",
    invitees,
    inviteMessage: inviteMessage || "Are you interested in joining the trip?",
  };
}

/** Tight regex fallbacks; natural phrasing is handled by OpenAI (DELETE_EXPENSE / EDIT_EXPENSE). */
function parseExpenseMutationIntent(message: string): ParsedIntent | null {
  const m = message.trim();
  if (!m) {
    return null;
  }

  if (/^(?:delete|remove|cancel)\s+(?:my\s+)?(?:the\s+)?last\s+expense\b/i.test(m)) {
    return { intent: "DELETE_EXPENSE", targetExpenseIndex: 1 };
  }
  const delNum = m.match(/^(?:delete|remove|cancel)\s+expense\s*#?(\d+)\b/i);
  if (delNum?.[1]) {
    const n = Number(delNum[1]);
    if (n >= 1) {
      return { intent: "DELETE_EXPENSE", targetExpenseIndex: n };
    }
  }

  const editLastAmt = m.match(
    /^(?:edit|change|update)\s+(?:my\s+)?(?:the\s+)?last\s+expense\s+(?:to\s+)?\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (editLastAmt?.[1]) {
    return {
      intent: "EDIT_EXPENSE",
      targetExpenseIndex: 1,
      editExpenseNewAmount: Number(editLastAmt[1]),
    };
  }
  const editPreviousAmt = m.match(
    /^(?:edit|change|update)\s+(?:my\s+)?previous\s+expense\s+(?:to\s+)?\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (editPreviousAmt?.[1]) {
    return {
      intent: "EDIT_EXPENSE",
      targetExpenseIndex: 1,
      editExpenseNewAmount: Number(editPreviousAmt[1]),
    };
  }

  const editNumAmt = m.match(
    /^(?:edit|change|update)\s+expense\s*#?(\d+)\s+(?:to\s+)?\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (editNumAmt?.[1] && editNumAmt?.[2]) {
    return {
      intent: "EDIT_EXPENSE",
      targetExpenseIndex: Number(editNumAmt[1]),
      editExpenseNewAmount: Number(editNumAmt[2]),
    };
  }

  const editDescAmt = m.match(
    /^(?:edit|change|update)\s+(.+?)\s+(?:expense\s+)?(?:to\s+)?\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (editDescAmt?.[1] && editDescAmt?.[2]) {
    const desc = editDescAmt[1]
      .replace(/\b(?:my|the|previous|last)\s+expense\b/gi, "")
      .replace(/\bexpense\b/gi, "")
      .trim()
      .slice(0, 120);
    if (/^(?:my|the|previous|last)?\s*$/.test(desc)) {
      return {
        intent: "EDIT_EXPENSE",
        targetExpenseIndex: 1,
        editExpenseNewAmount: Number(editDescAmt[2]),
      };
    }
    return {
      intent: "EDIT_EXPENSE",
      targetExpenseDescription: desc,
      editExpenseNewAmount: Number(editDescAmt[2]),
    };
  }

  return null;
}

/** “My name is Sam”, “call me Jordan”, “I’m Alex” (not I’m in/out). */
export function tryParseSelfDisplayName(message: string): ParsedIntent | null {
  const m = message.trim();
  if (!m) {
    return null;
  }

  const stripTrailingRoamie = (s: string) => s.replace(/\s+roamie\s*$/i, "").trim();

  const myName = m.match(/^(?:my name is|call me)\s+([^.!?\n]+)/i);
  if (myName?.[1]) {
    const name = stripTrailingRoamie(myName[1]).slice(0, 120);
    if (name.length >= 1) {
      return { intent: "SET_DISPLAY_NAME", manualDisplayName: name };
    }
  }

  const iam = m.match(/^I\s+am\s+(.+)$/i);
  if (iam?.[1]) {
    const rest = stripTrailingRoamie(iam[1]);
    if (/^(in|out)\b/i.test(rest)) {
      return null;
    }
    if (rest.length >= 1 && rest.length <= 120) {
      return { intent: "SET_DISPLAY_NAME", manualDisplayName: rest };
    }
  }

  const im = m.match(/^I['’]m\s+(.+)$/i);
  if (im?.[1]) {
    const rest = stripTrailingRoamie(im[1]);
    if (/^(in|out)\b/i.test(rest)) {
      return null;
    }
    if (/^not\b/i.test(rest)) {
      return null;
    }
    if (rest.length >= 1 && rest.length <= 120) {
      return { intent: "SET_DISPLAY_NAME", manualDisplayName: rest };
    }
  }

  return null;
}

/**
 * Lines like: names: +14474480657 — Alex, +17033325179 — Jordan
 * or +1 (447) 448-0657: Sam (only updates participants already on this trip).
 */
export function tryParsePhoneNameRoster(message: string): ParsedIntent | null {
  let t = message.trim().replace(/^(?:names?|roster|contacts?)\s*:\s*/i, "");
  if (!/\+/.test(t)) {
    return null;
  }

  const segments = t.includes(",") ? t.split(/\s*,\s*/) : [t];
  const pairs: Array<{ phone: string; name: string }> = [];

  for (const seg of segments) {
    const c = seg.trim();
    if (!c) {
      continue;
    }
    let match = c.match(/^(\+\d[\d\s().-]{8,22})\s*[:-–—]\s*(.+)$/);
    if (!match) {
      match = c.match(/^(\+\d[\d\s().-]{8,22})\s+(?:is|as)\s+(.+)$/i);
    }
    if (!match) {
      continue;
    }
    const rawPhone = match[1].replace(/[^\d+]/g, "");
    const phone = normalizeParticipantId(rawPhone);
    if (!phone.startsWith("+") || phone.length < 11) {
      continue;
    }
    const name = match[2]
      .trim()
      .replace(/\s+roamie\b.*$/i, "")
      .replace(/[.!?]+$/g, "")
      .trim()
      .slice(0, 120);
    if (name.length < 1) {
      continue;
    }
    pairs.push({ phone, name });
  }

  if (pairs.length === 0) {
    return null;
  }
  return { intent: "SET_CONTACT_NAMES", phoneNamePairs: pairs };
}

export function ruleBasedIntent(text: string): ParsedIntent | null {
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

  if (/^(yes|i['’]m\s+in|i\s+am\s+in|im\s+in|count\s+me\s+in)\b/i.test(message)) {
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

  if (
    /\b(?:more|other|different|another)\s+(?:hotel|stay|stays|accommodation|options?)\b/i.test(message) ||
    /\b(?:hotel|stay)\s+(?:options?|ideas?)\s+(?:please|more|again|other)\b/i.test(message) ||
    (/\b(?:want|need)\s+(?:more|different|other)\b/i.test(message) &&
      /\b(?:hotel|stay|accommodation|options?)\b/i.test(message)) ||
    (/\bnot\s+(?:my\s+)?(?:preference|preferences|style|vibe)\b/i.test(message) &&
      /\b(?:hotel|stay|these|options?)\b/i.test(message))
  ) {
    return { intent: "REQUEST_MORE_HOTELS" };
  }

  if (
    /\b(?:more|other|different|another)\s+(?:restaurant|restaurants|food|dinner|lunch|eat|eating)\b/i.test(message) ||
    (/\b(?:want|need)\s+(?:more|different|other)\b/i.test(message) &&
      /\b(?:restaurant|food|dinner|lunch|eat)\b/i.test(message))
  ) {
    return { intent: "REQUEST_MORE_RESTAURANTS" };
  }

  if (
    /\b(?:more|other|different|another)\s+(?:activit|things to do|ideas?|plans?)\b/i.test(message) ||
    (/\b(?:want|need)\s+(?:more|different|other)\b/i.test(message) && /\b(?:activit|things to do)\b/i.test(message))
  ) {
    return { intent: "REQUEST_MORE_ACTIVITIES" };
  }

  if (
    /\b(?:who'?s in|who is in|headcount|rsvp|in or out|how many\s+(?:people\s+)?(?:are\s+)?(?:in|out))\b/i.test(
      message,
    ) &&
    /\b(?:dinner|lunch|brunch|breakfast|meal|reservation)\b/i.test(message)
  ) {
    return { intent: "REQUEST_MEAL_RSVP", rsvpTopic: message.slice(0, 120) };
  }

  if (
    /\b(?:dinner|lunch|brunch|breakfast|meal)\b/i.test(message) &&
    /\b(?:who'?s in|rsvp|in or out)\b/i.test(message)
  ) {
    return { intent: "REQUEST_MEAL_RSVP", rsvpTopic: message.slice(0, 120) };
  }

  if (
    /\b(?:restaurant|restaurants|where\s+(?:to|should)\s+(?:we|i)\s+eat|places?\s+to\s+eat|food\s+options?|dinner\s+ideas?|lunch\s+ideas?)\b/i.test(
      message,
    )
  ) {
    return { intent: "REQUEST_RESTAURANTS" };
  }

  if (
    /\b(?:activit|things\s+to\s+do|what\s+should\s+we\s+do|plan\s+(?:the\s+)?day|day\s+plan|excursion)\b/i.test(
      message,
    )
  ) {
    return { intent: "REQUEST_ACTIVITIES" };
  }

  if (/settle up|who owes|split up|what do i owe|balance/i.test(message)) {
    return { intent: "REQUEST_SETTLEMENT" };
  }

  if (/\b(split|payment)\s+history\b|\bgroup\s+ledger\b/i.test(message)) {
    return { intent: "REQUEST_SPLIT_HISTORY" };
  }

  if (/\bmy\s+(splits|balance)\b|\bwhat\s+do\s+i\s+owe\b|\bhow\s+much\s+do\s+i\s+owe\b/i.test(message)) {
    return { intent: "REQUEST_MY_SPLITS" };
  }

  if (
    /\b(?:what(?:'s|s| is)?\s+the\s+weather|how(?:'s|s| is)?\s+the\s+weather|weather\s+(?:like|look|for|at|in)\b|forecast\b|will\s+it\s+rain|how\s+hot\b|pack\s+for\s+weather)\b/i.test(
      message,
    )
  ) {
    return { intent: "REQUEST_WEATHER" };
  }

  if (
    /\bhotels?\b|\bstays?\b|find\s+(?:a\s+)?(?:hotel|stay|accommodation)|book\s+(?:a\s+)?(?:hotel|stay)|where\s+should\s+(?:we|i)\s+stay/i.test(
      message,
    )
  ) {
    return { intent: "REQUEST_HOTELS" };
  }

  if (/\bitinerary\b|plan the (?:day|itinerary)|what are (?:we|i) doing/i.test(message)) {
    return { intent: "REQUEST_ITINERARY" };
  }

  if (/paid|sent it|venmoed|zelle'd|zelled/i.test(message)) {
    return { intent: "MARK_PAID" };
  }

  if (/we'?re here|trip started|start the trip|we arrived/i.test(message)) {
    return { intent: "START_TRIP" };
  }

  if (/close trip|wrap it up|done with the trip|end trip/i.test(message)) {
    return { intent: "CLOSE_TRIP" };
  }

  const finalizePoll = parseFinalizePollIntent(message);
  if (finalizePoll) {
    return finalizePoll;
  }

  const selfName = tryParseSelfDisplayName(message);
  if (selfName) {
    return selfName;
  }

  const phoneRoster = tryParsePhoneNameRoster(message);
  if (phoneRoster) {
    return phoneRoster;
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
  "REQUEST_RESTAURANTS",
  "REQUEST_MORE_RESTAURANTS",
  "REQUEST_ACTIVITIES",
  "REQUEST_MORE_ACTIVITIES",
  "REQUEST_MEAL_RSVP",
  "REQUEST_ITINERARY",
  "REQUEST_WEATHER",
  "REQUEST_SPLIT_HISTORY",
  "REQUEST_MY_SPLITS",
  "RECORD_PARTIAL_PAYMENT",
  "ADD_EXPENSE",
  "DELETE_EXPENSE",
  "EDIT_EXPENSE",
  "REQUEST_SETTLEMENT",
  "MARK_PAID",
  "START_TRIP",
  "CLOSE_TRIP",
  "ADVANCE_STAGE",
  "TAG_SUBGROUP",
  "APPEND_ITINERARY",
  "FINALIZE_POLL",
  "SET_DISPLAY_NAME",
  "SET_CONTACT_NAMES",
  "UNKNOWN",
]);

function tripPlanningExtractHasData(p: TripPlanningPatch): boolean {
  return Boolean(
    p.destination?.trim() ||
      (p.budget != null && !Number.isNaN(Number(p.budget))) ||
      p.startDate?.trim() ||
      p.endDate?.trim() ||
      p.appendItineraryNote?.trim(),
  );
}

function coerceNumber(v: unknown): number | undefined {
  if (v == null || v === "") {
    return undefined;
  }
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function normalizeParsedIntent(raw: Record<string, unknown>): ParsedIntent {
  const intentRaw = raw.intent;
  const intent =
    typeof intentRaw === "string" && ALLOWED_INTENTS.has(intentRaw)
      ? (intentRaw as ParsedIntent["intent"])
      : "UNKNOWN";

  const out: ParsedIntent = {
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
    invitees: Array.isArray(raw.invitees) ? (raw.invitees.filter((x) => typeof x === "string") as string[]) : undefined,
    rsvpTopic: typeof raw.rsvpTopic === "string" ? raw.rsvpTopic.slice(0, 200) : undefined,
    splitAmongNames: Array.isArray(raw.splitAmongNames)
      ? (raw.splitAmongNames.filter((x) => typeof x === "string") as string[]).map((s) => s.trim()).filter(Boolean)
      : undefined,
    splitBonuses: Array.isArray(raw.splitBonuses)
      ? (raw.splitBonuses
          .map((x) => {
            if (!x || typeof x !== "object" || Array.isArray(x)) {
              return null;
            }
            const o = x as Record<string, unknown>;
            const name = typeof o.name === "string" ? o.name.trim() : undefined;
            const addAmount = coerceNumber(o.addAmount);
            if (!name || addAmount == null || addAmount < 0) {
              return null;
            }
            return { name, addAmount };
          })
          .filter(Boolean) as Array<{ name: string; addAmount: number }>)
      : undefined,
    splitExplicitAmounts: Array.isArray(raw.splitExplicitAmounts)
      ? (raw.splitExplicitAmounts
          .map((x) => {
            if (!x || typeof x !== "object" || Array.isArray(x)) {
              return null;
            }
            const o = x as Record<string, unknown>;
            const name = typeof o.name === "string" ? o.name.trim() : undefined;
            const amount = coerceNumber(o.amount);
            if (!name || amount == null || amount < 0) {
              return null;
            }
            return { name, amount };
          })
          .filter(Boolean) as Array<{ name: string; amount: number }>)
      : undefined,
  };

  const fin = coerceNumber(raw.finalizeOptionIndex);
  if (fin != null && fin >= 1 && fin <= 3) {
    out.finalizeOptionIndex = fin as 1 | 2 | 3;
  }

  const tei = coerceNumber(raw.targetExpenseIndex);
  if (tei != null && tei >= 1) {
    out.targetExpenseIndex = tei;
  }
  if (typeof raw.targetExpenseDescription === "string") {
    out.targetExpenseDescription = raw.targetExpenseDescription.trim().slice(0, 120);
  }
  const ena = coerceNumber(raw.editExpenseNewAmount);
  if (ena != null && ena > 0) {
    out.editExpenseNewAmount = ena;
  }
  if (typeof raw.editExpenseNewDescription === "string") {
    out.editExpenseNewDescription = raw.editExpenseNewDescription.trim().slice(0, 200);
  }

  if (typeof raw.manualDisplayName === "string") {
    out.manualDisplayName = raw.manualDisplayName.trim().slice(0, 120);
  }
  if (Array.isArray(raw.phoneNamePairs)) {
    const pairs: Array<{ phone: string; name: string }> = [];
    for (const x of raw.phoneNamePairs) {
      if (!x || typeof x !== "object" || Array.isArray(x)) {
        continue;
      }
      const o = x as Record<string, unknown>;
      const ph =
        typeof o.phone === "string"
          ? o.phone
          : typeof o.phoneNumber === "string"
            ? o.phoneNumber
            : "";
      const nm = typeof o.name === "string" ? o.name : "";
      if (!ph.trim() || !nm.trim()) {
        continue;
      }
      pairs.push({
        phone: normalizeParticipantId(ph),
        name: nm.trim().slice(0, 120),
      });
    }
    if (pairs.length > 0) {
      out.phoneNamePairs = pairs;
    }
  }

  const tpe = raw.tripPlanningExtract;
  if (tpe && typeof tpe === "object" && !Array.isArray(tpe)) {
    const patch = tpe as TripPlanningPatch;
    if (tripPlanningExtractHasData(patch)) {
      out.tripPlanningExtract = patch;
    }
  }

  return out;
}

const INTENT_JSON_SYSTEM_PROMPT = [
  "You classify and extract structured data from short SMS-style messages for Roamie (group trip assistant).",
  "Return ONE JSON object only. Use camelCase keys exactly as specified.",
  'Required key: "intent" — one of: CREATE_GROUP_TRIP, CREATE_TRIP, CONFIRM_ATTENDANCE, DECLINE_ATTENDANCE, REQUEST_HOTELS, REQUEST_MORE_HOTELS, REQUEST_RESTAURANTS, REQUEST_MORE_RESTAURANTS, REQUEST_ACTIVITIES, REQUEST_MORE_ACTIVITIES, REQUEST_MEAL_RSVP, REQUEST_ITINERARY, REQUEST_WEATHER, REQUEST_SPLIT_HISTORY, REQUEST_MY_SPLITS, RECORD_PARTIAL_PAYMENT, ADD_EXPENSE, DELETE_EXPENSE, EDIT_EXPENSE, SET_DISPLAY_NAME, SET_CONTACT_NAMES, REQUEST_SETTLEMENT, MARK_PAID, START_TRIP, CLOSE_TRIP, ADVANCE_STAGE, TAG_SUBGROUP, APPEND_ITINERARY, FINALIZE_POLL, UNKNOWN.',
  "Include optional fields only when clearly stated:",
  "- CREATE_TRIP / CREATE_GROUP_TRIP: destination, title, budget, attendees, startDate, endDate (ISO yyyy-mm-dd). Same-month ranges like 'April 20-25' are April 20 through April 25; invitees (E.164 phones), inviteMessage.",
  "- ADD_EXPENSE: amount (number), description, subgroupLabel, splitAmongNames, splitBonuses {name, addAmount}, or splitExplicitAmounts [{name, amount}] when shares are fully listed and sum to amount — e.g. '$20 uber Sam $7 Jordan $13'.",
  "- APPEND_ITINERARY: itineraryLine.",
  "- TAG_SUBGROUP: subgroupTag.",
  "- tripPlanningExtract (optional object): use when the message adds or refines trip facts even if intent is UNKNOWN or chatty — destination, budget (number), startDate, endDate (ISO), appendItineraryNote (short, e.g. budget split). Omit tripPlanningExtract if nothing new.",
  "ADD_EXPENSE: any phrasing with a spend and amount — e.g. 'Lunch at Cheesecake $20', '$15 uber for Sam and Jordan' (splitAmongNames), 'paid 40 for gas'.",
  "DELETE_EXPENSE: user wants to remove a logged expense. Optional targetExpenseIndex (1 = most recent they can change), targetExpenseDescription (substring match on description).",
  "EDIT_EXPENSE: change an existing expense. Optional targetExpenseIndex / targetExpenseDescription; editExpenseNewAmount and/or editExpenseNewDescription for the update.",
  "SET_DISPLAY_NAME: user gives their own name for the trip (manualDisplayName). E.g. my name is Alex, call me Sam.",
  "SET_CONTACT_NAMES: map phone numbers to names for people on the trip (phoneNamePairs: [{phone E.164, name}]). Only when they are listing others’ numbers with names.",
  "REQUEST_MORE_HOTELS: user wants different/more stay options or did not like prior picks.",
  "REQUEST_RESTAURANTS / REQUEST_MORE_RESTAURANTS: food spots, where to eat, dinner/lunch ideas (not logging a dollar expense).",
  "REQUEST_ACTIVITIES / REQUEST_MORE_ACTIVITIES: things to do, day plans, excursions (poll of 3 directions).",
  "REQUEST_MEAL_RSVP: headcount for a meal or event — who's in/out. Optional rsvpTopic short phrase from the message.",
  "REQUEST_WEATHER: user asks for forecast, temperature, rain, or packing for weather for the current trip destination/dates.",
  "REQUEST_SPLIT_HISTORY: group-wide who paid, each person’s share/paid/owed, recent payment log.",
  "REQUEST_MY_SPLITS: this user’s split lines and total they still owe.",
  "RECORD_PARTIAL_PAYMENT: user records a partial payment toward their split balance — include amount (number). Phrases like paid $20 partial, $15 partial payment.",
  "FINALIZE_POLL: pick the winning option from the latest 1/2/3 poll (tallies). Optional finalizeOptionIndex 1-3 to lock a choice without using tallies.",
  "CONFIRM_ATTENDANCE / DECLINE_ATTENDANCE: yes/no, thumbs, can't make it.",
  "Use UNKNOWN only when nothing else fits; you may still fill tripPlanningExtract if they only shared dates/budget.",
  "Do not invent amounts, dates, or destinations you are not confident about.",
].join(" ");

async function parseIntentWithOpenAI(text: string): Promise<ParsedIntent> {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
      { role: "system", content: INTENT_JSON_SYSTEM_PROMPT },
      { role: "user", content: text },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
  const parsedObj = safeJsonParse<Record<string, unknown>>(stripCodeFences(raw), {});
  return normalizeParsedIntent(parsedObj);
}

/**
 * OpenAI for natural language + optional tripPlanningExtract.
 * Regex expense lines run first when they match — the model often mislabels
 * "Lunch at X $20" as chat/planning, which would skip rule fallback entirely.
 */
export async function parseIntent(text: string): Promise<ParsedIntent> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { intent: "UNKNOWN" };
  }

  const partialPayment = tryParsePartialPayment(trimmed);
  if (partialPayment) {
    return partialPayment;
  }

  const expenseMutation = parseExpenseMutationIntent(trimmed);
  if (expenseMutation) {
    return expenseMutation;
  }

  const selfDisplay = tryParseSelfDisplayName(trimmed);
  if (selfDisplay) {
    return selfDisplay;
  }

  const rosterFromText = tryParsePhoneNameRoster(trimmed);
  if (rosterFromText) {
    return rosterFromText;
  }

  const expenseLine = tryParseExpenseLine(trimmed);
  if (expenseLine) {
    try {
      const ai = await parseIntentWithOpenAI(trimmed);
      if (ai.intent === "ADD_EXPENSE" && ai.amount != null && ai.description?.trim()) {
        const mergedNames =
          ai.splitAmongNames && ai.splitAmongNames.length > 0
            ? ai.splitAmongNames
            : expenseLine.splitAmongNames;
        const mergedBonuses =
          ai.splitBonuses && ai.splitBonuses.length > 0 ? ai.splitBonuses : expenseLine.splitBonuses;
        const mergedExplicit =
          ai.splitExplicitAmounts && ai.splitExplicitAmounts.length >= 2
            ? ai.splitExplicitAmounts
            : expenseLine.splitExplicitAmounts;
        if (mergedExplicit && mergedExplicit.length >= 2) {
          return {
            ...ai,
            splitExplicitAmounts: mergedExplicit,
            splitAmongNames: undefined,
            splitBonuses: undefined,
          };
        }
        return {
          ...ai,
          ...(mergedNames?.length ? { splitAmongNames: mergedNames } : {}),
          ...(mergedBonuses?.length ? { splitBonuses: mergedBonuses } : {}),
        };
      }
      if (ai.tripPlanningExtract && tripPlanningExtractHasData(ai.tripPlanningExtract)) {
        return { ...expenseLine, tripPlanningExtract: ai.tripPlanningExtract };
      }
    } catch {
      /* use expense line below */
    }
    return expenseLine;
  }

  try {
    const ai = await parseIntentWithOpenAI(trimmed);
    if (ai.intent !== "UNKNOWN") {
      return ai;
    }
  } catch (error) {
    logger.warn("OpenAI intent parse failed; using rule fallback", { err: String(error) });
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
