/**
 * Normalize Linq handles / phone numbers so the same person maps to one id when possible.
 */
export function normalizeParticipantId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "unknown") {
    return "unknown";
  }

  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return digits;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length >= 11) {
    return `+${digits.replace(/^\+/, "")}`;
  }

  return trimmed;
}
