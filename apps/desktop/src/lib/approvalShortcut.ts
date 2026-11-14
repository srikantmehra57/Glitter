/**
 * Guards for the approval keyboard shortcuts (⌘Y, ⇧⌘Y, ⌘⌫).
 *
 * Holding the key repeats keydown, and a quick second tap lands on whichever card
 * appeared next, so a decision could be taken on a card nobody had seen. Two rules
 * close that: a repeated keydown never decides, and an allow waits until its card
 * has been in view for a moment. Deny stays immediate, because refusing an unseen
 * card is the safe direction.
 */

/** How long a card must be in view before a shortcut may allow it. */
export const APPROVAL_ALLOW_DELAY_MS = 600;

/** The card that is in view, and since when. */
export type ShownApproval = { key: string; at: number };

/** The identity of a card on screen: the same approval in another thread is a new card. */
export function approvalViewKey(sessionId: string | null | undefined, approvalId: string | null | undefined): string | null {
  return sessionId && approvalId ? `${sessionId}:${approvalId}` : null;
}

/**
 * Carry the "since when" forward. The clock restarts only when a different card
 * comes into view, so unrelated store updates never push the delay out.
 */
export function trackShownApproval(previous: ShownApproval | null, key: string | null, now: number): ShownApproval | null {
  if (key == null) return null;
  return previous?.key === key ? previous : { key, at: now };
}

/** Whether a decision shortcut must be ignored right now. */
export function approvalShortcutBlocked(input: { repeat: boolean; allow: boolean; shown: ShownApproval | null; key: string | null; now: number }): boolean {
  if (input.repeat) return true;
  if (!input.allow) return false;
  if (!input.shown || input.shown.key !== input.key) return true;
  return input.now - input.shown.at < APPROVAL_ALLOW_DELAY_MS;
}
