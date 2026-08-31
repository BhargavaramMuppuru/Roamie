"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribeVoiceAudioUrl = transcribeVoiceAudioUrl;
const axios_1 = __importDefault(require("axios"));
const openai_1 = __importDefault(require("openai"));
const uploads_1 = require("openai/uploads");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const openai = new openai_1.default({
    apiKey: env_1.env.OPENAI_API_KEY,
});
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
function filenameFromUrl(url) {
    try {
        const path = new URL(url).pathname;
        const base = path.split("/").pop();
        if (base && /\.[a-z0-9]{2,4}$/i.test(base)) {
            return base.slice(0, 64);
        }
    }
    catch {
        /* ignore */
    }
    return "audio.m4a";
}
/**
 * Transcribe a voice/audio file reachable at an HTTPS URL (e.g. Linq attachment).
 * Only runs when VOICE_PARSE_ENABLED is true.
 */
async function transcribeVoiceAudioUrl(audioUrl) {
    if (!env_1.env.VOICE_PARSE_ENABLED) {
        return null;
    }
    try {
        const res = await axios_1.default.get(audioUrl, {
            responseType: "arraybuffer",
            timeout: 120_000,
            maxContentLength: MAX_AUDIO_BYTES + 1,
            maxBodyLength: MAX_AUDIO_BYTES + 1,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        const buffer = Buffer.from(res.data);
        if (buffer.length > MAX_AUDIO_BYTES) {
            logger_1.logger.warn("Voice transcription skipped: audio too large", { bytes: buffer.length });
            return null;
        }
        const file = await (0, uploads_1.toFile)(buffer, filenameFromUrl(audioUrl));
        const tr = await openai.audio.transcriptions.create({
            file,
            model: env_1.env.OPENAI_TRANSCRIPTION_MODEL,
        });
        const text = typeof tr === "string" ? tr : tr.text;
        const trimmed = text?.trim();
        return trimmed || null;
    }
    catch (error) {
        logger_1.logger.warn("Voice transcription failed", { err: String(error) });
        return null;
    }
}
