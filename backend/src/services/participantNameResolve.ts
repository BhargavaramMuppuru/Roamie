import { ParticipantStatus } from "@prisma/client";
import { db } from "../db/client";
import { normalizeParticipantId } from "../utils/userId";

/**
 * Map human names (or +E.164) from a message to confirmed participants on this trip.
 * Matching: exact name (case-insensitive), first-word match, or phone id.
 */
export async function resolveParticipantsByNames(
  tripId: string,
  names: string[],
): Promise<{ userIds: string[]; unmatched: string[] }> {
  const participants = await db.participant.findMany({
    where: { tripId, status: ParticipantStatus.CONFIRMED },
  });

  const unmatched: string[] = [];
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const q = raw.trim();
    if (!q) {
      continue;
    }

    const lower = q.toLowerCase();
    const asPhone = normalizeParticipantId(q);

    let match = participants.find((p) => p.userId === asPhone);
    if (!match) {
      match = participants.find((p) => p.name?.trim().toLowerCase() === lower);
    }
    if (!match) {
      match = participants.find((p) => {
        const pn = p.name?.trim().toLowerCase();
        if (!pn) {
          return false;
        }
        const first = pn.split(/\s+/)[0];
        return first === lower || pn.startsWith(`${lower} `);
      });
    }

    if (match && !seen.has(match.userId)) {
      seen.add(match.userId);
      userIds.push(match.userId);
    } else if (!match) {
      unmatched.push(q);
    }
  }

  return { userIds, unmatched };
}
