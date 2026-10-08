/**
 * How close a stored secret is to lapsing: the `/secret list` STATUS column and the warnings a session
 * prints at startup read the same classification.
 */
import { describeTimeLeft, type ScopedVaultEntry, WARN_AT_FRACTIONS, warningThresholdCrossed } from "./vault";

/** How close an entry is to lapsing. */
export type ExpiryUrgency = "soon" | "halfway";

/**
 * Classify an entry against the warning thresholds. ONE owner, read by everything that has to
 * say "this one is nearly gone".
 *
 * THROUGH `warningThresholdCrossed`, NOT ITS OWN ARITHMETIC. {@link expiryWarnings} used to
 * compare against an inline `0.9` while `WARN_AT_FRACTIONS` said `[0.5, 0.9]`, so there were two
 * owners of "when do we warn" and they disagreed: the halfway warning the setting promised was
 * never raised by anything. The STATUS column in {@link renderSecretList} would have been the
 * third owner, which is why the classification lives here and not at either call site.
 *
 * The LAST fraction in the list is the urgent one, read from the list rather than written here
 * as a literal. That inline `0.9` was the original bug, and repeating it one level down would
 * have re-created it: adding a 0.99 threshold would then have described a secret with minutes
 * left as merely over halfway through its lifetime.
 */
export function expiryUrgency(entry: ScopedVaultEntry, now: number): ExpiryUrgency | null {
	const crossed = warningThresholdCrossed(entry, now);
	if (crossed === null) return null;
	return crossed >= WARN_AT_FRACTIONS[WARN_AT_FRACTIONS.length - 1] ? "soon" : "halfway";
}

/**
 * Warnings for secrets far enough through their lifetime to be worth mentioning.
 *
 * A sentence per entry, where `/secret list` shows the same classification as a two-word column.
 * Both read {@link expiryUrgency}, so a threshold added to `WARN_AT_FRACTIONS` takes effect in
 * both without a second edit, and neither can call a secret nearly expired while the other
 * calls it healthy.
 *
 * Each line names the remedy, because a warning you cannot act on is noise. Expiry deletes the
 * value, so the action is to extend it before that happens rather than after. The remedy is a
 * command, not a keystroke on a screen: `extend` is a reserved word in a terminal too, so the
 * line this prints is runnable wherever it is read.
 */
export function expiryWarnings(entries: readonly ScopedVaultEntry[], now: number): string[] {
	const warnings: string[] = [];
	for (const entry of entries) {
		const urgency = expiryUrgency(entry, now);
		if (urgency === null) continue;
		const phrase = urgency === "soon" ? "expires soon" : "is over halfway through its lifetime";
		warnings.push(
			`#${entry.name}# ${phrase}, ${describeTimeLeft(entry, now)}. ` +
				`Extend it with /secret extend ${entry.name} 7d, or it will be deleted.`,
		);
	}
	return warnings;
}
