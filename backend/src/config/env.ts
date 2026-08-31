import { z } from "zod";

const logLevelSchema = z.enum(["error", "warn", "info", "debug"]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  LINQ_API_TOKEN: z.string().min(1),
  LINQ_API_BASE_URL: z.string().url(),
  LINQ_FROM_PHONE: z.string().min(1),
  LINQ_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  /** When true, trust X-Forwarded-* (behind reverse proxy). */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === "1" || v === "true")),
  /** Max webhook requests per IP per minute (Linq typically uses few egress IPs). */
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().min(10).max(10_000).default(300),
  /**
   * Production default info; development default debug.
   * Raw webhook JSON is only logged at debug.
   */
  LOG_LEVEL: logLevelSchema.optional(),
  /** Bearer token for GET /admin/* debug JSON. If unset, admin routes return 404. */
  ADMIN_DEBUG_TOKEN: z.string().min(8).optional(),
  /** Optional: parse receipt images with OpenAI vision when users attach images in expense flows. */
  RECEIPT_PARSE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  /** Optional: transcribe voice/audio message URLs (OpenAI) before intent parsing. */
  VOICE_PARSE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  /** Model for receipt image understanding (vision). Defaults to OPENAI_MODEL. */
  OPENAI_VISION_MODEL: z.string().min(1).optional(),
  /** Model for voice transcription (Whisper-class). */
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("whisper-1"),
  /**
   * Minimum spacing between Linq outbound API sends (createChat / sendMessage).
   * Bursts of messages hit partner rate limits (429); serializing + gap reduces that.
   */
  LINQ_MIN_MS_BETWEEN_SENDS: z.coerce.number().min(0).max(60_000).default(550),
  /** Alert when trip spend reaches this % of total budget (cron + threshold notifications). */
  BUDGET_WARNING_PERCENT: z.coerce.number().min(1).max(100).default(80),
});

const parsed = envSchema.parse(process.env);

const defaultLogLevel = parsed.NODE_ENV === "production" ? "info" : "debug";

export const env = {
  ...parsed,
  LOG_LEVEL: parsed.LOG_LEVEL ?? defaultLogLevel,
};
