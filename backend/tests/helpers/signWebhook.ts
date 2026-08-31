import crypto from "crypto";

/**
 * Matches `verifyWebhookSignature` in src/utils/webhookSecurity.ts:
 * HMAC-SHA256 of `${timestamp}.${rawBody}` as lowercase hex.
 */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
}
