import path from "path";
import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { normalizeLinqEvent } from "../src/utils/linqEvent";
import type { LinqWebhookEvent } from "../src/types/linq";

function loadFixture(name: string): LinqWebhookEvent {
  const full = path.join(process.cwd(), "tests/fixtures/webhooks", name);
  return JSON.parse(readFileSync(full, "utf8")) as LinqWebhookEvent;
}

describe("normalizeLinqEvent (fixtures)", () => {
  it("extracts thread id, text, and inbound message type from nested message.received payload", () => {
    const raw = loadFixture("message-received-nested.json");
    const n = normalizeLinqEvent(raw);

    expect(n.type ?? n.event_type).toBe("message.received");
    expect(n.thread_id ?? n.chat_id).toBe("chat-thread-abc");
    expect(n.text).toContain("Miami trip");
    expect(n.isFromMe).toBe(false);
    expect(n.user_id ?? n.handle).toBe("+14155552671");
  });

  it("derives sender_display_name from sender_handle.name (Linq v3)", () => {
    const raw = loadFixture("message-received-sender-name.json");
    const n = normalizeLinqEvent(raw);

    expect(n.sender_display_name).toBe("Jordan Lee");
    expect(n.user_id ?? n.handle).toBe("+14155552671");
  });

  it("derives sender_display_name from chat.participants when sender name is on roster only", () => {
    const raw = loadFixture("message-received-participant-roster.json");
    const n = normalizeLinqEvent(raw);

    expect(n.sender_display_name).toBe("Roster Name");
  });

  it("normalizes standalone reaction.added with message_id and emoji", () => {
    const raw = loadFixture("reaction-attendance.json");
    const n = normalizeLinqEvent(raw);

    expect(n.type).toBe("reaction.added");
    expect(n.message_id).toBe("msg-tracked-001");
    expect(n.reaction).toBe("👍");
    expect(n.thread_id).toBe("chat-thread-abc");
  });

  it("marks outbound / self messages with isFromMe", () => {
    const raw = loadFixture("message-from-me.json");
    const n = normalizeLinqEvent(raw);

    expect(n.isFromMe).toBe(true);
  });

  it("maps Linq reaction_type like to thumb emoji", () => {
    const raw = loadFixture("reaction-like-maps-to-thumb.json");
    const n = normalizeLinqEvent(raw);

    expect(n.reaction).toBe("👍");
    expect(n.message_id).toBe("msg-tracked-002");
  });
});
