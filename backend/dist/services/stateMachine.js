"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStateMachine = runStateMachine;
const client_1 = require("@prisma/client");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const planningHeuristics_1 = require("../utils/planningHeuristics");
const userId_1 = require("../utils/userId");
const budgetService_1 = require("./budgetService");
const hotelService_1 = require("./hotelService");
const intentService_1 = require("./intentService");
const ledgerService_1 = require("./ledgerService");
const openaiTripContent_1 = require("./openaiTripContent");
const itineraryService_1 = require("./itineraryService");
const linqClient_1 = require("./linqClient");
const receiptParseService_1 = require("./receiptParseService");
const voiceTranscriptionService_1 = require("./voiceTranscriptionService");
const reactionService_1 = require("./reactionService");
const notificationService_1 = require("./notificationService");
const settlementService_1 = require("./settlementService");
const tripService_1 = require("./tripService");
function getThreadId(event) {
    return event.thread_id ?? event.chat_id;
}
function getUserId(event) {
    const raw = event.user_id ?? event.handle ?? "unknown";
    return (0, userId_1.normalizeParticipantId)(raw);
}
/** True when the whole message is only a thumb up/down emoji (text message, not a reaction). */
function formatTripDates(start, end) {
    if (!start && !end) {
        return "TBD";
    }
    const a = start ? start.toISOString().slice(0, 10) : "?";
    const b = end ? end.toISOString().slice(0, 10) : "?";
    return `${a} → ${b}`;
}
function isStandaloneThumbEmoji(text) {
    const t = text.trim();
    return (/^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u.test(t) ||
        /^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿)$/u.test(t));
}
async function buildInboundMessageText(event) {
    const base = event.text ?? event.message?.body ?? "";
    const bits = [];
    if (base.trim()) {
        bits.push(base.trim());
    }
    let voiceTranscript;
    const voiceUrl = event.voiceUrls?.[0];
    if (voiceUrl) {
        voiceTranscript = (await (0, voiceTranscriptionService_1.transcribeVoiceAudioUrl)(voiceUrl)) ?? undefined;
    }
    if (voiceTranscript) {
        bits.push(voiceTranscript);
    }
    else if (event.hasVoiceAttachment) {
        bits.push("[voice note — send text if you need a precise split]");
    }
    if ((event.mediaUrls?.length ?? 0) > 0 && !base.trim() && !voiceTranscript) {
        bits.push("[image attached]");
    }
    return bits.join(" ").trim();
}
/** Receipt OCR can promote UNKNOWN → ADD_EXPENSE in any phase where expenses may be logged. */
const TRIP_STATES_FOR_RECEIPT_PARSE = [
    client_1.TripState.ATTENDANCE,
    client_1.TripState.PLANNING,
    client_1.TripState.ITINERARY,
    client_1.TripState.ACTIVE,
    client_1.TripState.SETTLEMENT,
];
async function mergeReceiptExpenseIntent(intent, event, trip) {
    if (!TRIP_STATES_FOR_RECEIPT_PARSE.includes(trip.currentState) || !env_1.env.RECEIPT_PARSE_ENABLED) {
        return { intent };
    }
    const candidates = (0, receiptParseService_1.listReceiptImageCandidates)(event.mediaUrls);
    if (candidates.length === 0) {
        return { intent };
    }
    for (const url of candidates) {
        const guess = await (0, receiptParseService_1.parseReceiptImageUrl)(url);
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
async function logExpenseForTrip(params) {
    const { tripId, userId, intent, receiptUrl } = params;
    if (!intent.amount || !intent.description) {
        return "";
    }
    const { usedSubgroupFallback, splitCount } = await (0, ledgerService_1.addExpense)({
        tripId,
        paidByUserId: userId,
        amount: intent.amount,
        description: intent.description,
        subgroupLabel: intent.subgroupLabel,
        receiptUrl,
    });
    let msg = `Logged ${intent.description} for $${intent.amount.toFixed(2)}`;
    if (splitCount > 0) {
        msg += ` (split ${splitCount} way${splitCount === 1 ? "" : "s"})`;
    }
    if (usedSubgroupFallback && intent.subgroupLabel) {
        msg += `. No one was tagged “${intent.subgroupLabel}” — split among all confirmed for now.`;
    }
    if (receiptUrl) {
        msg += " Receipt linked.";
    }
    return msg;
}
async function handleAttendance(tripId, userId, text, status) {
    await (0, tripService_1.upsertParticipant)({
        tripId,
        userId,
        status,
        arrivalNote: text,
    });
}
async function handleAttendanceReply(input) {
    if (input.intent.intent === "CONFIRM_ATTENDANCE") {
        await handleAttendance(input.tripId, input.userId, input.intent.arrivalNote ?? input.text, client_1.ParticipantStatus.CONFIRMED);
        await sendBestEffortReply(input.threadId, "You’re in. I’ve got your attendance down.");
        return true;
    }
    if (input.intent.intent === "DECLINE_ATTENDANCE") {
        await handleAttendance(input.tripId, input.userId, input.text, client_1.ParticipantStatus.DECLINED);
        await sendBestEffortReply(input.threadId, "Got it — I marked you as out for this trip.");
        return true;
    }
    return false;
}
async function sendBestEffortReply(chatId, text) {
    try {
        await (0, notificationService_1.sendPlainMessage)(chatId, text);
    }
    catch (error) {
        logger_1.logger.error("Outgoing Linq reply failed", error);
    }
}
async function sendBestEffortTrackedReply(input) {
    try {
        await (0, notificationService_1.sendTrackedMessage)(input);
    }
    catch (error) {
        logger_1.logger.error("Outgoing tracked Linq reply failed", error);
    }
}
function hasTripPlanningData(patch) {
    return Boolean(patch.destination?.trim() ||
        (patch.budget != null && !Number.isNaN(Number(patch.budget))) ||
        patch.startDate?.trim() ||
        patch.endDate?.trim() ||
        patch.appendItineraryNote?.trim());
}
async function applyTripPlanningPatchToDb(tripId, patch) {
    const detail = {};
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
        await (0, tripService_1.updateTripDetails)(tripId, detail);
    }
    if (patch.appendItineraryNote?.trim()) {
        await (0, tripService_1.appendItineraryNotes)(tripId, patch.appendItineraryNote.trim());
    }
}
async function captureTripPlanningDetailsFromMessage(tripId, message, trip, parsedIntent) {
    const fromAi = parsedIntent.tripPlanningExtract;
    if (fromAi && hasTripPlanningData(fromAi)) {
        await applyTripPlanningPatchToDb(tripId, fromAi);
        return;
    }
    if (!(0, planningHeuristics_1.messageLooksLikeTripPlanningDetail)(message)) {
        return;
    }
    const patch = await (0, openaiTripContent_1.extractTripPlanningPatch)({
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
async function applyTripDetailsUpdate(input) {
    await (0, tripService_1.updateTripDetails)(input.tripId, {
        title: input.intent.title,
        destination: input.intent.destination,
        budget: input.intent.budget,
        startDate: input.intent.startDate,
        endDate: input.intent.endDate,
    });
    if (input.currentState === client_1.TripState.ATTENDANCE) {
        await sendBestEffortTrackedReply({
            chatId: input.threadId,
            tripId: input.tripId,
            actionType: client_1.MessageAction.ATTENDANCE_CONFIRM,
            text: "Updated the trip details. Next up is headcount: react 👍 if you’re in or 👎 if you’re out, or just reply yes/no.",
            payload: {
                kind: "attendance_confirm",
            },
        });
        return;
    }
    await sendBestEffortReply(input.threadId, "Updated the trip details.");
}
async function sendHotelOptionsForTrip(input) {
    const hotelVote = (0, hotelService_1.renderHotelVoteMessage)({
        destination: input.destination,
        budget: input.budget,
        startDate: input.startDate,
        endDate: input.endDate,
    });
    await sendBestEffortTrackedReply({
        chatId: input.threadId,
        tripId: input.tripId,
        actionType: client_1.MessageAction.HOTEL_VOTE,
        text: hotelVote.text,
        payload: {
            kind: "hotel_vote",
            options: hotelVote.options,
            votes: {},
        },
    });
}
async function sendItineraryForTrip(input) {
    const aiText = await (0, openaiTripContent_1.generateItineraryNarrative)({
        destination: input.destination,
        startDate: input.startDate,
        endDate: input.endDate,
        budget: input.budget,
        itineraryNotes: input.itineraryNotes,
    });
    let body = aiText ??
        (0, itineraryService_1.renderStarterItinerary)({
            destination: input.destination,
            startDate: input.startDate,
            endDate: input.endDate,
            itineraryNotes: input.itineraryNotes,
        });
    if (aiText && input.itineraryNotes?.trim()) {
        body = `${body}\n\nGroup itinerary notes:\n${input.itineraryNotes.trim()}`;
    }
    await sendBestEffortReply(input.threadId, body);
}
async function moveTripToActiveWithExpense(context) {
    if (context.intent.intent !== "ADD_EXPENSE" || !context.intent.amount || !context.intent.description) {
        return false;
    }
    await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.ACTIVE);
    const line = await logExpenseForTrip({
        tripId: context.trip.id,
        userId: context.userId,
        intent: context.intent,
        receiptUrl: context.receiptUrl,
    });
    await sendBestEffortReply(context.threadId, `Trip is live now. ${line}`);
    return true;
}
async function handleAttendancePhase(context) {
    if (context.intent.intent === "REQUEST_HOTELS" || context.intent.intent === "ADVANCE_STAGE") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.PLANNING);
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
async function handlePlanningPhase(context) {
    if (context.intent.intent === "REQUEST_ITINERARY" || context.intent.intent === "ADVANCE_STAGE") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.ITINERARY);
        await sendItineraryForTrip({
            threadId: context.threadId,
            destination: context.trip.destination,
            startDate: context.trip.startDate,
            endDate: context.trip.endDate,
            itineraryNotes: context.trip.itineraryNotes,
            budget: context.trip.budget,
        });
        return true;
    }
    return moveTripToActiveWithExpense(context);
}
async function handleItineraryPhase(context) {
    if (context.intent.intent === "START_TRIP" || context.intent.intent === "ADVANCE_STAGE") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.ACTIVE);
        await sendBestEffortReply(context.threadId, "Trip is now active. Send expenses, quick updates, or ask for settle-up anytime.");
        return true;
    }
    return moveTripToActiveWithExpense(context);
}
async function handleActivePhase(context) {
    if (context.intent.intent === "REQUEST_SETTLEMENT") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.SETTLEMENT);
        await sendBestEffortReply(context.threadId, await (0, settlementService_1.renderSettlementSummary)(context.trip.id));
        return true;
    }
    if (context.intent.intent === "ADD_EXPENSE" && context.intent.amount && context.intent.description) {
        const line = await logExpenseForTrip({
            tripId: context.trip.id,
            userId: context.userId,
            intent: context.intent,
            receiptUrl: context.receiptUrl,
        });
        await sendBestEffortReply(context.threadId, line);
        const budget = await (0, budgetService_1.getBudgetStatus)(context.trip.id);
        if (budget?.shouldAlert) {
            await sendBestEffortReply(context.threadId, `Budget check: ${Math.round(budget.percentUsed)}% used so far. Roughly $${Math.max(0, Math.round(budget.perPersonPerDay))}/person/day left.`);
        }
        return true;
    }
    if (context.intent.intent === "MARK_PAID") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.SETTLEMENT);
        await sendBestEffortTrackedReply({
            chatId: context.threadId,
            tripId: context.trip.id,
            actionType: client_1.MessageAction.PAYMENT_CONFIRM,
            text: "We’re moving into settle-up mode. React 👍 on this message once you’ve paid.",
            payload: {
                kind: "payment_confirm",
            },
        });
        return true;
    }
    return false;
}
async function handleSettlementPhase(context) {
    if (context.intent.intent === "REQUEST_SETTLEMENT") {
        await sendBestEffortReply(context.threadId, await (0, settlementService_1.renderSettlementSummary)(context.trip.id));
        return true;
    }
    if (context.intent.intent === "ADD_EXPENSE" && context.intent.amount && context.intent.description) {
        const line = await logExpenseForTrip({
            tripId: context.trip.id,
            userId: context.userId,
            intent: context.intent,
            receiptUrl: context.receiptUrl,
        });
        await sendBestEffortReply(context.threadId, line);
        return true;
    }
    if (context.intent.intent === "MARK_PAID") {
        await sendBestEffortTrackedReply({
            chatId: context.threadId,
            tripId: context.trip.id,
            actionType: client_1.MessageAction.PAYMENT_CONFIRM,
            text: "Got it. React 👍 on this message once the transfer is done.",
            payload: {
                kind: "payment_confirm",
                requestedBy: context.userId,
            },
        });
        return true;
    }
    if (context.intent.intent === "ADVANCE_STAGE" || context.intent.intent === "CLOSE_TRIP") {
        await (0, tripService_1.moveTripToState)(context.trip.id, client_1.TripState.CLOSED);
        await sendBestEffortReply(context.threadId, "Trip closed. I’ll keep the ledger history here if you need it later.");
        return true;
    }
    return false;
}
async function runStateMachine(event) {
    const threadId = getThreadId(event);
    if (!threadId) {
        return;
    }
    const userId = getUserId(event);
    const compositeText = await buildInboundMessageText(event);
    let intent = await (0, intentService_1.parseIntent)(compositeText);
    let trip = await (0, tripService_1.getTripByThreadId)(threadId);
    let receiptImageUrl;
    if (trip) {
        const merged = await mergeReceiptExpenseIntent(intent, event, trip);
        intent = merged.intent;
        receiptImageUrl = merged.receiptImageUrl;
    }
    if (trip &&
        trip.currentState !== client_1.TripState.CLOSED &&
        intent.intent !== "ADD_EXPENSE" &&
        intent.intent !== "APPEND_ITINERARY" &&
        intent.intent !== "TAG_SUBGROUP" &&
        !isStandaloneThumbEmoji(compositeText) &&
        compositeText.trim().length >= 2 &&
        (0, planningHeuristics_1.messageLooksLikeTripPlanningDetail)(compositeText)) {
        await captureTripPlanningDetailsFromMessage(trip.id, compositeText, trip, intent);
        const refreshed = await (0, tripService_1.getTripByThreadId)(threadId);
        if (refreshed) {
            trip = refreshed;
        }
    }
    if (!trip) {
        if (intent.intent === "CREATE_GROUP_TRIP" && intent.invitees && intent.invitees.length > 0) {
            try {
                const chat = await (0, linqClient_1.createChat)(intent.invitees, intent.inviteMessage ?? "Are you interested in joining the trip?");
                const groupThreadId = chat.chatId;
                if (!groupThreadId) {
                    throw new Error("Linq did not return a chat id for the new group thread.");
                }
                const createdTrip = await (0, tripService_1.createTrip)({
                    threadId: groupThreadId,
                    createdBy: userId,
                });
                await (0, tripService_1.upsertParticipant)({
                    tripId: createdTrip.id,
                    userId,
                    phoneNumber: userId.startsWith("+") ? userId : undefined,
                    status: client_1.ParticipantStatus.CONFIRMED,
                    arrivalNote: "Trip creator",
                });
                for (const invitee of intent.invitees) {
                    await (0, tripService_1.upsertParticipant)({
                        tripId: createdTrip.id,
                        userId: invitee,
                        phoneNumber: invitee,
                        status: client_1.ParticipantStatus.PENDING,
                        arrivalNote: "Invited to group trip",
                    });
                }
                logger_1.logger.info("Created Roamie group trip", { groupThreadId, fromThreadId: threadId });
                return;
            }
            catch (error) {
                logger_1.logger.warn("Group trip API failed; using current thread fallback", {
                    status: error && typeof error === "object" && "isAxiosError" in error ? "linq_error" : String(error),
                });
                const fallbackTrip = await (0, tripService_1.createTrip)({
                    threadId,
                    createdBy: userId,
                });
                await (0, tripService_1.upsertParticipant)({
                    tripId: fallbackTrip.id,
                    userId,
                    phoneNumber: userId.startsWith("+") ? userId : undefined,
                    status: client_1.ParticipantStatus.CONFIRMED,
                    arrivalNote: "Trip creator",
                });
                for (const invitee of intent.invitees) {
                    await (0, tripService_1.upsertParticipant)({
                        tripId: fallbackTrip.id,
                        userId: invitee,
                        phoneNumber: invitee,
                        status: client_1.ParticipantStatus.PENDING,
                        arrivalNote: "Invite pending manual group thread",
                    });
                }
                await sendBestEffortReply(threadId, "I couldn’t open the shared group thread automatically, so I started the trip here and saved the invitees. If you create the group manually in Linq, we can keep going there.");
                return;
            }
        }
        if (intent.intent !== "CREATE_TRIP") {
            const text = intent.intent === "UNKNOWN"
                ? await (0, openaiTripContent_1.generateContextualReply)({
                    userMessage: compositeText,
                    hasTrip: false,
                })
                : "Start with the trip details, like: Miami trip May 15 to May 18, 6 people, $1200 budget.";
            await sendBestEffortReply(threadId, text);
            return;
        }
        const createdTrip = await (0, tripService_1.createTrip)({
            threadId,
            title: intent.title,
            destination: intent.destination,
            budget: intent.budget,
            startDate: intent.startDate,
            endDate: intent.endDate,
            createdBy: userId,
        });
        await (0, tripService_1.upsertParticipant)({
            tripId: createdTrip.id,
            userId,
            status: client_1.ParticipantStatus.CONFIRMED,
            arrivalNote: "Trip creator",
        });
        await sendBestEffortTrackedReply({
            chatId: threadId,
            tripId: createdTrip.id,
            actionType: client_1.MessageAction.ATTENDANCE_CONFIRM,
            text: "Trip’s open. First step is headcount: react 👍 if you’re in or 👎 if you’re out, or just reply yes/no.",
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
    if (trip.currentState !== client_1.TripState.CLOSED &&
        (intent.intent === "CONFIRM_ATTENDANCE" || intent.intent === "DECLINE_ATTENDANCE") &&
        isStandaloneThumbEmoji(compositeText)) {
        const handledHotelVote = await (0, reactionService_1.recordHotelVoteByText)({
            tripId: trip.id,
            threadId,
            userId,
            positive: intent.intent === "CONFIRM_ATTENDANCE",
        });
        if (handledHotelVote) {
            return;
        }
    }
    if (trip.currentState === client_1.TripState.ATTENDANCE &&
        (intent.intent === "CONFIRM_ATTENDANCE" || intent.intent === "DECLINE_ATTENDANCE")) {
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
    if (trip.currentState !== client_1.TripState.CLOSED && intent.intent === "REQUEST_HOTELS") {
        if (trip.currentState === client_1.TripState.ATTENDANCE) {
            await (0, tripService_1.moveTripToState)(trip.id, client_1.TripState.PLANNING);
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
    if (trip.currentState !== client_1.TripState.CLOSED && intent.intent === "REQUEST_MORE_HOTELS") {
        if (trip.currentState === client_1.TripState.ATTENDANCE) {
            await (0, tripService_1.moveTripToState)(trip.id, client_1.TripState.PLANNING);
        }
        const alt = await (0, openaiTripContent_1.generateHotelAlternativesFromAi)({
            destination: trip.destination,
            budget: trip.budget,
            startDate: trip.startDate,
            endDate: trip.endDate,
            userMessage: compositeText,
        });
        if (alt) {
            await sendBestEffortTrackedReply({
                chatId: threadId,
                tripId: trip.id,
                actionType: client_1.MessageAction.HOTEL_VOTE,
                text: alt.text,
                payload: {
                    kind: "hotel_vote",
                    options: alt.options,
                    votes: {},
                },
            });
        }
        else {
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
    if (trip.currentState !== client_1.TripState.CLOSED && intent.intent === "REQUEST_ITINERARY") {
        if (trip.currentState === client_1.TripState.ATTENDANCE || trip.currentState === client_1.TripState.PLANNING) {
            await (0, tripService_1.moveTripToState)(trip.id, client_1.TripState.ITINERARY);
        }
        await sendItineraryForTrip({
            threadId,
            destination: trip.destination,
            startDate: trip.startDate,
            endDate: trip.endDate,
            itineraryNotes: trip.itineraryNotes,
            budget: trip.budget,
        });
        return;
    }
    if (trip.currentState === client_1.TripState.CLOSED && (intent.intent === "TAG_SUBGROUP" || intent.intent === "APPEND_ITINERARY")) {
        await sendBestEffortReply(threadId, "This trip is closed.");
        return;
    }
    if (intent.intent === "TAG_SUBGROUP" && intent.subgroupTag) {
        const self = trip.participants.find((p) => p.userId === userId);
        await (0, tripService_1.upsertParticipant)({
            tripId: trip.id,
            userId,
            status: self?.status ?? client_1.ParticipantStatus.CONFIRMED,
            subgroupTag: intent.subgroupTag,
            arrivalNote: self?.arrivalNote ?? `Subgroup: ${intent.subgroupTag}`,
        });
        await sendBestEffortReply(threadId, `Tagged you for splits as “${intent.subgroupTag}”.`);
        return;
    }
    if (intent.intent === "APPEND_ITINERARY" && intent.itineraryLine) {
        if (trip.currentState === client_1.TripState.INIT || trip.currentState === client_1.TripState.ATTENDANCE) {
            await sendBestEffortReply(threadId, "Confirm the trip and move past attendance first, then we can build itinerary notes.");
            return;
        }
        await (0, tripService_1.appendItineraryNotes)(trip.id, intent.itineraryLine);
        await sendBestEffortReply(threadId, "Added that to the shared itinerary notes.");
        return;
    }
    const tripContext = {
        trip,
        threadId,
        userId,
        intent,
        receiptUrl: receiptImageUrl ?? event.mediaUrls?.[0],
    };
    switch (trip.currentState) {
        case client_1.TripState.ATTENDANCE:
            if (await handleAttendancePhase(tripContext))
                return;
            break;
        case client_1.TripState.PLANNING:
            if (await handlePlanningPhase(tripContext))
                return;
            break;
        case client_1.TripState.ITINERARY:
            if (await handleItineraryPhase(tripContext))
                return;
            break;
        case client_1.TripState.ACTIVE:
            if (await handleActivePhase(tripContext))
                return;
            break;
        case client_1.TripState.SETTLEMENT:
            if (await handleSettlementPhase(tripContext))
                return;
            break;
        case client_1.TripState.CLOSED:
            await sendBestEffortReply(threadId, "This trip is already closed. Start a fresh thread whenever you want to open a new one.");
            return;
        case client_1.TripState.INIT:
        default:
            break;
    }
    await sendBestEffortReply(threadId, await (0, openaiTripContent_1.generateContextualReply)({
        userMessage: compositeText,
        hasTrip: true,
        tripState: trip.currentState,
        destination: trip.destination,
        budget: trip.budget,
        datesLabel: formatTripDates(trip.startDate, trip.endDate),
        itineraryNotesPreview: trip.itineraryNotes,
        hasItineraryNotes: Boolean(trip.itineraryNotes?.trim()),
    }));
}
