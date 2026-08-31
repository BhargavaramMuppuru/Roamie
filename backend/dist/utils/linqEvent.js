"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLinqEvent = normalizeLinqEvent;
function extractText(parts) {
    return parts?.filter((part) => part.type === "text").map((part) => part.value ?? "").join("").trim() || undefined;
}
function isHttpUrl(s) {
    return /^https?:\/\//i.test(s);
}
function isImageMime(m) {
    if (!m) {
        return false;
    }
    return /^image\//i.test(m.trim());
}
function collectMediaUrls(parts) {
    if (!parts?.length) {
        return [];
    }
    const urls = [];
    for (const part of parts) {
        const t = (part.type ?? "").toLowerCase();
        const u = part.url ?? part.value;
        if (!u || !isHttpUrl(u)) {
            continue;
        }
        // Linq v3 often uses type "media" for photos (mime_type image/jpeg, url on part)
        if (t === "image" ||
            t === "video" ||
            t === "attachment" ||
            t === "media" ||
            (t === "file" && isImageMime(part.mime_type))) {
            urls.push(u);
        }
    }
    return urls;
}
function collectVoiceUrls(parts) {
    if (!parts?.length) {
        return [];
    }
    const urls = [];
    for (const part of parts) {
        const t = (part.type ?? "").toLowerCase();
        const isVoice = t === "audio" ||
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
function hasVoiceInParts(parts) {
    if (!parts?.length) {
        return false;
    }
    return parts.some((p) => {
        const t = (p.type ?? "").toLowerCase();
        return (t === "audio" ||
            t === "voice" ||
            t === "ptt" ||
            t.includes("voice") ||
            /^audio\//i.test(p.mime_type ?? ""));
    });
}
function normalizeReactionType(value) {
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
function normalizeLinqEvent(event) {
    const eventType = event.type ?? event.event_type;
    const chat = event.chat ?? event.data?.chat;
    const message = event.message ?? event.data?.message ?? chat?.message;
    const dataParts = event.data?.parts;
    const dataSenderHandle = event.data?.sender_handle?.handle;
    const dataSenderIsMe = event.data?.sender_handle?.is_me;
    const dataMessageId = event.data?.id;
    const messageBody = message?.body;
    const fromHandle = message?.from_handle?.handle ?? chat?.message?.from_handle?.handle ?? dataSenderHandle;
    const isFromMe = Boolean(message?.from_handle?.is_me ?? chat?.message?.from_handle?.is_me ?? dataSenderIsMe);
    const normalizedText = event.text ??
        messageBody ??
        extractText(message?.parts ?? event.data?.message?.parts ?? dataParts) ??
        extractText(chat?.message?.parts);
    const normalizedReaction = event.reaction ??
        event.data?.reaction?.emoji ??
        normalizeReactionType(event.data?.reaction_type) ??
        message?.parts?.flatMap((part) => part.reactions ?? []).find(Boolean)?.emoji;
    const partSources = [message?.parts, event.data?.message?.parts, dataParts, chat?.message?.parts].filter(Boolean);
    const mediaFromParts = partSources.flatMap((p) => collectMediaUrls(p));
    const voiceFromParts = partSources.flatMap((p) => collectVoiceUrls(p));
    const attachmentUrls = [event.attachment, ...(event.attachments ?? [])]
        .filter((a) => Boolean(a?.url))
        .map((a) => a.url)
        .filter(isHttpUrl);
    const mediaUrls = Array.from(new Set([...mediaFromParts, ...attachmentUrls]));
    const voiceUrls = Array.from(new Set(voiceFromParts));
    const hasVoiceAttachment = voiceUrls.length > 0 ||
        hasVoiceInParts(message?.parts) ||
        hasVoiceInParts(event.data?.message?.parts) ||
        hasVoiceInParts(dataParts) ||
        hasVoiceInParts(chat?.message?.parts);
    return {
        ...event,
        type: eventType,
        isFromMe,
        chat_id: event.chat_id ?? event.thread_id ?? event.data?.chat_id ?? chat?.id,
        thread_id: event.thread_id ?? event.chat_id ?? event.data?.chat_id ?? chat?.id,
        user_id: event.user_id ?? event.handle ?? fromHandle ?? event.data?.from,
        handle: event.handle ?? fromHandle,
        text: normalizedText,
        message_id: event.message_id ?? message?.id ?? chat?.message?.id ?? dataMessageId ?? event.data?.message_id,
        reaction: normalizedReaction,
        chat,
        message,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        voiceUrls: voiceUrls.length > 0 ? voiceUrls : undefined,
        hasVoiceAttachment: hasVoiceAttachment || undefined,
    };
}
