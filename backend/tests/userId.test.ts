import { describe, it, expect } from "vitest";
import { normalizeParticipantId } from "../src/utils/userId";

describe("normalizeParticipantId", () => {
  it("normalizes 10-digit US numbers to E.164 +1", () => {
    expect(normalizeParticipantId("4155552671")).toBe("+14155552671");
  });

  it("preserves explicit country code", () => {
    expect(normalizeParticipantId("+441234567890")).toBe("+441234567890");
  });

  it("returns unknown for empty", () => {
    expect(normalizeParticipantId("unknown")).toBe("unknown");
    expect(normalizeParticipantId("   ")).toBe("unknown");
  });
});
