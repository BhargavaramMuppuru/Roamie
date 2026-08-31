"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageLooksLikeTripPlanningDetail = messageLooksLikeTripPlanningDetail;
/**
 * Cheap pre-filter so we only run OpenAI trip-detail extraction when the text might
 * contain dates, money, or planning prefs — skips "thanks", "Find hotels", thumbs, etc.
 */
function messageLooksLikeTripPlanningDetail(text) {
    const t = text.trim();
    if (t.length < 2) {
        return false;
    }
    const lower = t.toLowerCase();
    // Short acknowledgements / reactions (no second OpenAI extract call)
    if (t.length <= 64 &&
        /^(thanks|thank you|thx|ty|ok+|k\.?|cool|great|nice|yep|yeah|yup|nope|nah|got it|gotcha|sounds good|sounds great|perfect|perfecto|awesome|love it|same|same here|👍|👎|❤️|🙏)/i.test(t)) {
        return false;
    }
    // Currency or explicit money
    if (/\$|€|£|\b(usd|eur)\b/i.test(t)) {
        return true;
    }
    // "600 for food", "1000 extra for hotels"
    if (/\b\d{2,6}\s+(for|on|toward|towards|extra|about|around|up to)\b/i.test(t)) {
        return true;
    }
    // Standalone large numbers that often mean dollars in chat
    if (/\b\d{3,5}\b/.test(t) && /\b(budget|spend|hotel|hotels|stay|stays|night|nights|food|activities)\b/i.test(t)) {
        return true;
    }
    if (/\b(budget|nightly|per night|check[- ]?in|checkout|weekend|week of)\b/i.test(lower)) {
        return true;
    }
    if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(lower)) {
        return true;
    }
    if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b\.?/i.test(lower)) {
        return true;
    }
    if (/\b20\d{2}\b/.test(t)) {
        return true;
    }
    // 20-23 April, 5/15-5/18, 04/20-04/23
    if (/\b\d{1,2}\s*[-–/]\s*\d{1,2}\b/.test(t)) {
        return true;
    }
    if (/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t)) {
        return true;
    }
    if (/\b(neighborhood|mid[- ]?range|luxury|boutique|hostel|airbnb)\b/i.test(lower)) {
        return true;
    }
    if (/\b(prefer|preference|preferences|rather than|instead of|explore more|not my)\b/i.test(lower)) {
        return true;
    }
    return false;
}
