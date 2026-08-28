export const LEGACY_ARCHIVE_KEY = "snapcompact";

export const LEGACY_FRAME_TOKEN_ESTIMATE = 5024;

const DIM_MARKERS = /[\u000e\u000f]/g;
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

export function hasLegacyArchive(preserveData: Record<string, unknown> | undefined): boolean {
	const candidate = preserveData?.[LEGACY_ARCHIVE_KEY];
	return !!candidate && typeof candidate === "object";
}

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

export function stripLegacyArchive(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(LEGACY_ARCHIVE_KEY in preserveData)) return preserveData;
	const { [LEGACY_ARCHIVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

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
