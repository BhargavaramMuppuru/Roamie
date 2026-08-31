"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeParticipantId = normalizeParticipantId;
/**
 * Normalize Linq handles / phone numbers so the same person maps to one id when possible.
 */
function normalizeParticipantId(raw) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "unknown") {
        return "unknown";
    }
    const digits = trimmed.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) {
        return digits;
    }
    if (digits.length === 10) {
        return `+1${digits}`;
    }
    if (digits.length >= 11) {
        return `+${digits.replace(/^\+/, "")}`;
    }
    return trimmed;
}
