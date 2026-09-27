/**
 * Metricly's world: 180 days of daily metrics for every segment (country × plan × acquisition
 * channel), and the one set of date, aggregation, alert and CSV rules that the pages, the export
 * endpoint and the graders share.
 */

import type { Seeded } from "../../../../engine/kit/seeded";

export const DAY_COUNT = 180;

export interface Dimension {
	readonly id: string;
	readonly label: string;
}

export const COUNTRIES: readonly Dimension[] = [
	{ id: "us", label: "United States" },
	{ id: "de", label: "Germany" },
	{ id: "gb", label: "United Kingdom" },
	{ id: "fr", label: "France" },
	{ id: "br", label: "Brazil" },
	{ id: "in", label: "India" },
];

export const PLANS: readonly Dimension[] = [
	{ id: "free", label: "Free" },
	{ id: "starter", label: "Starter" },
	{ id: "pro", label: "Pro" },
	{ id: "enterprise", label: "Enterprise" },
];

export const CHANNELS: readonly Dimension[] = [
	{ id: "organic", label: "Organic" },
	{ id: "paid-search", label: "Paid search" },
	{ id: "social", label: "Social" },
	{ id: "referral", label: "Referral" },
	{ id: "newsletter", label: "Newsletter" },
	{ id: "partners", label: "Partners" },
];

export type DimensionKey = "countries" | "plans" | "channels";

export interface DimensionInfo {
	/** The query parameter that carries the dimension's filter, as comma-separated ids. */
	readonly param: string;
	readonly title: string;
	readonly values: readonly Dimension[];
}

export const DIMENSIONS: Readonly<Record<DimensionKey, DimensionInfo>> = {
	countries: { param: "country", title: "Country", values: COUNTRIES },
	plans: { param: "plan", title: "Plan", values: PLANS },
	channels: { param: "channel", title: "Channel", values: CHANNELS },
};

export const DIMENSION_KEYS: readonly DimensionKey[] = ["countries", "plans", "channels"];

export function labelOf(key: DimensionKey, id: string): string {
	return DIMENSIONS[key].values.find(value => value.id === id)?.label ?? id;
}

export type MetricId = "signups" | "dau" | "revenue" | "churn";

export interface Metric {
	readonly id: MetricId;
	readonly label: string;
	/** A bucket of several days holds their sum, or for a level such as active users their rounded mean. */
	readonly aggregate: "sum" | "mean";
	/** Whole dollars. */
	readonly money: boolean;
}

export const METRICS: readonly Metric[] = [
	{ id: "signups", label: "Signups", aggregate: "sum", money: false },
	{ id: "dau", label: "Active users", aggregate: "mean", money: false },
	{ id: "revenue", label: "Revenue", aggregate: "sum", money: true },
	{ id: "churn", label: "Churned accounts", aggregate: "sum", money: false },
];

export const METRIC_BY_ID: Readonly<Record<MetricId, Metric>> = {
	signups: METRICS[0] as Metric,
	dau: METRICS[1] as Metric,
	revenue: METRICS[2] as Metric,
	churn: METRICS[3] as Metric,
};

export function isMetricId(value: string): value is MetricId {
	return METRICS.some(metric => metric.id === value);
}

export type Grouping = "day" | "week" | "month";

export const GROUPINGS: readonly Grouping[] = ["day", "week", "month"];

export const GROUPING_LABELS: Readonly<Record<Grouping, string>> = { day: "Daily", week: "Weekly", month: "Monthly" };

export function isGrouping(value: string): value is Grouping {
	return (GROUPINGS as readonly string[]).includes(value);
}

export interface Segment {
	readonly country: string;
	readonly plan: string;
	readonly channel: string;
}

/** Ids chosen per dimension; an empty list selects every value. */
export interface Filters {
	readonly countries: readonly string[];
	readonly plans: readonly string[];
	readonly channels: readonly string[];
}

export const NO_FILTERS: Filters = { countries: [], plans: [], channels: [] };

export interface View extends Filters {
	readonly from: string;
	readonly to: string;
	readonly group: Grouping;
}

export interface SavedReport extends View {
	readonly id: string;
	readonly name: string;
	readonly metric: MetricId;
	readonly seeded: boolean;
}

export type Condition = "drop-pct" | "rise-pct" | "below" | "above";

export const CONDITIONS: readonly { readonly id: Condition; readonly label: string }[] = [
	{ id: "drop-pct", label: "Drops by more than X% vs the prior day" },
	{ id: "rise-pct", label: "Rises by more than X% vs the prior day" },
	{ id: "below", label: "Falls below X" },
	{ id: "above", label: "Goes above X" },
];

export type NotifyChannel = "email" | "slack" | "webhook";

export const NOTIFY_CHANNELS: readonly { readonly id: NotifyChannel; readonly label: string }[] = [
	{ id: "email", label: "Email" },
	{ id: "slack", label: "Slack" },
	{ id: "webhook", label: "Webhook" },
];

export interface AlertRule extends Filters {
	readonly id: string;
	readonly name: string;
	readonly metric: MetricId;
	readonly condition: Condition;
	readonly threshold: number;
	readonly notify: NotifyChannel;
	readonly recipient: string;
	readonly seeded: boolean;
}

/** One CSV the export endpoint served, with the parameters it was asked for. */
export interface ExportLog extends Filters {
	readonly widget: string;
	readonly metric: MetricId;
	/** The dimension a breakdown widget splits by; null for a time series. */
	readonly by: DimensionKey | null;
	readonly from: string;
	readonly to: string;
	readonly group: Grouping;
}

export interface AnalyticsWorld {
	/** The first day with data. */
	readonly start: string;
	/** The last day with data: the dashboard's "today". */
	readonly today: string;
	readonly segments: readonly Segment[];
	/** Per metric, per segment, one value per day from `start`. Revenue is in whole dollars. */
	readonly values: Readonly<Record<MetricId, number[][]>>;
	/** What the dashboard shows when opened without a query. */
	defaultView: View;
	readonly reports: SavedReport[];
	readonly alerts: AlertRule[];
}

// ---------------------------------------------------------------------------------------------
// Dates, as ISO `YYYY-MM-DD` strings in UTC

const DAY_MS = 86_400_000;

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function dayNumber(iso: string): number {
	return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

export function isoDate(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
	return isoDate(dayNumber(iso) + days);
}

export function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(dayNumber(value)) === value;
}

/** 0 for Monday through 6 for Sunday. */
export function weekday(iso: string): number {
	return (new Date(dayNumber(iso) * DAY_MS).getUTCDay() + 6) % 7;
}

/** The ISO 8601 week holding the day, as `YYYY-Www`. */
export function isoWeekLabel(iso: string): string {
	const thursday = dayNumber(iso) - weekday(iso) + 3;
	const year = new Date(thursday * DAY_MS).getUTCFullYear();
	const week = Math.floor((thursday - dayNumber(`${year}-01-01`)) / 7) + 1;
	return `${year}-W${pad2(week)}`;
}

export function monthStart(iso: string): string {
	return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
	const year = Number(iso.slice(0, 4));
	const month = Number(iso.slice(5, 7));
	return isoDate(Math.round(Date.UTC(year, month, 0) / DAY_MS));
}

export function quarterStart(iso: string): string {
	const month = Number(iso.slice(5, 7));
	return `${iso.slice(0, 4)}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
}

/** `February 11, 2025`. */
export function longDate(iso: string): string {
	return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

/** `Feb 11, 2025`. */
export function shortDate(iso: string): string {
	return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]?.slice(0, 3)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

/** `March 2025` from `2025-03`. */
export function monthName(month: string): string {
	return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** `Feb 10 – Feb 16, 2025`, with both years when they differ. */
export function spanOf(from: string, to: string): string {
	if (from === to) return `${WEEKDAY_NAMES[weekday(from)]}, ${shortDate(from)}`;
	const head = from.slice(0, 4) === to.slice(0, 4) ? shortDate(from).slice(0, -6) : shortDate(from);
	return `${head} – ${shortDate(to)}`;
}

export interface Preset {
	readonly id: string;
	readonly label: string;
	readonly from: string;
	readonly to: string;
}

/** The date-range picker's presets, relative to the world's today and clipped to its data. */
export function presetsOf(world: { readonly start: string; readonly today: string }): Preset[] {
	const { start, today } = world;
	const lastMonthEnd = addDays(monthStart(today), -1);
	const lastQuarterEnd = addDays(quarterStart(today), -1);
	const presets: Preset[] = [
		{ id: "last-7", label: "Last 7 days", from: addDays(today, -6), to: today },
		{ id: "last-30", label: "Last 30 days", from: addDays(today, -29), to: today },
		{ id: "last-90", label: "Last 90 days", from: addDays(today, -89), to: today },
		{ id: "this-month", label: "This month", from: monthStart(today), to: today },
		{ id: "last-month", label: "Last month", from: monthStart(lastMonthEnd), to: lastMonthEnd },
		{ id: "this-quarter", label: "This quarter", from: quarterStart(today), to: today },
		{ id: "last-quarter", label: "Last quarter", from: quarterStart(lastQuarterEnd), to: lastQuarterEnd },
		{ id: "all", label: "All data", from: start, to: today },
	];
	return presets.map(preset => (preset.from < start ? { ...preset, from: start } : preset));
}

export function presetById(world: { readonly start: string; readonly today: string }, id: string): Preset {
	const preset = presetsOf(world).find(entry => entry.id === id);
	if (!preset) throw new Error(`no preset ${id}`);
	return preset;
}

// ---------------------------------------------------------------------------------------------
// Aggregation

export function dayIndex(world: AnalyticsWorld, iso: string): number {
	return dayNumber(iso) - dayNumber(world.start);
}

export function dateAt(world: AnalyticsWorld, index: number): string {
	return addDays(world.start, index);
}

const SEGMENT_FIELD: Readonly<Record<DimensionKey, keyof Segment>> = {
	countries: "country",
	plans: "plan",
	channels: "channel",
};

export function matches(segment: Segment, filters: Filters): boolean {
	return DIMENSION_KEYS.every(key => filters[key].length === 0 || filters[key].includes(segment[SEGMENT_FIELD[key]]));
}

/** The indexes of the segments a filter selects. */
export function segmentsMatching(world: AnalyticsWorld, filters: Partial<Filters>): number[] {
	const full = { ...NO_FILTERS, ...filters };
	const out: number[] = [];
	world.segments.forEach((segment, index) => {
		if (matches(segment, full)) out.push(index);
	});
	return out;
}

/** The metric summed over the matching segments, one value per day from `from` to `to`. */
export function dailyTotals(
	world: AnalyticsWorld,
	metric: MetricId,
	filters: Filters,
	from: string,
	to: string,
): number[] {
	const first = dayIndex(world, from);
	const out = new Array<number>(dayIndex(world, to) - first + 1).fill(0);
	world.segments.forEach((segment, index) => {
		if (!matches(segment, filters)) return;
		const row = world.values[metric][index] ?? [];
		for (let day = 0; day < out.length; day++) out[day] = (out[day] ?? 0) + (row[first + day] ?? 0);
	});
	return out;
}

/** A bucket's value from its days: their sum, or for a level metric their rounded mean. */
export function combine(metric: MetricId, daily: readonly number[]): number {
	const total = daily.reduce((sum, value) => sum + value, 0);
	return METRIC_BY_ID[metric].aggregate === "mean" && daily.length > 0 ? Math.round(total / daily.length) : total;
}

export interface Point {
	readonly key: string;
	/** What the tooltip heads with: `2025-02-11`, `2025-W07`, `2025-03` or a segment name. */
	readonly label: string;
	/** The axis label. */
	readonly tick: string;
	readonly span: string;
	readonly start: string;
	readonly end: string;
	/** The period runs past the range, so only its days inside the range are counted. */
	readonly partial: boolean;
	readonly value: number;
}

interface Period {
	readonly key: string;
	readonly tick: string;
	readonly first: string;
	readonly last: string;
}

function periodOf(iso: string, group: Grouping): Period {
	if (group === "day") return { key: iso, tick: shortDate(iso).slice(0, -6), first: iso, last: iso };
	if (group === "week") {
		const monday = addDays(iso, -weekday(iso));
		const key = isoWeekLabel(iso);
		return { key, tick: key.slice(5), first: monday, last: addDays(monday, 6) };
	}
	return { key: iso.slice(0, 7), tick: shortDate(iso).slice(0, 3), first: monthStart(iso), last: monthEnd(iso) };
}

/** The range split into days, ISO weeks or months; the first and last may be cut by the range. */
export function seriesOf(world: AnalyticsWorld, metric: MetricId, view: View): Point[] {
	const daily = dailyTotals(world, metric, view, view.from, view.to);
	const origin = dayNumber(view.from);
	const points: Point[] = [];
	for (let day = origin; day <= dayNumber(view.to); ) {
		const period = periodOf(isoDate(day), view.group);
		const start = period.first < view.from ? view.from : period.first;
		const end = period.last > view.to ? view.to : period.last;
		points.push({
			key: period.key,
			label: period.key,
			tick: period.tick,
			span: spanOf(start, end),
			start,
			end,
			partial: start !== period.first || end !== period.last,
			value: combine(metric, daily.slice(dayNumber(start) - origin, dayNumber(end) - origin + 1)),
		});
		day = dayNumber(end) + 1;
	}
	return points;
}

/** The metric over the whole range, one bar per value of a dimension the view does not exclude. */
export function breakdownOf(world: AnalyticsWorld, metric: MetricId, by: DimensionKey, view: View): Point[] {
	return DIMENSIONS[by].values
		.filter(value => view[by].length === 0 || view[by].includes(value.id))
		.map(value => ({
			key: value.id,
			label: value.label,
			tick: value.label,
			span: spanOf(view.from, view.to),
			start: view.from,
			end: view.to,
			partial: false,
			value: combine(metric, dailyTotals(world, metric, { ...view, [by]: [value.id] }, view.from, view.to)),
		}));
}

export interface DrillRow {
	readonly country: string;
	readonly plan: string;
	readonly channel: string;
	readonly value: number;
}

/** Every matching segment with activity in the range, largest first. */
export function drillRows(
	world: AnalyticsWorld,
	metric: MetricId,
	filters: Filters,
	from: string,
	to: string,
): DrillRow[] {
	const first = dayIndex(world, from);
	const last = dayIndex(world, to);
	const rows: DrillRow[] = [];
	world.segments.forEach((segment, index) => {
		if (!matches(segment, filters)) return;
		const value = combine(metric, (world.values[metric][index] ?? []).slice(first, last + 1));
		if (value === 0) return;
		rows.push({
			country: labelOf("countries", segment.country),
			plan: labelOf("plans", segment.plan),
			channel: labelOf("channels", segment.channel),
			value,
		});
	});
	return rows.sort(
		(a, b) =>
			b.value - a.value ||
			a.country.localeCompare(b.country) ||
			a.plan.localeCompare(b.plan) ||
			a.channel.localeCompare(b.channel),
	);
}

/** The export file: one row per point, the value last. */
export function csvOf(metric: MetricId, firstColumn: string, points: readonly Point[]): string {
	const lines = [`${firstColumn},start,end,${metric}`];
	// Labels are dates, week and month keys and dimension names: none holds a comma or a quote.
	for (const point of points) lines.push(`${point.label},${point.start},${point.end},${point.value}`);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Alerts

/** Percent fall from one day to the next; negative when the value rose. */
export function dropPercent(previous: number, current: number): number {
	return previous > 0 ? ((previous - current) / previous) * 100 : 0;
}

/** Whether a rule on a daily series fires on a day, given that day's value and the day before's. */
export function ruleFires(condition: Condition, threshold: number, previous: number, current: number): boolean {
	switch (condition) {
		case "drop-pct":
			return previous > 0 && dropPercent(previous, current) > threshold;
		case "rise-pct":
			return previous > 0 && -dropPercent(previous, current) > threshold;
		case "below":
			return current < threshold;
		case "above":
			return current > threshold;
	}
}

export function describeCondition(condition: Condition, threshold: number): string {
	const label = CONDITIONS.find(entry => entry.id === condition)?.label ?? condition;
	return label.replace("X", String(threshold));
}

export function describeFilters(filters: Filters): string {
	const parts = DIMENSION_KEYS.filter(key => filters[key].length > 0).map(
		key => `${DIMENSIONS[key].title}: ${filters[key].map(id => labelOf(key, id)).join(", ")}`,
	);
	return parts.length > 0 ? parts.join(" · ") : "No filters";
}

// ---------------------------------------------------------------------------------------------
// Generation

interface PlanProfile {
	readonly signups: number;
	readonly users: number;
	/** Dollars per active user per day. */
	readonly arpu: number;
	readonly churn: number;
}

const PLAN_PROFILES: Readonly<Record<string, PlanProfile>> = {
	free: { signups: 1, users: 1, arpu: 0, churn: 0.6 },
	starter: { signups: 0.45, users: 0.55, arpu: 0.45, churn: 0.4 },
	pro: { signups: 0.28, users: 0.5, arpu: 1.2, churn: 0.25 },
	enterprise: { signups: 0.07, users: 0.25, arpu: 3.4, churn: 0.08 },
};

const COUNTRY_WEIGHTS = [1, 0.8, 0.62, 0.5, 0.4, 0.3];
const CHANNEL_WEIGHTS = [1, 0.85, 0.6, 0.45, 0.35, 0.22];
/** Monday first. */
const SIGNUP_WEEK = [1, 1.05, 1.05, 1, 0.9, 0.7, 0.65];
const USER_WEEK = [1, 1.02, 1.03, 1.01, 0.97, 0.74, 0.7];

export function generateAnalytics(rng: Seeded): AnalyticsWorld {
	const today = `${rng.pick([2024, 2025])}-${pad2(rng.pick([3, 6, 9, 12]))}-${pad2(rng.int(5, 25))}`;
	const start = addDays(today, -(DAY_COUNT - 1));
	const countryOrder = rng.shuffle(COUNTRY_WEIGHTS);
	const countryWeight = new Map(COUNTRIES.map((country, index) => [country.id, countryOrder[index] ?? 0]));
	const channelOrder = rng.shuffle(CHANNEL_WEIGHTS);
	const channelWeight = new Map(CHANNELS.map((channel, index) => [channel.id, channelOrder[index] ?? 0]));
	const segments: Segment[] = [];
	for (const country of COUNTRIES) {
		for (const plan of PLANS) {
			for (const channel of CHANNELS) segments.push({ country: country.id, plan: plan.id, channel: channel.id });
		}
	}
	const values: Record<MetricId, number[][]> = { signups: [], dau: [], revenue: [], churn: [] };
	const firstWeekday = weekday(start);
	const phase = rng.next() * Math.PI * 2;
	for (const segment of segments) {
		const profile = PLAN_PROFILES[segment.plan] as PlanProfile;
		const weight = (countryWeight.get(segment.country) ?? 0) * (channelWeight.get(segment.channel) ?? 0);
		const scale = weight * (0.8 + 0.4 * rng.next());
		const growth = 0.1 + 0.25 * rng.next();
		const signups: number[] = [];
		const users: number[] = [];
		const revenue: number[] = [];
		const churn: number[] = [];
		for (let day = 0; day < DAY_COUNT; day++) {
			const dow = (firstWeekday + day) % 7;
			const trend = (1 + (growth * day) / (DAY_COUNT - 1)) * (1 + 0.04 * Math.sin(phase + day / 7));
			signups.push(
				Math.round(12 * scale * profile.signups * trend * (SIGNUP_WEEK[dow] ?? 1) * (0.75 + 0.5 * rng.next())),
			);
			const active = Math.round(
				420 * scale * profile.users * trend * (USER_WEEK[dow] ?? 1) * (0.95 + 0.1 * rng.next()),
			);
			users.push(active);
			revenue.push(Math.round(active * profile.arpu * (0.9 + 0.2 * rng.next())));
			churn.push(Math.round(1.6 * scale * profile.churn * (0.3 + 1.4 * rng.next())));
		}
		values.signups.push(signups);
		values.dau.push(users);
		values.revenue.push(revenue);
		values.churn.push(churn);
	}
	const watched = rng.pick(COUNTRIES);
	return {
		start,
		today,
		segments,
		values,
		defaultView: { ...NO_FILTERS, from: addDays(today, -29), to: today, group: "day" },
		reports: [
			{
				...NO_FILTERS,
				id: "rpt-weekly-revenue",
				name: "Weekly revenue, all regions",
				metric: "revenue",
				from: addDays(today, -89),
				to: today,
				group: "week",
				seeded: true,
			},
			{
				...NO_FILTERS,
				id: "rpt-enterprise-signups",
				name: "Enterprise signups by month",
				metric: "signups",
				plans: ["enterprise"],
				from: start,
				to: today,
				group: "month",
				seeded: true,
			},
			{
				...NO_FILTERS,
				id: "rpt-churn-watch",
				name: `Churn watch: ${watched.label}`,
				metric: "churn",
				countries: [watched.id],
				from: addDays(today, -29),
				to: today,
				group: "day",
				seeded: true,
			},
		],
		alerts: [
			{
				...NO_FILTERS,
				id: "alr-revenue-floor",
				name: "Revenue floor",
				metric: "revenue",
				condition: "below",
				threshold: 20000,
				notify: "slack",
				recipient: "#revenue-watch",
				seeded: true,
			},
			{
				...NO_FILTERS,
				id: "alr-signup-surge",
				name: "Signup surge",
				metric: "signups",
				condition: "rise-pct",
				threshold: 80,
				notify: "email",
				recipient: "not-a-real-growth@metricly.test",
				seeded: true,
			},
		],
	};
}
