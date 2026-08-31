"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTripByThreadId = getTripByThreadId;
exports.createTrip = createTrip;
exports.updateTripDetails = updateTripDetails;
exports.upsertParticipant = upsertParticipant;
exports.appendItineraryNotes = appendItineraryNotes;
exports.moveTripToState = moveTripToState;
const client_1 = require("@prisma/client");
const client_2 = require("../db/client");
async function getTripByThreadId(threadId) {
    return client_2.db.trip.findUnique({
        where: { threadId },
        include: {
            participants: true,
            expenses: true,
        },
    });
}
async function createTrip(input) {
    return client_2.db.trip.create({
        data: {
            threadId: input.threadId,
            title: input.title,
            destination: input.destination,
            budget: input.budget,
            startDate: input.startDate ? new Date(input.startDate) : undefined,
            endDate: input.endDate ? new Date(input.endDate) : undefined,
            createdBy: input.createdBy,
            currentState: client_1.TripState.ATTENDANCE,
        },
    });
}
async function updateTripDetails(tripId, input) {
    return client_2.db.trip.update({
        where: { id: tripId },
        data: {
            title: input.title ?? undefined,
            destination: input.destination ?? undefined,
            budget: input.budget ?? undefined,
            startDate: input.startDate ? new Date(input.startDate) : undefined,
            endDate: input.endDate ? new Date(input.endDate) : undefined,
        },
    });
}
async function upsertParticipant(input) {
    return client_2.db.participant.upsert({
        where: {
            tripId_userId: {
                tripId: input.tripId,
                userId: input.userId,
            },
        },
        update: {
            name: input.name,
            phoneNumber: input.phoneNumber,
            subgroupTag: input.subgroupTag === undefined ? undefined : input.subgroupTag,
            arrivalNote: input.arrivalNote,
            status: input.status,
        },
        create: {
            tripId: input.tripId,
            userId: input.userId,
            name: input.name,
            phoneNumber: input.phoneNumber,
            subgroupTag: input.subgroupTag ?? undefined,
            arrivalNote: input.arrivalNote,
            status: input.status,
        },
    });
}
async function appendItineraryNotes(tripId, line) {
    const trip = await client_2.db.trip.findUnique({ where: { id: tripId } });
    const prev = trip?.itineraryNotes ?? "";
    const bullet = line.trim();
    const next = prev ? `${prev}\n• ${bullet}` : `• ${bullet}`;
    return client_2.db.trip.update({
        where: { id: tripId },
        data: { itineraryNotes: next },
    });
}
async function moveTripToState(tripId, state) {
    return client_2.db.trip.update({
        where: { id: tripId },
        data: { currentState: state },
    });
}
