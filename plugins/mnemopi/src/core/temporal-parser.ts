import { DAY_MS } from "@veyyon/utils/time";
import { parseQueryTime, type QueryTime } from "../util/datetime";
import { unicodeWordTokens } from "../util/regex";

export type DatePrecision = "day" | "week" | "month" | "year" | "relative" | "unknown";
export type ParsedNaturalDate = [eventDate: Date, precision: Exclude<DatePrecision, "unknown">, temporalTags: string[]];

export interface TemporalInfo {
	event_date: string | null;
	event_date_precision: DatePrecision;
	temporal_tags: string[];
	primary_signal: string | null;
}

// Day name -> weekday number (Monday=0, Sunday=6), matching Python datetime.weekday().
export const DAY_MAP: Readonly<Record<string, number>> = {
	monday: 0,
	tuesday: 1,
	wednesday: 2,
	thursday: 3,
	friday: 4,
	saturday: 5,
	sunday: 6,
	mon: 0,
	tue: 1,
	wed: 2,
	thu: 3,
	fri: 4,
	sat: 5,
	sun: 6,
};

export const MONTH_MAP: Readonly<Record<string, number>> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

export const NAMED_TIMES: Readonly<Record<string, readonly [startHour: number, endHour: number]>> = {
	morning: [6, 12],
	afternoon: [12, 17],
	evening: [17, 21],
	night: [21, 6],
	midnight: [0, 1],
	noon: [12, 13],
	dawn: [5, 7],
	dusk: [18, 21],
};

const NAMED_TIME_KEYS = ["morning", "afternoon", "evening", "night", "midnight", "noon", "dawn", "dusk"] as const;

function dateUtc(year: number, month: number, day: number): Date | undefined {
	const value = new Date(Date.UTC(year, month - 1, day));
	if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
		return undefined;
	}
	return value;
}

function addDays(value: Date, days: number): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addSeconds(value: Date, seconds: number): Date {
	return addDays(new Date(value.getTime() + seconds * 1000), 0);
}

function dateOnly(value: Date): Date {
	return dateUtc(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) as Date;
}

function isoDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function pythonWeekday(value: Date): number {
	return (value.getUTCDay() + 6) % 7;
}

function dayName(value: Date): string {
	const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
	return names[value.getUTCDay()] as string;
}

function isoWeek(value: Date): number {
	const d = dateOnly(value);
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

function finiteDate(value: Date): Date | undefined {
	return Number.isFinite(value.getTime()) ? value : undefined;
}

function parseReference(reference?: QueryTime): Date {
	return parseQueryTime(reference);
}

export function resolveRelativeDay(reference: Date, dayNameText: string, qualifier = "this"): Date {
	const targetWd = DAY_MAP[dayNameText.toLowerCase()];
	if (targetWd === undefined) return dateOnly(reference);

	const currentWd = pythonWeekday(reference);
	if (qualifier === "this") {
		const diff = (currentWd - targetWd + 7) % 7;
		return addDays(reference, -diff);
	}
	if (qualifier === "last") {
		const diff = ((currentWd - targetWd + 7) % 7) + 7;
		return addDays(reference, -diff);
	}
	if (qualifier === "next") {
		let diff = (targetWd - currentWd + 7) % 7;
		if (diff === 0) diff = 7;
		return addDays(reference, diff);
	}
	return dateOnly(reference);
}

function tagsForDay(value: Date): string[] {
	return [isoDate(value), `week-${isoWeek(value)}-${value.getUTCFullYear()}`, dayName(value)];
}

const DELTA_UNIT_DAYS: Record<string, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};
const DELTA_UNIT_SECONDS: Record<string, number> = {
	second: 1,
	minute: 60,
	hour: 3600,
};

function deltaDate(reference: Date, num: number, unit: string, direction: 1 | -1): Date | undefined {
	if (!Number.isSafeInteger(num)) return undefined;
	const days = DELTA_UNIT_DAYS[unit];
	if (days !== undefined) return finiteDate(addDays(reference, direction * num * days));
	const sec = DELTA_UNIT_SECONDS[unit];
	if (sec !== undefined) return finiteDate(addSeconds(reference, direction * num * sec));
	return undefined;
}

function dayDate(value: Date | undefined): ParsedNaturalDate | undefined {
	return value === undefined ? undefined : [value, "day", tagsForDay(value)];
}

function relativePeriod(
	ref: Date,
	qualifier: "this" | "last" | "next",
	unit: "week" | "month" | "year",
): ParsedNaturalDate {
	const offset = qualifier === "this" ? 0 : qualifier === "last" ? -1 : 1;
	const tag = `${qualifier}-${unit}`;
	if (unit === "week") {
		const d = offset === 0 ? dateOnly(ref) : addDays(ref, offset * 7);
		return [d, "week", [`week-${isoWeek(d)}-${d.getUTCFullYear()}`, tag]];
	}
	if (unit === "month") {
		const totalMonths = ref.getUTCFullYear() * 12 + ref.getUTCMonth() + offset;
		const d =
			offset === 0 ? dateOnly(ref) : (dateUtc(Math.floor(totalMonths / 12), (totalMonths % 12) + 1, 1) as Date);
		return [d, "month", [`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, tag]];
	}
	const d = offset === 0 ? dateOnly(ref) : (dateUtc(ref.getUTCFullYear() + offset, 1, 1) as Date);
	return [d, "year", [String(d.getUTCFullYear()), tag]];
}

/**
 * The date `num` units before (`-1`) or after (`1`) `ref`. A count too large to land on a representable
 * date ends the parse with no date rather than trying a later form.
 */
function deltaResult(ref: Date, match: RegExpExecArray, direction: 1 | -1): ParsedNaturalDate | null {
	const num = Number.parseInt(match[1] as string, 10);
	const unit = match[2] as string;
	const d = deltaDate(ref, num, unit, direction);
	if (d === undefined) return null;
	const tag = direction === -1 ? `${num}-${unit}s-ago` : `in-${num}-${unit}s`;
	return [d, unit === "day" || unit === "hour" ? "day" : "week", [isoDate(d), tag]];
}

function offsetDay(ref: Date, days: number, label: string): ParsedNaturalDate {
	const d = addDays(ref, days);
	return [d, "day", [isoDate(d), dayName(d), label]];
}

/** The weekday `parsedDayName` relative to `ref`, in this week when no qualifier was written. */
function weekdayDate(ref: Date, parsedDayName: string, qualifier?: string): ParsedNaturalDate {
	const d = resolveRelativeDay(ref, parsedDayName, qualifier ?? "this");
	const tags = [isoDate(d), `week-${isoWeek(d)}-${d.getUTCFullYear()}`, parsedDayName];
	if (qualifier !== undefined) tags.push(qualifier);
	return [d, "day", tags];
}

/**
 * One phrase form `parseNlDate` recognizes. `resolve` returns the date, `undefined` to try the next form,
 * or `null` to end the parse with no date.
 */
interface DateForm {
	pattern: RegExp;
	/** Match against the text as written instead of its lowercased, trimmed form. */
	raw?: true;
	resolve(match: RegExpExecArray, ref: Date): ParsedNaturalDate | null | undefined;
}

// Forms are tried in order and the first that resolves wins. Compound phrases MUST precede the single
// words they contain: "day before yesterday" contains "yesterday" and "day after tomorrow" contains
// "tomorrow", so a bare yesterday/tomorrow form first would shadow them and resolve two days off.
const DATE_FORMS: readonly DateForm[] = [
	{
		pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/,
		raw: true,
		resolve: m =>
			dayDate(
				dateUtc(
					Number.parseInt(m[1] as string, 10),
					Number.parseInt(m[2] as string, 10),
					Number.parseInt(m[3] as string, 10),
				),
			),
	},
	{
		pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/,
		raw: true,
		resolve: m => {
			const a = Number.parseInt(m[1] as string, 10);
			const b = Number.parseInt(m[2] as string, 10);
			const year = Number.parseInt(m[3] as string, 10);
			const y = year < 100 ? year + 2000 : year;
			return dayDate(a > 12 ? dateUtc(y, b, a) : dateUtc(y, a, b));
		},
	},
	{
		pattern:
			/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/,
		resolve: (m, ref) =>
			dayDate(
				dateUtc(
					m[3] === undefined ? ref.getUTCFullYear() : Number.parseInt(m[3], 10),
					MONTH_MAP[m[1] as string] ?? 1,
					Number.parseInt(m[2] as string, 10),
				),
			),
	},
	{
		pattern: /\btoday\b/,
		resolve: (_m, ref) => {
			const d = dateOnly(ref);
			return [d, "day", [isoDate(d), dayName(d)]];
		},
	},
	{ pattern: /\bday\s+after\s+tomorrow\b/, resolve: (_m, ref) => offsetDay(ref, 2, "day after tomorrow") },
	{ pattern: /\bday\s+before\s+yesterday\b/, resolve: (_m, ref) => offsetDay(ref, -2, "day before yesterday") },
	{ pattern: /\byesterday\b/, resolve: (_m, ref) => offsetDay(ref, -1, "yesterday") },
	{ pattern: /\btomorrow\b/, resolve: (_m, ref) => offsetDay(ref, 1, "tomorrow") },
	{
		pattern:
			/\b(last|this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/,
		resolve: (m, ref) => weekdayDate(ref, m[2] as string, m[1] as string),
	},
	{
		pattern: /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
		resolve: (m, ref) => weekdayDate(ref, m[2] as string),
	},
	{
		pattern: /\b(this|last|next)\s+(week|month|year)\b/,
		resolve: (m, ref) => relativePeriod(ref, m[1] as "this" | "last" | "next", m[2] as "week" | "month" | "year"),
	},
	{
		pattern: /\b(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+(ago|before|earlier|back)\b/,
		resolve: (m, ref) => deltaResult(ref, m, -1),
	},
	{
		pattern: /\bin\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?\b/,
		resolve: (m, ref) => deltaResult(ref, m, 1),
	},
	{ pattern: /\b(recently|lately|not long ago)\b/, resolve: (_m, ref) => [dateOnly(ref), "relative", ["recently"]] },
	{
		pattern: /\b(a while ago|some time ago|long ago)\b/,
		resolve: (_m, ref) => [dateOnly(ref), "relative", ["vague"]],
	},
];

export function parseNlDate(text: string, reference?: QueryTime): ParsedNaturalDate | null {
	const ref = parseReference(reference);
	const textLower = text.toLowerCase().trim();
	for (const form of DATE_FORMS) {
		const match = form.pattern.exec(form.raw ? text : textLower);
		if (match === null) continue;
		const parsed = form.resolve(match, ref);
		if (parsed !== undefined) return parsed;
	}
	return null;
}

export function extractTemporal(text: string, reference?: QueryTime): TemporalInfo {
	const result = parseNlDate(text, reference);
	const tags: string[] = [];
	// Match named times as whole words, not substrings: every NAMED_TIME_KEYS
	// entry is a single token, and some are substrings of others ("night" of
	// "midnight", "noon" of "afternoon"). A bare `includes` check tagged
	// "midnight" as "night" (the shorter word appears earlier in the key order),
	// so the real named time was never recorded.
	const words = new Set(unicodeWordTokens(text.toLowerCase()));
	for (const timeName of NAMED_TIME_KEYS) {
		if (words.has(timeName)) {
			tags.push(timeName);
			break;
		}
	}

	if (result === null) {
		return {
			event_date: null,
			event_date_precision: "unknown",
			temporal_tags: tags,
			primary_signal: tags[0] ?? null,
		};
	}

	const [eventDate, precision, parsedTags] = result;
	const allTags = parsedTags.concat(tags);
	return {
		event_date: isoDate(eventDate),
		event_date_precision: precision,
		temporal_tags: allTags,
		primary_signal: allTags[0] ?? null,
	};
}

export function extractDateFromText(text: string, reference?: QueryTime): string | null {
	return extractTemporal(text, reference).event_date;
}
