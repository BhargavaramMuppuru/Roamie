/**
 * Roamie sends plain SMS/iMessage — Markdown like **bold** shows literally and looks clumsy.
 * Use short section titles, bullets (•), and blank lines between ideas.
 */
export function messageBlocks(...parts: (string | undefined | null | false)[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}
