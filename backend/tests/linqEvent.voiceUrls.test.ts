import { describe, it, expect } from "vitest";
import { normalizeLinqEvent } from "../src/utils/linqEvent";
import type { LinqWebhookEvent } from "../src/types/linq";

describe("normalizeLinqEvent mediaUrls (Linq type: media)", () => {
  it("collects image URL from data.parts with type media + image/jpeg", () => {
    const raw: LinqWebhookEvent = {
      event_type: "message.received",
      data: {
        chat: { id: "thread-1" },
        parts: [
          {
            type: "media",
            mime_type: "image/jpeg",
            url: "https://cdn.linqapp.com/attachments/x/photo.jpeg",
            filename: "IMG_6688.jpeg",
          },
        ],
        sender_handle: { handle: "+15550001", is_me: false },
        id: "msg-1",
      },
    };
    const n = normalizeLinqEvent(raw);
    expect(n.mediaUrls).toEqual(["https://cdn.linqapp.com/attachments/x/photo.jpeg"]);
  });
});

describe("normalizeLinqEvent voiceUrls", () => {
  it("collects audio part URLs from data.parts", () => {
    const raw: LinqWebhookEvent = {
      event_type: "message.received",
      data: {
        parts: [
          { type: "text", value: "hi" },
          { type: "audio", url: "https://cdn.example.com/voice.m4a", mime_type: "audio/m4a" },
        ],
      },
    };
    const n = normalizeLinqEvent(raw);
    expect(n.voiceUrls).toEqual(["https://cdn.example.com/voice.m4a"]);
    expect(n.hasVoiceAttachment).toBe(true);
  });
});
