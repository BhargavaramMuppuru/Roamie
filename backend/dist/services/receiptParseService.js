"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listReceiptImageCandidates = listReceiptImageCandidates;
exports.parseReceiptImageUrl = parseReceiptImageUrl;
const openai_1 = __importDefault(require("openai"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const json_1 = require("../utils/json");
const openai = new openai_1.default({
    apiKey: env_1.env.OPENAI_API_KEY,
});
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|avi)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)(\?|#|$)/i;
/**
 * Order URLs for receipt vision: likely images first, skip obvious video paths.
 * Unsigned URLs with no extension are still tried last.
 */
function listReceiptImageCandidates(urls) {
    if (!urls?.length) {
        return [];
    }
    const nonVideo = urls.filter((u) => !VIDEO_EXT.test(u));
    const withImageExt = nonVideo.filter((u) => IMAGE_EXT.test(u));
    const rest = nonVideo.filter((u) => !IMAGE_EXT.test(u));
    return [...withImageExt, ...rest];
}
function visionModel() {
    return env_1.env.OPENAI_VISION_MODEL ?? env_1.env.OPENAI_MODEL;
}
/**
 * Best-effort receipt understanding from an image URL (OpenAI vision).
 * Only called when RECEIPT_PARSE_ENABLED is true.
 */
async function parseReceiptImageUrl(imageUrl) {
    if (!env_1.env.RECEIPT_PARSE_ENABLED) {
        return null;
    }
    try {
        const response = await openai.chat.completions.create({
            model: visionModel(),
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "You read trip expense receipts. Return JSON only: { \"amount\": number (total USD if visible), \"merchant\": string | null, \"lineItems\": string[] optional }. If unreadable or not a receipt, return { \"amount\": null }.",
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Extract the total amount and merchant from this receipt image.",
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl, detail: "auto" },
                        },
                    ],
                },
            ],
        });
        const raw = response.choices[0]?.message?.content ?? "{}";
        const parsed = (0, json_1.safeJsonParse)((0, json_1.stripCodeFences)(raw), {});
        if (parsed.amount === undefined || parsed.amount === null || Number.isNaN(Number(parsed.amount))) {
            return null;
        }
        return {
            amount: Number(parsed.amount),
            merchant: parsed.merchant ?? undefined,
            lineItems: parsed.lineItems,
        };
    }
    catch (error) {
        logger_1.logger.warn("Receipt parse failed", { err: String(error), imageUrl: imageUrl.slice(0, 80) });
        return null;
    }
}
