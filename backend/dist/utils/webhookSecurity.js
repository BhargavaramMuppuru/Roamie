"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWebhookSignature = verifyWebhookSignature;
const crypto_1 = __importDefault(require("crypto"));
function verifyWebhookSignature(input) {
    if (!input.secret) {
        return true;
    }
    if (!input.rawBody || !input.signature || !input.timestamp) {
        return false;
    }
    const signedPayload = `${input.timestamp}.${input.rawBody}`;
    const digest = crypto_1.default.createHmac("sha256", input.secret).update(signedPayload).digest("hex");
    try {
        const cleanedSignature = input.signature.replace(/^v1,?=/, "").replace(/^sha256=/, "");
        return crypto_1.default.timingSafeEqual(Buffer.from(digest), Buffer.from(cleanedSignature));
    }
    catch {
        return false;
    }
}
