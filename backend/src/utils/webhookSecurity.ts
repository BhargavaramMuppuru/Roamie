import crypto from "crypto";

export function verifyWebhookSignature(input: {
  rawBody?: string;
  signature?: string;
  timestamp?: string;
  secret?: string;
}): boolean {
  if (!input.secret) {
    return true;
  }

  if (!input.rawBody || !input.signature || !input.timestamp) {
    return false;
  }

  const signedPayload = `${input.timestamp}.${input.rawBody}`;
  const digest = crypto.createHmac("sha256", input.secret).update(signedPayload).digest("hex");

  try {
    const cleanedSignature = input.signature.replace(/^v1,?=/, "").replace(/^sha256=/, "");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(cleanedSignature));
  } catch {
    return false;
  }
}
