export type LinqReaction = "👍" | "👎" | "❤️" | "🔥" | "✅" | string;

export type LinqAttachment = {
  type?: string;
  url?: string;
  mime_type?: string;
};

export type LinqHandle = {
  id?: string;
  handle?: string;
  is_me?: boolean;
  /** iMessage / contact display name when Linq provides it (Partner API webhooks). */
  name?: string;
  display_name?: string;
};

/** Group chat roster entry — see `chat.participants` on inbound webhooks. */
export type LinqChatParticipant = {
  user_id?: string;
  handle?: string;
  name?: string;
  display_name?: string;
};

export type LinqMessagePart = {
  type?: string;
  value?: string;
  /** HTTP(S) URL for attachment / image / audio parts when provided by Linq. */
  url?: string;
  mime_type?: string;
  /** Present on some `media` parts (e.g. images from iMessage). */
  filename?: string;
  reactions?: Array<{
    emoji?: string;
    handle?: LinqHandle;
  }> | null;
};

export type LinqChat = {
  id?: string;
  handles?: LinqHandle[];
  participants?: LinqChatParticipant[];
  message?: {
    id?: string;
    from_handle?: LinqHandle;
    parts?: LinqMessagePart[];
  };
};

export type LinqWebhookEvent = {
  id?: string;
  event_id?: string;
  type?: "message" | "reaction" | "message.received" | "message.sent" | "reaction.added" | string;
  isFromMe?: boolean;
  chat_id?: string;
  thread_id?: string;
  user_id?: string;
  handle?: string;
  text?: string;
  event_type?: string;
  chat?: LinqChat;
  message?: {
    id?: string;
    body?: string;
    parts?: LinqMessagePart[];
    from_handle?: LinqHandle;
  };
  message_id?: string;
  reaction?: LinqReaction;
  attachment?: LinqAttachment;
  attachments?: LinqAttachment[];
  data?: {
    chat?: LinqChat;
    chat_id?: string;
    id?: string;
    direction?: "inbound" | "outbound" | string;
    parts?: LinqMessagePart[];
    from?: string;
    sender_handle?: LinqHandle;
    /** Some v3 payloads use `sender` instead of `sender_handle`. */
    sender?: { name?: string; sender_id?: string; handle?: string };
    message?: {
      id?: string;
      parts?: LinqMessagePart[];
      from_handle?: LinqHandle;
    };
    reaction?: {
      emoji?: string;
    };
    message_id?: string;
    reaction_type?: string;
  };
  /** Derived in normalizeLinqEvent: HTTP(S) URLs from image/video parts and attachments. */
  mediaUrls?: string[];
  /** Derived: HTTP(S) URLs for voice/audio parts (for transcription). */
  voiceUrls?: string[];
  /** Derived: message includes an audio/voice part (transcription not applied here). */
  hasVoiceAttachment?: boolean;
  /**
   * Derived in normalizeLinqEvent: contact display name from `sender_handle.name`,
   * `from_handle.name`, or matching `chat.participants[].name` (Linq Partner API v3).
   */
  sender_display_name?: string;
};

export type LinqMessageResult = {
  chatId?: string;
  messageId?: string;
  raw: unknown;
};
