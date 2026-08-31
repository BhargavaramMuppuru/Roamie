import axios from "axios";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { env } from "../config/env";
import { logger } from "../utils/logger";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").pop();
    if (base && /\.[a-z0-9]{2,4}$/i.test(base)) {
      return base.slice(0, 64);
    }
  } catch {
    /* ignore */
  }
  return "audio.m4a";
}

/**
 * Transcribe a voice/audio file reachable at an HTTPS URL (e.g. Linq attachment).
 * Only runs when VOICE_PARSE_ENABLED is true.
 */
export async function transcribeVoiceAudioUrl(audioUrl: string): Promise<string | null> {
  if (!env.VOICE_PARSE_ENABLED) {
    return null;
  }

  try {
    const res = await axios.get<ArrayBuffer>(audioUrl, {
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: MAX_AUDIO_BYTES + 1,
      maxBodyLength: MAX_AUDIO_BYTES + 1,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const buffer = Buffer.from(res.data);
    if (buffer.length > MAX_AUDIO_BYTES) {
      logger.warn("Voice transcription skipped: audio too large", { bytes: buffer.length });
      return null;
    }

    const file = await toFile(buffer, filenameFromUrl(audioUrl));
    const tr = await openai.audio.transcriptions.create({
      file,
      model: env.OPENAI_TRANSCRIPTION_MODEL,
    });

    const text = typeof tr === "string" ? tr : tr.text;
    const trimmed = text?.trim();
    return trimmed || null;
  } catch (error) {
    logger.warn("Voice transcription failed", { err: String(error) });
    return null;
  }
}
