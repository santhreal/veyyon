import { ISO_DATE_RE } from "@veyyon/pi-utils";

const TZ_RE = /(?:Z|[+-]\d\d:?\d\d)$/;
// ONE PLACE: grammar owned by pi-utils regex.ts.
const DATE_ONLY_RE = ISO_DATE_RE;

export type QueryTime = string | Date | null | undefined;

export function parseIsoDateTimeUtc(value: string): Date {
	let text = value.trim();
	if (!text) throw new RangeError("Invalid ISO datetime: empty string");
	if (DATE_ONLY_RE.test(text)) text += "T00:00:00Z";
	else if (!TZ_RE.test(text)) text += "Z";
	const date = new Date(text);
	if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO datetime: ${value}`);
	return date;
}

export function normalizeDateTimeUtc(value: Date): Date {
	const time = value.getTime();
	if (Number.isNaN(time)) throw new RangeError("Invalid Date");
	return new Date(time);
}

export function parseQueryTimeStrict(value: QueryTime): Date {
	if (value === null || value === undefined) return new Date();
	return typeof value === "string" ? parseIsoDateTimeUtc(value) : normalizeDateTimeUtc(value);
}

export function toUtcIso(value: Date = new Date()): string {
	return normalizeDateTimeUtc(value).toISOString();
}
