import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../src/utils/webhookSecurity";
import { signWebhookPayload } from "./helpers/signWebhook";

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const timestamp = "1740000000";
  const rawBody = '{"event_id":"evt-1","type":"message.received"}';

  it("accepts a valid hex signature matching timestamp + raw body", () => {
    const sig = signWebhookPayload(secret, timestamp, rawBody);
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: sig,
        timestamp,
        secret,
      }),
    ).toBe(true);
  });

  it("accepts sha256= prefix (common provider style)", () => {
    const sig = signWebhookPayload(secret, timestamp, rawBody);
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: `sha256=${sig}`,
        timestamp,
        secret,
      }),
    ).toBe(true);
  });

  it("rejects wrong body bytes", () => {
    const sig = signWebhookPayload(secret, timestamp, rawBody);
    expect(
      verifyWebhookSignature({
        rawBody: rawBody + " ",
        signature: sig,
        timestamp,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects wrong timestamp", () => {
    const sig = signWebhookPayload(secret, timestamp, rawBody);
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: sig,
        timestamp: "9999999999",
        secret,
      }),
    ).toBe(false);
  });

  it("returns true when secret is unset (verification disabled)", () => {
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: "anything",
        timestamp,
        secret: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when secret is set but headers are missing", () => {
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: undefined,
        timestamp,
        secret,
      }),
    ).toBe(false);
  });

  it("uses timing-safe comparison for equal-length digests", () => {
    const sig = signWebhookPayload(secret, timestamp, rawBody);
    const tampered = sig.slice(0, -1) + (sig.at(-1) === "0" ? "1" : "0");
    expect(sig.length).toBe(tampered.length);
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: tampered,
        timestamp,
        secret,
      }),
    ).toBe(false);
  });
});
