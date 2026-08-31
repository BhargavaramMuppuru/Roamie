import type { LinqMessagePart, LinqWebhookEvent } from "../types/linq";
import { normalizeParticipantId } from "./userId";

function firstNonEmpty(...vals: (string | undefined | null)[]): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) {
      return t;
    }
  }
  return undefined;
}

function handlesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return normalizeParticipantId(a) === normalizeParticipantId(b);
}

/** Linq may send extra JSON on handles beyond the published TypeScript types. */
function pickHandleDisplayName(handle: unknown): string | undefined {
  if (!handle || typeof handle !== "object") {
    return undefined;
  }
  const o = handle as Record<string, unknown>;
  return firstNonEmpty(
    o.name as string | undefined,
    o.display_name as string | undefined,
    o.contact_name as string | undefined,
    o.nickname as string | undefined,
    o.label as string | undefined,
    o.full_name as string | undefined,
  );
}

function nameFromChatRoster(senderKey: string | undefined, chat: LinqWebhookEvent["chat"]): string | undefined {
  if (!senderKey || !chat) {
    return undefined;
  }
  const rows = [...(chat.participants ?? []), ...(chat.handles ?? [])];
  for (const row of rows) {
    const r = row as { user_id?: string; handle?: string };
    const pid = r.user_id ?? r.handle;
    if (!pid || !handlesMatch(pid, senderKey)) {
      continue;
    }
    const n = firstNonEmpty(
      (row as { name?: string }).name,
      (row as { display_name?: string }).display_name,
      (row as { contact_name?: string }).contact_name,
      (row as { nickname?: string }).nickname,
    );
    if (n) {
      return n;
    }
  }
  return undefined;
}

/**
 * Reads iMessage / contact display names from Linq Partner webhooks (v3 commonly sends
 * `data.sender_handle.name` and/or `data.chat.participants[].name`). See Linq API docs:
 * https://apidocs.linqapp.com/
 */
export function extractSenderDisplayName(event: LinqWebhookEvent): string | undefined {
  const data = event.data;
  const message = event.message ?? data?.message;
  const chat = event.chat ?? data?.chat;

  const fromHandle =
    message?.from_handle?.handle ??
    chat?.message?.from_handle?.handle ??
    data?.sender_handle?.handle ??
    (data?.sender as { handle?: string } | undefined)?.handle;

  const senderKey = firstNonEmpty(event.user_id, event.handle, fromHandle, data?.from);

  const reactionFh = data?.from_handle;

  const direct = firstNonEmpty(
    pickHandleDisplayName(data?.sender_handle),
    pickHandleDisplayName(reactionFh),
    pickHandleDisplayName(message?.from_handle),
    pickHandleDisplayName(chat?.message?.from_handle),
    pickHandleDisplayName(data?.message?.from_handle),
    (data?.sender as { name?: string; display_name?: string } | undefined)?.name,
    (data?.sender as { name?: string; display_name?: string } | undefined)?.display_name,
  );
  if (direct) {
    return direct;
  }

  const fromRoster = nameFromChatRoster(senderKey, chat);
  if (fromRoster) {
    return fromRoster;
  }

  return undefined;
}

function extractText(parts?: LinqMessagePart[]): string | undefined {
  return parts?.filter((part) => part.type === "text").map((part) => part.value ?? "").join("").trim() || undefined;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isImageMime(m?: string): boolean {
  if (!m) {
    return false;
  }
  return /^image\//i.test(m.trim());
}

function collectMediaUrls(parts?: LinqMessagePart[]): string[] {
  if (!parts?.length) {
    return [];
  }
  const urls: string[] = [];
  for (const part of parts) {
    const t = (part.type ?? "").toLowerCase();
    const u = part.url ?? part.value;
    if (!u || !isHttpUrl(u)) {
      continue;
    }
    // Linq v3 often uses type "media" for photos (mime_type image/jpeg, url on part)
    if (
      t === "image" ||
      t === "video" ||
      t === "attachment" ||
      t === "media" ||
      (t === "file" && isImageMime(part.mime_type))
    ) {
      urls.push(u);
    }
  }
  return urls;
}

function collectVoiceUrls(parts?: LinqMessagePart[]): string[] {
  if (!parts?.length) {
    return [];
  }
  const urls: string[] = [];
  for (const part of parts) {
    const t = (part.type ?? "").toLowerCase();
    const isVoice =
      t === "audio" ||
      t === "voice" ||
      t === "ptt" ||
      t.includes("voice") ||
      /^audio\//i.test(part.mime_type ?? "");
    if (!isVoice) {
      continue;
    }
    const u = part.url ?? part.value;
    if (u && isHttpUrl(u)) {
      urls.push(u);
    }
  }
  return urls;
}

function hasVoiceInParts(parts?: LinqMessagePart[]): boolean {
  if (!parts?.length) {
    return false;
  }
  return parts.some((p) => {
    const t = (p.type ?? "").toLowerCase();
    return (
      t === "audio" ||
      t === "voice" ||
      t === "ptt" ||
      t.includes("voice") ||
      /^audio\//i.test(p.mime_type ?? "")
    );
  });
}

function normalizeReactionType(value?: string): string | undefined {
  switch (value) {
    case "like":
      return "👍";
    case "dislike":
      return "👎";
    case "love":
      return "❤️";
    case "emphasize":
      return "❗";
    case "question":
      return "❓";
    default:
      return value;
  }
}

export function normalizeLinqEvent(event: LinqWebhookEvent): LinqWebhookEvent {
  const eventType = event.type ?? event.event_type;
  const chat = event.chat ?? event.data?.chat;
  const message = event.message ?? event.data?.message ?? chat?.message;
  const dataParts = event.data?.parts;
  const dataSenderHandle = event.data?.sender_handle?.handle;
  const dataSenderIsMe = event.data?.sender_handle?.is_me;
  const dataMessageId = event.data?.id;
  const messageBody = (message as { body?: string } | undefined)?.body;
  const fromHandle = message?.from_handle?.handle ?? chat?.message?.from_handle?.handle ?? dataSenderHandle;
  const isFromMe = Boolean(message?.from_handle?.is_me ?? chat?.message?.from_handle?.is_me ?? dataSenderIsMe);
  const normalizedText =
    event.text ??
    messageBody ??
    extractText(message?.parts ?? event.data?.message?.parts ?? dataParts) ??
    extractText(chat?.message?.parts);

  const normalizedReaction =
    event.reaction ??
    event.data?.reaction?.emoji ??
    normalizeReactionType(event.data?.reaction_type) ??
    message?.parts?.flatMap((part) => part.reactions ?? []).find(Boolean)?.emoji;

  const partSources = [message?.parts, event.data?.message?.parts, dataParts, chat?.message?.parts].filter(Boolean) as LinqMessagePart[][];
  const mediaFromParts = partSources.flatMap((p) => collectMediaUrls(p));
  const voiceFromParts = partSources.flatMap((p) => collectVoiceUrls(p));
  const attachmentUrls = [event.attachment, ...(event.attachments ?? [])]
    .filter((a): a is NonNullable<typeof event.attachment> => Boolean(a?.url))
    .map((a) => a.url as string)
    .filter(isHttpUrl);
  const mediaUrls = Array.from(new Set([...mediaFromParts, ...attachmentUrls]));
  const voiceUrls = Array.from(new Set(voiceFromParts));

  const hasVoiceAttachment =
    voiceUrls.length > 0 ||
    hasVoiceInParts(message?.parts) ||
    hasVoiceInParts(event.data?.message?.parts) ||
    hasVoiceInParts(dataParts) ||
    hasVoiceInParts(chat?.message?.parts);

  const userIdResolved = event.user_id ?? event.handle ?? fromHandle ?? event.data?.from;
  const sender_display_name = extractSenderDisplayName({
    ...event,
    chat,
    message,
    user_id: userIdResolved,
    handle: event.handle ?? fromHandle,
  });

  return {
    ...event,
    type: eventType,
    isFromMe,
    chat_id: event.chat_id ?? event.thread_id ?? event.data?.chat_id ?? chat?.id,
    thread_id: event.thread_id ?? event.chat_id ?? event.data?.chat_id ?? chat?.id,
    user_id: userIdResolved,
    handle: event.handle ?? fromHandle,
    text: normalizedText,
    message_id: event.message_id ?? message?.id ?? chat?.message?.id ?? dataMessageId ?? event.data?.message_id,
    reaction: normalizedReaction,
    chat,
    message,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    voiceUrls: voiceUrls.length > 0 ? voiceUrls : undefined,
    hasVoiceAttachment: hasVoiceAttachment || undefined,
    sender_display_name: sender_display_name ?? undefined,
  };
}
