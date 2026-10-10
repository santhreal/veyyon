/**
 * The committed-prefix law: whether a new frame still aligns with the rows the engine already
 * committed to native scrollback, and the row to re-anchor at when it does not. `TUI#doRender` runs
 * it once per frame during prefix reconciliation, and the render-stress harness mirrors its shadow
 * commit ledger with `findCommittedPrefixResync`.
 *
 * Split out of `renderer.ts`; see `docs/internal/tui-core-renderer.md` for the zones it audits.
 */
import { sgrSequence } from "@veyyon/utils/ansi";

const SGR_SEQUENCE = sgrSequence("g");

/** Compare two rows ignoring SGR styling (theme restyles keep alignment). */
export function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

export function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

/** Find the first index in [from, limit) where rows are not equivalent. Returns -1 if none. */
export function firstRowDivergence(a: readonly string[], b: readonly string[], limit: number, from = 0): number {
	for (let i = from; i < limit; i++) {
		if (!rowsEquivalent(a[i]!, b[i]!)) return i;
	}
	return -1;
}

// Tail-alignment sampling bounds: look back through up to LOOKBACK rows of
// the committed prefix to collect SAMPLES non-blank comparisons.
const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

/**
 * Decide whether `frame` still aligns with the committed prefix, and where to
 * re-anchor the commit index when it does not. Returns the resync row index,
 * or -1 when no resync is needed.
 *
 * Zones (verifiedTo ≤ finalTo ≤ prefix.length):
 *   [0, verifiedTo)         VERIFIED exact rows — sampled with tolerance.
 *   [verifiedTo, finalTo)   NEWLY-FINAL rows — frozen visual snapshots whose
 *       source just became declared-final (the block finalized / a barrier
 *       cleared). Hard-scanned in FULL with no tolerance: any content change
 *       (a pending header settling, a preview replaced by its result, a tail
 *       shifting up after a barrier removal) re-anchors so the engine can
 *       erase-and-replay history with the final content exactly once (or, on
 *       ED3-unsafe multiplexers, recommit it below the frozen snapshot —
 *       duplication, never loss) instead of committing it nowhere and
 *       painting it nowhere.
 *   [finalTo, prefix.length) FROZEN visual snapshots of still-live rows —
 *       exempt: their drift is expected (a collapsing preview, a ticking
 *       progress tree) and must never spray re-anchors mid-run.
 *
 * The verified zone's sampled check exploits the asymmetry between the two
 * mutation classes: an in-place edit/restyle disturbs only the touched rows
 * (alignment below stays intact; the stale copy in history is the accepted
 * artifact), while an insertion/deletion shifts EVERY row below it. Up to 8
 * non-blank rows within the last 24 verified rows are compared SGR-stripped
 * (theme changes stay quiet), tolerating a SINGLE mismatch. The tolerance is
 * load-bearing for roots that report NO seam: an animated row already in
 * history would otherwise re-anchor on every glyph tick.
 *
 * Highly repetitive tails (identical filler rows) can mask a shift in the tail
 * sample, in which case the skipped rows are content-identical to the committed
 * ones — observationally harmless. Exported for the render-stress harness, whose
 * shadow commit ledger must mirror the engine's law exactly.
 */
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	verifiedTo: number = prefix.length,
	finalTo: number = verifiedTo,
): number {
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	const hardEnd = Math.min(prefix.length, Math.max(verified, Math.trunc(finalTo)));
	if (hardEnd === 0) return -1;
	// 1. Hard scan: frozen snapshots whose source just became final. Full
	// scan, no tolerance — a finalized row that changed must re-anchor.
	// 2. Tail sample over the verified zone, only when the hard scan is clean.
	if (
		frame.length >= hardEnd &&
		firstRowDivergence(frame, prefix, hardEnd, verified) === -1 &&
		tailSampleAligned(frame, prefix, verified)
	) {
		return -1;
	}
	// Misaligned (hard mismatch, tail-sample shift, or the frame no longer
	// covers the checked zones): re-anchor at the first row whose content
	// changed.
	const limit = Math.min(hardEnd, frame.length);
	const diverged = firstRowDivergence(frame, prefix, limit);
	return diverged >= 0 ? diverged : limit < hardEnd ? limit : -1;
}

/**
 * The tail sample over the verified zone `[0, verified)`: walk up from its end until LOOKBACK rows or SAMPLES
 * non-blank comparisons. Aligned when the sample has no signal (an all-blank tail) or at most one edited row.
 */
function tailSampleAligned(frame: readonly string[], prefix: readonly string[], verified: number): boolean {
	let samples = 0;
	let mismatches = 0;
	for (let j = 1; j <= verified && j <= RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
		const idx = verified - j;
		const row = frame[idx]!;
		const old = prefix[idx]!;
		if (row === old) {
			if (!isBlankRow(row)) samples++;
			continue;
		}
		if (isBlankRow(row) && isBlankRow(old)) continue;
		samples++;
		if (!rowsEquivalent(row, old)) mismatches++;
	}
	return samples === 0 || mismatches <= 1;
}

/**
 * Audit committed source alignment and accept tolerated verified-row changes.
 * Frozen rows retain their original snapshots until strict finalization.
 * The physical history remains in ScrollTape; this prefix tracks alignment.
 */
export function auditCommittedPrefix(
	frame: readonly string[],
	prefix: string[],
	verifiedTo: number,
	finalTo: number,
): number {
	const resyncTo = findCommittedPrefixResync(frame, prefix, verifiedTo, finalTo);
	if (resyncTo >= 0) return resyncTo;
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	for (let i = Math.max(0, verified - RESYNC_TAIL_LOOKBACK); i < verified; i++) {
		prefix[i] = frame[i]!;
	}
	return -1;
}
