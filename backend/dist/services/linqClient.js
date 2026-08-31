"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChat = createChat;
exports.sendMessage = sendMessage;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const linq = axios_1.default.create({
    baseURL: env_1.env.LINQ_API_BASE_URL,
    headers: {
        Authorization: `Bearer ${env_1.env.LINQ_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    },
});
const LINQ_MAX_ATTEMPTS = 8;
/** Serialize outbound Linq calls and add a gap so we don’t burst against partner limits. */
let sendQueueTail = Promise.resolve();
let lastSendFinishedAt = 0;
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getRetryAfterMs(headers) {
    if (!headers) {
        return undefined;
    }
    const raw = headers.get?.("retry-after") ??
        headers["retry-after"] ??
        headers["Retry-After"];
    if (typeof raw === "string" || typeof raw === "number") {
        const sec = Number(raw);
        if (!Number.isNaN(sec) && sec >= 0) {
            return Math.min(120_000, Math.max(500, sec * 1000));
        }
    }
    return undefined;
}
function retryDelayMs(attempt, status, headers) {
    const fromHeader = getRetryAfterMs(headers);
    if (fromHeader != null) {
        return fromHeader;
    }
    // 429: window is often per-minute — wait seconds-scale, not hundreds of ms
    if (status === 429) {
        return Math.min(90_000, Math.max(2_500, 2_500 * 2 ** (attempt - 1)));
    }
    const exp = 600 * 2 ** (attempt - 1);
    return Math.min(45_000, exp);
}
function isRetriableLinqError(error) {
    if (!axios_1.default.isAxiosError(error)) {
        return false;
    }
    const status = error.response?.status;
    return status === 429 || status === 503 || status === 502;
}
/**
 * Linq applies rate limits; burst replies (webhook → many API calls) trigger 429.
 * Retries with backoff tuned for 429 (seconds-scale) and honors Retry-After when present.
 */
async function requestWithRetry(action, run) {
    let lastError;
    for (let attempt = 1; attempt <= LINQ_MAX_ATTEMPTS; attempt++) {
        try {
            return await run();
        }
        catch (error) {
            lastError = error;
            if (!isRetriableLinqError(error) || attempt >= LINQ_MAX_ATTEMPTS) {
                break;
            }
            const status = axios_1.default.isAxiosError(error) ? error.response?.status : undefined;
            const hdrs = axios_1.default.isAxiosError(error)
                ? error.response?.headers
                : undefined;
            const wait = retryDelayMs(attempt, status, hdrs);
            const traceId = axios_1.default.isAxiosError(error)
                ? error.response?.data?.trace_id
                : undefined;
            logger_1.logger.warn(`Linq ${action} transient error, retrying`, { attempt, status, waitMs: wait, traceId });
            await delay(wait);
        }
    }
    return logLinqError(action, lastError);
}
async function enqueueOutbound(fn) {
    const gap = env_1.env.LINQ_MIN_MS_BETWEEN_SENDS;
    const run = async () => {
        const elapsed = Date.now() - lastSendFinishedAt;
        if (elapsed < gap) {
            await delay(gap - elapsed);
        }
        try {
            return await fn();
        }
        finally {
            lastSendFinishedAt = Date.now();
        }
    };
    const p = sendQueueTail.then(run);
    sendQueueTail = p.then(() => undefined, () => undefined);
    return p;
}
function buildTextMessage(text) {
    return {
        parts: [
            {
                type: "text",
                value: text,
            },
        ],
    };
}
function normalizeMessageResult(raw) {
    return {
        chatId: raw?.chat_id ?? raw?.chat?.id ?? raw?.data?.chat_id ?? raw?.data?.chat?.id,
        messageId: raw?.message_id ??
            raw?.message?.id ??
            raw?.data?.message_id ??
            raw?.data?.message?.id,
        raw,
    };
}
function logLinqError(action, error) {
    if (axios_1.default.isAxiosError(error)) {
        const status = error.response?.status;
        const hint = status === 403
            ? "Linq returned 403 — check API token scopes and account permissions for group chat creation."
            : status === 429
                ? "Linq returned 429 after retries — rate limit; space out outbound messages or check partner quotas."
                : undefined;
        logger_1.logger.error(`Linq ${action} failed`, error, {
            status,
            hint,
            traceId: error.response?.data?.trace_id,
        });
    }
    else {
        logger_1.logger.error(`Linq ${action} failed`, error);
    }
    throw error;
}
async function createChat(to, message) {
    return enqueueOutbound(() => requestWithRetry("createChat", async () => {
        const response = await linq.post("/chats", {
            from: env_1.env.LINQ_FROM_PHONE,
            to,
            message: buildTextMessage(message),
        });
        return normalizeMessageResult(response.data);
    }));
}
async function sendMessage(chatId, text) {
    return enqueueOutbound(() => requestWithRetry("sendMessage", async () => {
        const response = await linq.post(`/chats/${chatId}/messages`, {
            from: env_1.env.LINQ_FROM_PHONE,
            message: buildTextMessage(text),
        });
        return normalizeMessageResult(response.data);
    }));
}
