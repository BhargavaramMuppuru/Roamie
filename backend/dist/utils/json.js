"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeJsonParse = safeJsonParse;
exports.stripCodeFences = stripCodeFences;
function safeJsonParse(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function stripCodeFences(value) {
    return value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}
