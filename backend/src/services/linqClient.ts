import axios from "axios";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import type { LinqMessageResult } from "../types/linq";

const linq = axios.create({
  baseURL: env.LINQ_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${env.LINQ_API_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

const LINQ_MAX_ATTEMPTS = 8;

/** Serialize outbound Linq calls and add a gap so we don’t burst against partner limits. */
let sendQueueTail: Promise<void> = Promise.resolve();
let lastSendFinishedAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(headers: Record<string, unknown> | undefined): number | undefined {
  if (!headers) {
    return undefined;
  }
  const raw =
    (headers as { get?: (k: string) => string | undefined }).get?.("retry-after") ??
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

function retryDelayMs(
  attempt: number,
  status: number | undefined,
  headers?: Record<string, unknown>,
): number {
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

function isRetriableLinqError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  const status = error.response?.status;
  return status === 429 || status === 503 || status === 502;
}

/**
 * Linq applies rate limits; burst replies (webhook → many API calls) trigger 429.
 * Retries with backoff tuned for 429 (seconds-scale) and honors Retry-After when present.
 */
async function requestWithRetry<T>(action: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LINQ_MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetriableLinqError(error) || attempt >= LINQ_MAX_ATTEMPTS) {
        break;
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const hdrs = axios.isAxiosError(error)
        ? (error.response?.headers as unknown as Record<string, unknown>)
        : undefined;
      const wait = retryDelayMs(attempt, status, hdrs);
      const traceId = axios.isAxiosError(error)
        ? (error.response?.data as { trace_id?: string } | undefined)?.trace_id
        : undefined;
      logger.warn(`Linq ${action} transient error, retrying`, { attempt, status, waitMs: wait, traceId });
      await delay(wait);
    }
  }
  return logLinqError(action, lastError);
}

async function enqueueOutbound<T>(fn: () => Promise<T>): Promise<T> {
  const gap = env.LINQ_MIN_MS_BETWEEN_SENDS;
  const run = async (): Promise<T> => {
    const elapsed = Date.now() - lastSendFinishedAt;
    if (elapsed < gap) {
      await delay(gap - elapsed);
    }
    try {
      return await fn();
    } finally {
      lastSendFinishedAt = Date.now();
    }
  };
  const p = sendQueueTail.then(run);
  sendQueueTail = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

function buildTextMessage(text: string) {
  return {
    parts: [
      {
        type: "text",
        value: text,
      },
    ],
  };
}

function normalizeMessageResult(raw: any): LinqMessageResult {
  return {
    chatId: raw?.chat_id ?? raw?.chat?.id ?? raw?.data?.chat_id ?? raw?.data?.chat?.id,
    messageId:
      raw?.message_id ??
      raw?.message?.id ??
      raw?.data?.message_id ??
      raw?.data?.message?.id,
    raw,
  };
}

function logLinqError(action: string, error: unknown): never {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const hint =
      status === 403
        ? "Linq returned 403 — check API token scopes and account permissions for group chat creation."
        : status === 429
          ? "Linq returned 429 after retries — rate limit; space out outbound messages or check partner quotas."
          : undefined;
    logger.error(`Linq ${action} failed`, error, {
      status,
      hint,
      traceId: (error.response?.data as { trace_id?: string } | undefined)?.trace_id,
    });
  } else {
    logger.error(`Linq ${action} failed`, error);
  }

  throw error;
}

export async function createChat(to: string[], message: string): Promise<LinqMessageResult> {
  return enqueueOutbound(() =>
    requestWithRetry("createChat", async () => {
      const response = await linq.post("/chats", {
        from: env.LINQ_FROM_PHONE,
        to,
        message: buildTextMessage(message),
      });
      return normalizeMessageResult(response.data);
    }),
  );
}

export async function sendMessage(chatId: string, text: string): Promise<LinqMessageResult> {
  return enqueueOutbound(() =>
    requestWithRetry("sendMessage", async () => {
      const response = await linq.post(`/chats/${chatId}/messages`, {
        from: env.LINQ_FROM_PHONE,
        message: buildTextMessage(text),
      });
      return normalizeMessageResult(response.data);
    }),
  );
}

/**
 * Best-effort “typing…” bubble before slow AI replies.
 * Linq returns 403 for group chats (typing not supported there yet) — ignored.
 */
export type LinqRosterRow = {
  user_id?: string;
  handle?: string;
  name?: string;
  display_name?: string;
};

function rosterString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) {
        return t;
      }
    }
  }
  return undefined;
}

/**
 * Unwraps GET /chats/{id} JSON: responses may be `{ data: { chat: { handles } } }`,
 * `{ data: { id, handles } }`, or a flat `Chat` object (`handles`, not `participants`).
 * @see https://github.com/linq-team/linq-node — `Chat.handles`
 */
export function parseChatRosterFromResponseBody(body: unknown): LinqRosterRow[] {
  const chat = unwrapChatPayload(body);
  if (!chat) {
    return [];
  }
  const raw = chat.participants ?? chat.handles;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LinqRosterRow[] = [];
  for (const item of raw) {
    const row = normalizeRosterEntry(item);
    if (row) {
      out.push(row);
    }
  }
  return out;
}

function unwrapChatPayload(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const b = body as Record<string, unknown>;
  const data = b.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.chat && typeof d.chat === "object") {
      return d.chat as Record<string, unknown>;
    }
    if (d.handles || d.participants || typeof d.id === "string") {
      return d;
    }
  }
  if (b.chat && typeof b.chat === "object") {
    return b.chat as Record<string, unknown>;
  }
  if (b.handles || b.participants || typeof b.id === "string") {
    return b;
  }
  return undefined;
}

function unwrapMessagePayload(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const b = body as Record<string, unknown>;
  const data = b.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.message && typeof d.message === "object") {
      return d.message as Record<string, unknown>;
    }
    if (d.from_handle || typeof d.id === "string") {
      return d;
    }
  }
  if (b.message && typeof b.message === "object") {
    return b.message as Record<string, unknown>;
  }
  if (b.from_handle || typeof b.id === "string") {
    return b;
  }
  return undefined;
}

/**
 * GET /messages/{id} — sometimes includes more handle metadata than webhooks (still often phone-only).
 */
export async function fetchMessageSenderDisplayName(messageId: string): Promise<string | undefined> {
  try {
    const response = await requestWithRetry("fetchMessage", async () => linq.get(`/messages/${messageId}`));
    const msg = unwrapMessagePayload(response.data);
    const fh = msg?.from_handle;
    if (!fh || typeof fh !== "object") {
      return undefined;
    }
    const o = fh as Record<string, unknown>;
    return rosterString(o.name, o.display_name, o.contact_name, o.nickname, o.label, o.full_name);
  } catch (error) {
    logger.debug("Linq fetchMessageSenderDisplayName failed", {
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    return undefined;
  }
}

function normalizeRosterEntry(raw: unknown): LinqRosterRow | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? { handle: t } : null;
  }
  if (typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const nested = o.handle;
  let flatHandle: string | undefined;
  if (typeof nested === "string") {
    flatHandle = nested.trim() || undefined;
  } else if (nested && typeof nested === "object") {
    flatHandle = rosterString((nested as { handle?: string }).handle);
  }
  const handle = rosterString(flatHandle, typeof o.phone === "string" ? o.phone : undefined);
  const userId = rosterString(o.user_id, typeof o.id === "string" ? o.id : undefined);
  const name = rosterString(o.name, o.contact_name, o.nickname);
  const display_name = rosterString(o.display_name, typeof o.displayName === "string" ? o.displayName : undefined);
  if (!handle && !userId) {
    return null;
  }
  return {
    user_id: userId,
    handle,
    name,
    display_name,
  };
}

/**
 * Best-effort chat roster (handles + display names). Used when webhooks omit `sender_handle.name`.
 * Partner API returns `handles` on the chat object (see Linq SDK `Chat`).
 */
export async function fetchChatRoster(chatId: string): Promise<LinqRosterRow[]> {
  try {
    const response = await requestWithRetry("fetchChatRoster", async () => linq.get(`/chats/${chatId}`));
    return parseChatRosterFromResponseBody(response.data);
  } catch (error) {
    logger.debug("Linq fetchChatRoster failed", {
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    return [];
  }
}

export async function startTypingIndicator(chatId: string): Promise<void> {
  try {
    await linq.post(`/chats/${chatId}/typing`, {});
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      return;
    }
    logger.debug("Linq startTyping skipped or failed", {
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
  }
}
