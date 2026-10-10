/**
 * Tasks performed against Metricly. Each plans its scenario on a freshly seeded world, bending the
 * metrics so the answer is unique and the tempting wrong answers exist, then grades what the server
 * recorded and the reply.
 */

import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerNamesOnly, answerStatesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	type AlertRule,
	type AnalyticsWorld,
	addDays,
	CHANNELS,
	COUNTRIES,
	DAY_COUNT,
	type Dimension,
	DIMENSION_KEYS,
	DIMENSIONS,
	type DimensionKey,
	dailyTotals,
	dateAt,
	dayIndex,
	dayNumber,
	dropPercent,
	type Filters,
	generateAnalytics,
	isoWeekLabel,
	labelOf,
	longDate,
	METRIC_BY_ID,
	METRICS,
	type MetricId,
	monthEnd,
	monthName,
	monthStart,
	NO_FILTERS,
	PLANS,
	type Point,
	presetsOf,
	quarterStart,
	ruleFires,
	type SavedReport,
	segmentsMatching,
	type View,
	weekday,
} from "./data";
import { type AnalyticsSnapshot, startAnalyticsSite } from "./site";

interface Expected<T> {
	readonly expected: T;
}

type AnalyticsState<T> = AnalyticsSnapshot & Expected<T>;

interface PointsResponse {
	readonly points: readonly Point[];
}

function createdReports(state: AnalyticsSnapshot): readonly SavedReport[] {
	return state.reports.filter(report => !report.seeded);
}

function createdAlerts(state: AnalyticsSnapshot): readonly AlertRule[] {
	return state.alerts.filter(alert => !alert.seeded);
}

/** Id lists the server keeps in the dimension's own order, compared as sets. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every(id => b.includes(id));
}

function sameFilters(a: Filters, b: Filters): boolean {
	return DIMENSION_KEYS.every(key => sameIds(a[key], b[key]));
}

function intro(origin: string, world: AnalyticsWorld): string {
	return `Metricly is a product analytics dashboard at ${origin}. Its data runs through ${longDate(world.today)}.`;
}

/** A dashboard query: the fields given, and each non-empty filter as its comma-separated parameter. */
function query(fields: Readonly<Record<string, string>>, filters: Partial<Filters> = {}): string {
	const params = new URLSearchParams(fields);
	for (const key of DIMENSION_KEYS) {
		const ids = filters[key] ?? [];
		if (ids.length > 0) params.set(DIMENSIONS[key].param, ids.join(","));
	}
	return params.toString();
}

async function getJson<T>(client: FormClient, path: string): Promise<T> {
	const response = await client.get(path);
	if (response.status !== 200) throw new Error(`GET ${path}: ${response.status} ${response.body}`);
	return JSON.parse(response.body) as T;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

const NOTHING_SAVED: Check<AnalyticsSnapshot> = {
	id: "nothing-saved",
	description: "saved no report and created no alert rule",
	pass: state => createdReports(state).length === 0 && createdAlerts(state).length === 0,
};

// ---------------------------------------------------------------------------------------------
// Bending the generated metrics

/** The metric summed over some segments on one day. */
function sliceValue(world: AnalyticsWorld, metric: MetricId, segments: readonly number[], day: number): number {
	let total = 0;
	for (const index of segments) total += world.values[metric][index]?.[day] ?? 0;
	return total;
}

/** Add `amount` to the metric on one day, spread over the segments at random. */
function addSpread(
	world: AnalyticsWorld,
	metric: MetricId,
	segments: readonly number[],
	day: number,
	amount: number,
	rng: Seeded,
): void {
	if (amount <= 0) return;
	const weights = segments.map(() => 0.5 + rng.next());
	const weightTotal = sum(weights);
	let left = amount;
	segments.forEach((index, position) => {
		const share =
			position === segments.length - 1
				? left
				: Math.min(left, Math.floor((amount * (weights[position] ?? 0)) / weightTotal));
		const row = world.values[metric][index];
		if (row) row[day] = (row[day] ?? 0) + share;
		left -= share;
	});
}

/** Multiply the metric on one day for some segments. */
function scaleSlice(world: AnalyticsWorld, metric: MetricId, segments: readonly number[], day: number, factor: number) {
	for (const index of segments) {
		const row = world.values[metric][index];
		if (row) row[day] = Math.round((row[day] ?? 0) * factor);
	}
}

// ---------------------------------------------------------------------------------------------
// analytics-peak-week

interface Week {
	readonly label: string;
	readonly monday: string;
}

function weekDays(week: Week): string[] {
	return Array.from({ length: 7 }, (_, offset) => addDays(week.monday, offset));
}

/** The ISO weeks whose seven days all fall inside the range. */
function fullWeeks(from: string, to: string): Week[] {
	const weeks: Week[] = [];
	for (let monday = addDays(from, (7 - weekday(from)) % 7); addDays(monday, 6) <= to; monday = addDays(monday, 7)) {
		weeks.push({ label: isoWeekLabel(monday), monday });
	}
	return weeks;
}

interface Quarter {
	readonly label: string;
	readonly from: string;
	readonly to: string;
}

function previousQuarter(today: string): Quarter {
	const to = addDays(quarterStart(today), -1);
	const from = quarterStart(to);
	return { label: `Q${(Number(from.slice(5, 7)) + 2) / 3} ${from.slice(0, 4)}`, from, to };
}

interface PeakWeek {
	readonly plan: string;
	readonly quarter: Quarter;
	readonly week: string;
	readonly count: number;
	/** Every week label a wrong reply might name. */
	readonly candidates: readonly string[];
	/** Every other week's signups, for the plan and for all plans: the counts a wrong reply might give. */
	readonly otherCounts: readonly number[];
}

function planPeakWeek(world: AnalyticsWorld, rng: Seeded): PeakWeek {
	const plan = rng.pick(["free", "starter", "pro"]);
	const quarter = previousQuarter(world.today);
	const weeks = fullWeeks(quarter.from, quarter.to);
	const planSegments = segmentsMatching(world, { plans: [plan] });
	const otherSegments = segmentsMatching(world, { plans: PLANS.map(entry => entry.id).filter(id => id !== plan) });
	const allSegments = segmentsMatching(world, {});
	const onDay = (segments: readonly number[], iso: string) =>
		sliceValue(world, "signups", segments, dayIndex(world, iso));
	const inWeek = (segments: readonly number[], week: Week) => sum(weekDays(week).map(iso => onDay(segments, iso)));
	const [target, crowd] = rng.sample(weeks.slice(1, -1), 2) as [Week, Week];

	// The target week: every day raised in proportion, to 18-26% above the plan's busiest week.
	const busiest = Math.max(...weeks.map(week => inWeek(planSegments, week)));
	const before = inWeek(planSegments, target);
	const raise = Math.round(busiest * (1.18 + rng.int(0, 8) / 100)) - before;
	for (const [iso, value] of weekDays(target).map(iso => [iso, onDay(planSegments, iso)] as const)) {
		addSpread(world, "signups", planSegments, dayIndex(world, iso), Math.round((raise * value) / before), rng);
	}

	// A quieter week holds the plan's busiest single day, so the daily chart points elsewhere.
	const quiet = weeks
		.filter(week => week !== target && week !== crowd)
		.reduce((low, week) => (inWeek(planSegments, week) < inWeek(planSegments, low) ? week : low));
	const targetPeak = Math.max(...weekDays(target).map(iso => onDay(planSegments, iso)));
	const spike = weekDays(quiet)[rng.int(1, 3)] as string;
	const spikeGoal = Math.round(targetPeak * (1.1 + rng.int(0, 8) / 100));
	addSpread(world, "signups", planSegments, dayIndex(world, spike), spikeGoal - onDay(planSegments, spike), rng);
	for (let guard = 0; inWeek(planSegments, quiet) >= 0.95 * inWeek(planSegments, target); guard++) {
		if (guard > 40) throw new Error("analytics-peak-week: the spiked week stays level with the target week");
		const low = weekDays(target).reduce((min, iso) =>
			onDay(planSegments, iso) < onDay(planSegments, min) ? iso : min,
		);
		const step = Math.max(1, Math.round(0.02 * inWeek(planSegments, target)));
		addSpread(world, "signups", planSegments, dayIndex(world, low), step, rng);
	}

	// The other plans crowd a third week, so it leads when no plan is chosen.
	const crowdLead = Math.max(...weeks.filter(week => week !== crowd).map(week => inWeek(allSegments, week)));
	const crowdExtra = Math.round(crowdLead * (1.06 + rng.int(0, 6) / 100)) - inWeek(allSegments, crowd);
	for (const iso of weekDays(crowd)) {
		addSpread(world, "signups", otherSegments, dayIndex(world, iso), Math.ceil(crowdExtra / 7), rng);
	}

	// The first full week after the quarter is busier still for the plan.
	const after = fullWeeks(addDays(quarter.to, 1), world.today)[0];
	if (after) {
		const goal = Math.round(inWeek(planSegments, target) * (1.08 + rng.int(0, 7) / 100));
		const lift = goal - inWeek(planSegments, after);
		for (const iso of weekDays(after)) {
			addSpread(world, "signups", planSegments, dayIndex(world, iso), Math.ceil(lift / 7), rng);
		}
	}

	const count = inWeek(planSegments, target);
	const byPlan = [...weeks].sort((a, b) => inWeek(planSegments, b) - inWeek(planSegments, a));
	const byAll = [...weeks].sort((a, b) => inWeek(allSegments, b) - inWeek(allSegments, a));
	const quarterDays = Array.from({ length: dayNumber(quarter.to) - dayNumber(quarter.from) + 1 }, (_, offset) =>
		addDays(quarter.from, offset),
	);
	const peakDay = quarterDays.reduce((max, iso) => (onDay(planSegments, iso) > onDay(planSegments, max) ? iso : max));
	if (
		byPlan[0] !== target ||
		inWeek(planSegments, byPlan[1] as Week) * 1.03 > count ||
		byAll[0] !== crowd ||
		weekDays(target).includes(peakDay) ||
		count === Number(target.label.slice(0, 4))
	) {
		throw new Error(`analytics-peak-week: the planned world does not single out ${target.label}`);
	}
	const candidates = new Set([...weeks.map(week => week.label), isoWeekLabel(quarter.from), isoWeekLabel(quarter.to)]);
	if (after) candidates.add(after.label);
	// A year the reply writes beside the week is a number too, so no decoy may equal one.
	const years = [Number(target.label.slice(0, 4)), Number(quarter.from.slice(0, 4))];
	const otherCounts = [...weeks, ...(after ? [after] : [])]
		.flatMap(week => [inWeek(planSegments, week), inWeek(allSegments, week)])
		.filter(value => value !== count && !years.includes(value));
	return { plan, quarter, week: target.label, count, candidates: [...candidates], otherCounts };
}

const peakWeek = kitTask<AnalyticsState<PeakWeek>>({
	id: "analytics-peak-week",
	title: "Find a plan's busiest ISO week of a quarter from a canvas chart",
	capabilities: ["canvas", "date-picker", "search-filter", "timing", "reading", "reasoning"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateAnalytics(rng);
		const plan = planPeakWeek(world, rng);
		world.defaultView = { ...world.defaultView, channels: [rng.pick(CHANNELS).id] };
		const site = await startAnalyticsSite(world, seed);
		const planLabel = labelOf("plans", plan.plan);
		const { quarter } = plan;
		return {
			instruction: [
				intro(site.origin, world),
				`For the ${planLabel} plan, find the ISO week (Monday to Sunday) with the most signups among the weeks that lie entirely inside ${quarter.label} (${longDate(quarter.from)} to ${longDate(quarter.to)}). Count signups from every country and every channel.`,
				"Do not save reports or create alert rules.",
				"Reply with the week written as YYYY-Www (for example 2019-W07) and that week's number of signups, and name no other week or count.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const series = await getJson<PointsResponse>(
					client,
					`/api/series?${query({ metric: "signups", from: quarter.from, to: quarter.to, group: "week" }, { plans: [plan.plan] })}`,
				);
				const best = series.points
					.filter(point => !point.partial)
					.reduce((top, point) => (point.value > top.value ? point : top));
				return `${best.label} had the most ${planLabel} signups: ${best.value.toLocaleString("en-US")}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "right-week",
			description: "the reply names the busiest full week of the quarter for the plan, and no other week",
			pass: (state, answer) => answerNamesOnly(answer, state.expected.week, state.expected.candidates),
		},
		{
			id: "right-count",
			description: "the reply states that week's exact number of signups, and no other week's",
			pass: (state, answer) => answerStatesOnly(answer, state.expected.count, state.expected.otherCounts, 0),
		},
		NOTHING_SAVED,
	],
});

// ---------------------------------------------------------------------------------------------
// analytics-save-report

interface SaveReport extends View {
	readonly name: string;
	readonly metric: MetricId;
	/** The two filtered dimensions, in the order the instruction names them. */
	readonly filtered: readonly DimensionKey[];
}

function planSaveReport(world: AnalyticsWorld, rng: Seeded): SaveReport {
	const metric = rng.pick(METRICS);
	const presets = presetsOf(world);
	const to = dateAt(world, rng.int(60, DAY_COUNT - 5));
	let from = addDays(to, -(rng.int(21, 56) - 1));
	while (presets.some(preset => preset.from === from && preset.to === to)) from = addDays(from, -1);
	const filtered = rng.sample(DIMENSION_KEYS, 2);
	const filters: Record<DimensionKey, string[]> = { countries: [], plans: [], channels: [] };
	for (const key of filtered) filters[key] = [rng.pick(DIMENSIONS[key].values).id];
	// The team's default view already filters to another country.
	const other = rng.pick(COUNTRIES.filter(country => !filters.countries.includes(country.id)));
	world.defaultView = { ...world.defaultView, countries: [other.id] };
	const segment = filtered.map(key => labelOf(key, filters[key][0] ?? "")).join(" ");
	const name = `${segment} weekly ${metric.label.toLowerCase()}`;
	return { name, metric: metric.id, from, to, group: "week", ...filters, filtered };
}

const saveReport = kitTask<AnalyticsState<SaveReport>>({
	id: "analytics-save-report",
	title: "Save a report with a custom range, two segment filters and weekly grouping",
	capabilities: ["date-picker", "forms", "overlays", "search-filter"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateAnalytics(rng);
		const plan = planSaveReport(world, rng);
		const site = await startAnalyticsSite(world, seed);
		const filterText = plan.filtered
			.map(key => `${DIMENSIONS[key].title} is ${labelOf(key, plan[key][0] ?? "")}`)
			.join(" and ");
		return {
			instruction: [
				intro(site.origin, world),
				"Create one saved report with exactly these settings:",
				`- Name: ${plan.name}`,
				`- Metric: ${METRIC_BY_ID[plan.metric].label}`,
				`- Date range: ${longDate(plan.from)} to ${longDate(plan.to)}`,
				"- Grouping: weekly",
				`- Filters: ${filterText}, and no other filter`,
				"Create only this one report.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const response = await client.postJson("/api/reports", {
					name: plan.name,
					metric: plan.metric,
					from: plan.from,
					to: plan.to,
					group: plan.group,
					countries: plan.countries,
					plans: plan.plans,
					channels: plan.channels,
				});
				if (response.status !== 200) throw new Error(`saving the report failed: ${response.body}`);
				return `Saved the report "${plan.name}".`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{ id: "one-report", description: "saved exactly one report", pass: state => createdReports(state).length === 1 },
		{
			id: "report-name-metric",
			description: "the report has the name and metric asked for",
			pass: state => {
				const [report] = createdReports(state);
				return (
					report !== undefined &&
					normalizeText(report.name) === normalizeText(state.expected.name) &&
					report.metric === state.expected.metric
				);
			},
		},
		{
			id: "report-range",
			description: "the report covers the custom date range asked for",
			pass: state => {
				const [report] = createdReports(state);
				return report?.from === state.expected.from && report.to === state.expected.to;
			},
		},
		{
			id: "report-weekly",
			description: "the report groups by week",
			pass: state => createdReports(state)[0]?.group === "week",
		},
		{
			id: "report-filters",
			description: "the report filters to the two segments asked for and nothing else",
			pass: state => {
				const [report] = createdReports(state);
				return report !== undefined && sameFilters(report, state.expected);
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// analytics-compare-channels

interface CompareChannels {
	readonly first: string;
	readonly second: string;
	readonly minimum: number;
	readonly channel: string;
	/** Percent, rounded to one decimal. */
	readonly growth: number;
	/** Every other channel's growth, rounded the same way: the figures a wrong reply might give. */
	readonly otherGrowths: readonly number[];
}

/** The calendar months, as `YYYY-MM`, whose every day has data. */
function fullMonths(world: AnalyticsWorld): string[] {
	const months: string[] = [];
	for (let month = monthStart(world.start); monthEnd(month) <= world.today; month = addDays(monthEnd(month), 1)) {
		if (month >= world.start) months.push(month.slice(0, 7));
	}
	return months;
}

function planCompareChannels(world: AnalyticsWorld, rng: Seeded): CompareChannels {
	const months = fullMonths(world);
	const firstIndex = rng.int(0, months.length - 2);
	const first = months[firstIndex] as string;
	const second = months[rng.int(firstIndex + 1, Math.min(months.length - 1, firstIndex + 3))] as string;
	const revenue = (channel: string, month: string) => {
		const from = `${month}-01`;
		return sum(dailyTotals(world, "revenue", { ...NO_FILTERS, channels: [channel] }, from, monthEnd(from)));
	};
	const base = new Map(CHANNELS.map(channel => [channel.id, revenue(channel.id, first)]));
	const baseOf = (id: string) => base.get(id) ?? 0;
	const ids = CHANNELS.map(channel => channel.id).sort((a, b) => baseOf(a) - baseOf(b));
	const excluded = ids.slice(0, rng.int(1, 2));
	const eligible = ids.slice(excluded.length);
	// The smallest channels grow fastest of all but earn too little in the first month to count.
	const decoy = excluded[excluded.length - 1] as string;
	const leader = eligible[eligible.length - 1] as string;
	const winner = rng.pick(eligible.slice(0, -1));
	const winnerGoal = rng.int(160, 320) / 10;
	const goalOf = (id: string): number => {
		if (id === winner) return winnerGoal;
		if (id === decoy) return winnerGoal + rng.int(60, 180) / 10;
		if (excluded.includes(id)) return rng.int(-120, 120) / 10;
		// The largest channel grows a little slower than the winner, so it gains the most dollars.
		return winnerGoal - (id === leader ? rng.int(15, 40) : rng.int(25, 220)) / 10;
	};
	const secondStart = dayIndex(world, `${second}-01`);
	const secondEnd = dayIndex(world, monthEnd(`${second}-01`));
	for (const id of ids) {
		const factor = (baseOf(id) * (1 + goalOf(id) / 100)) / revenue(id, second);
		const segments = segmentsMatching(world, { channels: [id] });
		for (let day = secondStart; day <= secondEnd; day++) scaleSlice(world, "revenue", segments, day, factor);
	}
	const growth = (id: string) => ((revenue(id, second) - baseOf(id)) / baseOf(id)) * 100;
	// Keep the winner's growth clear of a rounding edge at one decimal.
	const winnerSegments = segmentsMatching(world, { channels: [winner] });
	for (let guard = 0; Math.abs(((growth(winner) * 10) % 1) - 0.5) < 0.15; guard++) {
		if (guard > 400) throw new Error("analytics-compare-channels: the growth stays on a rounding edge");
		addSpread(world, "revenue", winnerSegments, secondStart, 4, rng);
	}
	const bestOther = Math.max(...eligible.filter(id => id !== winner).map(growth));
	const highestExcluded = Math.max(...excluded.map(baseOf));
	const lowestEligible = Math.min(...eligible.map(baseOf));
	if (growth(winner) < bestOther + 1 || growth(decoy) < growth(winner) + 3 || highestExcluded >= lowestEligible) {
		throw new Error(`analytics-compare-channels: the planned world does not single out ${winner}`);
	}
	const roundUp = (step: number) => Math.ceil((highestExcluded + 1) / step) * step;
	const minimum = [1000, 100].map(roundUp).find(value => value <= lowestEligible) ?? lowestEligible;
	return {
		first,
		second,
		minimum,
		channel: winner,
		growth: Math.round(growth(winner) * 10) / 10,
		otherGrowths: ids.filter(id => id !== winner).map(id => Math.round(growth(id) * 10) / 10),
	};
}

const compareChannels = kitTask<AnalyticsState<CompareChannels>>({
	id: "analytics-compare-channels",
	title: "Find the acquisition channel with the fastest revenue growth between two months",
	capabilities: ["canvas", "date-picker", "timing", "reading", "reasoning"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateAnalytics(rng);
		const plan = planCompareChannels(world, rng);
		world.defaultView = { ...world.defaultView, group: "week" };
		const site = await startAnalyticsSite(world, seed);
		const first = monthName(plan.first);
		const second = monthName(plan.second);
		return {
			instruction: [
				intro(site.origin, world),
				`Compare revenue by acquisition channel between ${first} and ${second}, across all countries and plans.`,
				`Among the channels that earned at least $${plan.minimum.toLocaleString("en-US")} in ${first}, which one had the largest percentage revenue growth from ${first} to ${second}?`,
				"Reply with the channel's name and its growth in percent, rounded to one decimal place, and name no other channel or growth.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const byChannel = async (month: string) =>
					(
						await getJson<PointsResponse>(
							client,
							`/api/breakdown?${query({ metric: "revenue", by: "channels", from: `${month}-01`, to: monthEnd(`${month}-01`), group: "month" })}`,
						)
					).points;
				const before = await byChannel(plan.first);
				const after = await byChannel(plan.second);
				const growths = before
					.filter(point => point.value >= plan.minimum)
					.map(point => {
						const later = after.find(entry => entry.key === point.key)?.value ?? 0;
						return { label: point.label, growth: ((later - point.value) / point.value) * 100 };
					});
				const best = growths.reduce((top, entry) => (entry.growth > top.growth ? entry : top));
				return `${best.label} grew revenue the most: ${best.growth.toFixed(1)}%.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "right-channel",
			description: "the reply names the qualifying channel with the largest percentage growth, and no other channel",
			pass: (state, answer) =>
				answerNamesOnly(
					answer,
					labelOf("channels", state.expected.channel),
					CHANNELS.map(channel => channel.label),
				),
		},
		{
			id: "right-growth",
			description: "the reply states that channel's growth to one decimal, and no other channel's",
			pass: (state, answer) => answerStatesOnly(answer, state.expected.growth, state.expected.otherGrowths, 0.001),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// analytics-anomaly-alert

interface AnomalyAlert {
	readonly country: string;
	readonly date: string;
	readonly name: string;
	readonly recipient: string;
	readonly lowest: number;
	readonly highest: number;
	/** The day before the 30-day window, then the window's days. */
	readonly dates: readonly string[];
	/** The country's active users on each of those days. */
	readonly values: readonly number[];
}

const THRESHOLD_LOWEST = 20;
const THRESHOLD_HIGHEST = 80;

function planAnomalyAlert(world: AnalyticsWorld, rng: Seeded): AnomalyAlert {
	const [country, other] = rng.sample(COUNTRIES, 2) as [Dimension, Dimension];
	const target = segmentsMatching(world, { countries: [country.id] });
	const elsewhere = segmentsMatching(world, { countries: [other.id] });
	const on = (segments: readonly number[], day: number) => sliceValue(world, "dau", segments, day);
	const dropOn = (segments: readonly number[], day: number) => dropPercent(on(segments, day - 1), on(segments, day));
	const setDrop = (segments: readonly number[], day: number, percent: number) =>
		scaleSlice(world, "dau", segments, day, (on(segments, day - 1) * (1 - percent / 100)) / on(segments, day));
	const midweek = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, offset) => from + offset).filter(day =>
			[1, 2, 3].includes(weekday(dateAt(world, day))),
		);
	const windowStart = DAY_COUNT - 30;
	const window = Array.from({ length: 30 }, (_, offset) => windowStart + offset);
	const candidates = midweek(windowStart + 3, DAY_COUNT - 3);
	const anomaly = rng.pick(candidates);
	const nearMiss = rng.pick(candidates.filter(day => Math.abs(day - anomaly) >= 3));
	const size = rng.int(440, 560) / 10;
	setDrop(target, anomaly, size);
	// A second, smaller drop in the same country bounds the threshold from below.
	setDrop(target, nearMiss, size - rng.int(60, 95) / 10);
	// Another country falls further inside the window, and this one fell further before it.
	setDrop(elsewhere, rng.pick(candidates.filter(day => day !== anomaly)), rng.int(600, 700) / 10);
	setDrop(target, rng.pick(midweek(DAY_COUNT - 60, windowStart - 5)), rng.int(600, 720) / 10);
	// The window's first day compares with a day outside it; keep that comparison unremarkable.
	const inner = Math.max(
		...window.filter(day => day !== anomaly && day !== windowStart).map(day => dropOn(target, day)),
	);
	if (dropOn(target, windowStart) > inner - 2) {
		const previousGoal = on(target, windowStart) / (1 - (inner - 4) / 100);
		scaleSlice(world, "dau", target, windowStart - 1, previousGoal / on(target, windowStart - 1));
	}
	const found = dropOn(target, anomaly);
	const runnerUp = Math.max(...window.filter(day => day !== anomaly).map(day => dropOn(target, day)));
	if (found - runnerUp < 4 || runnerUp < THRESHOLD_LOWEST + 1 || found > THRESHOLD_HIGHEST - 1) {
		throw new Error(`analytics-anomaly-alert: the planned drops do not leave room for a threshold`);
	}
	const days = [windowStart - 1, ...window];
	return {
		country: country.id,
		date: dateAt(world, anomaly),
		name: `${country.label} activity drop`,
		recipient: `not-a-real-${rng.pick(["oncall", "growth-team", "data-team"])}@metricly.test`,
		lowest: THRESHOLD_LOWEST,
		highest: THRESHOLD_HIGHEST,
		dates: days.map(day => dateAt(world, day)),
		values: days.map(day => on(target, day)),
	};
}

function onlyAlert(state: AnalyticsSnapshot): AlertRule | undefined {
	const alerts = createdAlerts(state);
	return alerts.length === 1 ? alerts[0] : undefined;
}

const anomalyAlert = kitTask<AnalyticsState<AnomalyAlert>>({
	id: "analytics-anomaly-alert",
	title: "Find a country's sharpest daily drop in active users and alert on exactly that day",
	capabilities: ["canvas", "date-picker", "search-filter", "timing", "reasoning", "forms", "overlays", "multi-page"],
	difficulty: "hard",
	timeBudgetSec: 780,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateAnalytics(rng);
		const plan = planAnomalyAlert(world, rng);
		world.defaultView = { ...NO_FILTERS, from: addDays(world.today, -89), to: world.today, group: "week" };
		const site = await startAnalyticsSite(world, seed);
		const country = labelOf("countries", plan.country);
		return {
			instruction: [
				intro(site.origin, world),
				`Look at daily active users in ${country} over the last 30 days (${longDate(plan.dates[1] ?? "")} to ${longDate(world.today)}), counting every plan and channel.`,
				"Find the day on which active users fell the most, in percent, compared with the day before.",
				`Then create one alert rule named "${plan.name}" on active users in ${country} only (no other filter), with the condition "drops by more than X% vs the prior day", notifying by email to ${plan.recipient}.`,
				`Choose a whole-number X from ${plan.lowest} to ${plan.highest} such that the rule would have fired on that day and on no other day of those 30 days.`,
				"Reply with the date of that day as YYYY-MM-DD, and name no other day.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const series = await getJson<PointsResponse>(
					client,
					`/api/series?${query({ metric: "dau", from: plan.dates[0] ?? "", to: world.today, group: "day" }, { countries: [plan.country] })}`,
				);
				const drops = series.points
					.slice(1)
					.map((point, index) => ({
						date: point.label,
						drop: dropPercent(series.points[index]?.value ?? 0, point.value),
					}))
					.sort((a, b) => b.drop - a.drop);
				const [top, next] = drops;
				if (!top || !next) throw new Error("the active-users series is too short");
				const response = await client.postJson("/api/alerts", {
					name: plan.name,
					metric: "dau",
					condition: "drop-pct",
					threshold: String(Math.floor((top.drop + next.drop) / 2)),
					countries: [plan.country],
					plans: [],
					channels: [],
					notify: "email",
					recipient: plan.recipient,
				});
				if (response.status !== 200) throw new Error(`creating the alert failed: ${response.body}`);
				return `Active users fell the most on ${top.date}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "answer-date",
			description: "the reply names the day of the sharpest drop, and no other day of the window",
			pass: (state, answer) => answerNamesOnly(answer, state.expected.date, state.expected.dates),
		},
		{
			id: "one-alert",
			description: "created exactly one alert rule",
			pass: state => createdAlerts(state).length === 1,
		},
		{
			id: "alert-settings",
			description:
				"the rule watches active users in the country only for a whole-number percent drop within the bounds, and emails the address given",
			pass: state => {
				const alert = onlyAlert(state);
				const { expected } = state;
				return (
					alert !== undefined &&
					normalizeText(alert.name) === normalizeText(expected.name) &&
					alert.metric === "dau" &&
					alert.condition === "drop-pct" &&
					Number.isInteger(alert.threshold) &&
					alert.threshold >= expected.lowest &&
					alert.threshold <= expected.highest &&
					sameFilters(alert, { ...NO_FILTERS, countries: [expected.country] }) &&
					alert.notify === "email" &&
					normalizeText(alert.recipient) === normalizeText(expected.recipient)
				);
			},
		},
		{
			id: "fires-only-that-day",
			description: "over the 30 days the rule would have fired on the day of the drop and on no other day",
			pass: state => {
				const alert = onlyAlert(state);
				const { expected } = state;
				const onlyCountry = { ...NO_FILTERS, countries: [expected.country] };
				if (!alert || alert.metric !== "dau" || !sameFilters(alert, onlyCountry)) return false;
				const values = expected.values;
				const fired = expected.dates
					.slice(1)
					.filter((_, index) =>
						ruleFires(alert.condition, alert.threshold, values[index] ?? 0, values[index + 1] ?? 0),
					);
				return fired.length === 1 && fired[0] === expected.date;
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// analytics-export-segment

interface ExportSegment extends Filters {
	readonly preset: string;
	readonly step: number;
	readonly from: string;
	readonly to: string;
	readonly total: number;
	/** The totals of the tempting wrong exports: the preset's own range, and the default view's extra filter kept. */
	readonly decoyTotals: readonly number[];
	/** The two filtered dimensions, in the order the instruction names them. */
	readonly filtered: readonly DimensionKey[];
}

const SHIFTABLE_PRESETS = ["last-30", "last-90", "last-month", "last-quarter"];

function planExportSegment(world: AnalyticsWorld, rng: Seeded): ExportSegment {
	const options: { preset: string; from: string; to: string; step: number }[] = [];
	for (const preset of presetsOf(world).filter(entry => SHIFTABLE_PRESETS.includes(entry.id))) {
		for (const step of [-7, 7]) {
			const from = addDays(preset.from, step);
			const to = addDays(preset.to, step);
			if (from >= world.start && to <= world.today) options.push({ preset: preset.label, from, to, step });
		}
	}
	// Free accounts earn nothing, so a revenue filter never picks the free plan.
	const pickId = (key: DimensionKey) =>
		rng.pick(DIMENSIONS[key].values.filter(value => key !== "plans" || value.id !== "free")).id;
	const revenue = (chosen: Filters, from: string, to: string) => sum(dailyTotals(world, "revenue", chosen, from, to));
	// A small segment can earn the same over the shifted and the unshifted range, so draw again until
	// the total stands apart from both decoys.
	for (let attempt = 0; attempt < 100; attempt++) {
		const choice = rng.pick(options);
		const filtered = rng.sample(DIMENSION_KEYS, 2);
		const filters: Record<DimensionKey, string[]> = { countries: [], plans: [], channels: [] };
		for (const key of filtered) filters[key] = [pickId(key)];
		// The team's default view filters the third dimension, which the export must not keep.
		const third = DIMENSION_KEYS.find(key => !filtered.includes(key)) as DimensionKey;
		const stray = pickId(third);
		const total = revenue(filters, choice.from, choice.to);
		const unshifted = revenue(filters, addDays(choice.from, -choice.step), addDays(choice.to, -choice.step));
		const withStray = revenue({ ...filters, [third]: [stray] }, choice.from, choice.to);
		if (total === 0 || total === unshifted || total === withStray) continue;
		world.defaultView = { ...world.defaultView, [third]: [stray] };
		// A year the reply writes beside the range is a number too, so no decoy may equal one.
		const years = [Number(choice.from.slice(0, 4)), Number(choice.to.slice(0, 4))];
		const decoyTotals = [unshifted, withStray].filter(value => !years.includes(value));
		return {
			preset: choice.preset,
			step: choice.step,
			from: choice.from,
			to: choice.to,
			total,
			decoyTotals,
			...filters,
			filtered,
		};
	}
	throw new Error("analytics-export-segment: no export total stands apart from its decoys");
}

const exportSegment = kitTask<AnalyticsState<ExportSegment>>({
	id: "analytics-export-segment",
	title: "Export weekly revenue for a two-filter segment over a shifted preset range and total it",
	capabilities: ["downloads", "date-picker", "search-filter", "timing", "reasoning"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateAnalytics(rng);
		const plan = planExportSegment(world, rng);
		const site = await startAnalyticsSite(world, seed);
		const segment = plan.filtered
			.map(key => `${DIMENSIONS[key].title.toLowerCase()} ${labelOf(key, plan[key][0] ?? "")}`)
			.join(" and ");
		const direction = plan.step < 0 ? "earlier" : "later";
		return {
			instruction: [
				intro(site.origin, world),
				`Export the Revenue chart as a CSV file, grouped by week and filtered to ${segment} with no other filter, over the date range of the "${plan.preset}" preset shifted one week ${direction} (its start and its end both moved ${plan.step < 0 ? "back" : "forward"} 7 days).`,
				"Reply with the total revenue across all rows of the exported file, in whole dollars, and state no other total.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const csv = await client.get(
					`/export.csv?${query({ widget: "revenue", from: plan.from, to: plan.to, group: "week" }, plan)}`,
				);
				if (csv.status !== 200) throw new Error(`the export failed: ${csv.body}`);
				const rows = csv.body.trim().split("\n").slice(1);
				const total = sum(rows.map(row => Number(row.split(",").at(-1))));
				return `The exported rows total $${total.toLocaleString("en-US")}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "exported-exact",
			description: "exported the weekly Revenue chart over the shifted range with exactly the two filters",
			pass: state =>
				state.exports.some(
					entry =>
						entry.widget === "revenue" &&
						entry.by === null &&
						entry.group === "week" &&
						entry.from === state.expected.from &&
						entry.to === state.expected.to &&
						sameFilters(entry, state.expected),
				),
		},
		{
			id: "answer-total",
			description: "the reply states the exact total of the exported rows, and no decoy export's total",
			pass: (state, answer) => answerStatesOnly(answer, state.expected.total, state.expected.decoyTotals, 0),
		},
	],
});

export const ANALYTICS_TASKS: readonly KitTask[] = [peakWeek, saveReport, compareChannels, anomalyAlert, exportSegment];
