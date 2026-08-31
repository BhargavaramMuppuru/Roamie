import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { safeJsonParse, stripCodeFences } from "../utils/json";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

export type ReceiptGuess = {
  amount?: number;
  merchant?: string;
  lineItems?: string[];
};

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|avi)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)(\?|#|$)/i;

/**
 * Order URLs for receipt vision: likely images first, skip obvious video paths.
 * Unsigned URLs with no extension are still tried last.
 */
export function listReceiptImageCandidates(urls: string[] | undefined): string[] {
  if (!urls?.length) {
    return [];
  }
  const nonVideo = urls.filter((u) => !VIDEO_EXT.test(u));
  const withImageExt = nonVideo.filter((u) => IMAGE_EXT.test(u));
  const rest = nonVideo.filter((u) => !IMAGE_EXT.test(u));
  return [...withImageExt, ...rest];
}

function visionModel(): string {
  return env.OPENAI_VISION_MODEL ?? env.OPENAI_MODEL;
}

/**
 * Best-effort receipt understanding from an image URL (OpenAI vision).
 * Only called when RECEIPT_PARSE_ENABLED is true.
 */
export async function parseReceiptImageUrl(imageUrl: string): Promise<ReceiptGuess | null> {
  if (!env.RECEIPT_PARSE_ENABLED) {
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
          content:
            "You read trip expense receipts. Return JSON only: { \"amount\": number (total USD if visible), \"merchant\": string | null, \"lineItems\": string[] optional }. If unreadable or not a receipt, return { \"amount\": null }.",
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
    const parsed = safeJsonParse<ReceiptGuess>(stripCodeFences(raw), {});
    if (parsed.amount === undefined || parsed.amount === null || Number.isNaN(Number(parsed.amount))) {
      return null;
    }
    return {
      amount: Number(parsed.amount),
      merchant: parsed.merchant ?? undefined,
      lineItems: parsed.lineItems,
    };
  } catch (error) {
    logger.warn("Receipt parse failed", { err: String(error), imageUrl: imageUrl.slice(0, 80) });
    return null;
  }
}
