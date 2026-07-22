/**
 * Backward-compatible reader for the removed image-archive ("snapcompact")
 * compaction engine. New sessions never write this state. Old sessions may
 * still carry a persisted frame archive under the {@link LEGACY_ARCHIVE_KEY}
 * preserve-data key; when such a session next compacts, its plaintext source
 * regions are drained into the LLM summary and the stale archive is dropped, so
 * the session degrades to a standard text summary without losing content and
 * without ever re-attaching image frames to the rebuilt context.
 *
 * This module is deliberately self-contained (no dependency on the deleted
 * `@veyyon/snapcompact` package): it re-implements only the archive-source-text
 * reconstruction and strip logic needed for that one-way migration.
 */

/** Preserve-data slot the removed snapcompact engine wrote its archive under. */
export const LEGACY_ARCHIVE_KEY = "snapcompact";

/**
 * Per-image token estimate for legacy persisted archive frames. Frames rendered
 * at >=1568px and providers bill the downscaled cap, so they cost far more than
 * an ordinary uploaded image. Kept only so token accounting for a still-loaded
 * legacy `compactionSummary` frame block stays accurate.
 */
export const LEGACY_FRAME_TOKEN_ESTIMATE = 5024;

/** Stray ink toggles the archive text could contain; stripped on read. */
const DIM_MARKERS = /[\u000e\u000f]/g;
/** Glyph the archive used in place of a newline in its stored source text. */
const NEWLINE_GLYPH = "█";

interface LegacyArchiveSlot {
	text?: unknown;
	textHead?: unknown;
	textTail?: unknown;
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toPlainText(text: string): string {
	return text.replace(DIM_MARKERS, "").replaceAll(NEWLINE_GLYPH, "\n");
}

/** Whether `preserveData` carries a legacy snapcompact archive slot at all. */
export function hasLegacyArchive(preserveData: Record<string, unknown> | undefined): boolean {
	const candidate = preserveData?.[LEGACY_ARCHIVE_KEY];
	return !!candidate && typeof candidate === "object";
}

/**
 * Reconstruct the archive's plaintext source for LLM summarization, mirroring
 * the removed engine's `archiveSourceText`: prefer the full `text`, else join
 * the kept head/tail regions. Returns `undefined` when the slot is absent or
 * carries no text (e.g. a frames-only archive, which cannot be re-read as text).
 */
export function legacyArchiveSourceText(preserveData: Record<string, unknown> | undefined): string | undefined {
	const candidate = preserveData?.[LEGACY_ARCHIVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const slot = candidate as LegacyArchiveSlot;
	const text =
		readNonEmptyString(slot.text) ??
		[readNonEmptyString(slot.textHead), readNonEmptyString(slot.textTail)]
			.filter((part): part is string => part !== undefined)
			.join(NEWLINE_GLYPH);
	return text.length > 0 ? toPlainText(text) : undefined;
}

/**
 * Drop the legacy archive slot from `preserveData`, returning the remaining
 * state — or `undefined` when nothing else remains, so an empty `{}` is never
 * persisted. Callers strip the archive once its text has been migrated into a
 * new summary, preventing the stale frames from leaking back into the context.
 */
export function stripLegacyArchive(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(LEGACY_ARCHIVE_KEY in preserveData)) return preserveData;
	const { [LEGACY_ARCHIVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Redact the archive slot's plaintext regions (`text`/`textHead`/`textTail`) in
 * place-free fashion so the legacy-archive migration cannot ship raw archived
 * user/tool text to the provider. Every other preserve-data key passes through
 * byte-identical; the same reference is returned when nothing changes.
 */
export function redactLegacyArchiveText(
	preserveData: Record<string, unknown> | undefined,
	redact: (value: string) => string,
): Record<string, unknown> | undefined {
	if (!hasLegacyArchive(preserveData) || !preserveData) return preserveData;
	const slot = preserveData[LEGACY_ARCHIVE_KEY] as Record<string, unknown>;
	const redacted: Record<string, unknown> = { ...slot };
	let changed = false;
	for (const key of ["text", "textHead", "textTail"] as const) {
		const value = slot[key];
		if (typeof value !== "string" || value.length === 0) continue;
		const next = redact(value);
		if (next === value) continue;
		redacted[key] = next;
		changed = true;
	}
	return changed ? { ...preserveData, [LEGACY_ARCHIVE_KEY]: redacted } : preserveData;
}
