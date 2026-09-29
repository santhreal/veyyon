/**
 * WHY: a task that grades a reply plants tempting wrong answers beside the right one. An answer
 * check that only asks whether the right answer appears somewhere passes a reply that hedges ("C, or
 * maybe D", "$245.00, or $260.00 for the other flight") or names a decoy beside it, and one that
 * matches a name as a substring passes a reply that never names it: "West leads, at least on this
 * data" held East. These checks defended nothing of the kind: `sheet-sort-and-answer`'s third row,
 * `sheet-cross-sheet-summary`'s best region, `travel-earliest-arrival`'s landing flight, the booking
 * reference of `travel-cheapest-nonstop` and `travel-multi-passenger-book`, the amount paid in
 * `travel-change-date-min-cost`, the count of `helpdesk-triage-queue`, the per-priority counts of
 * `helpdesk-escalation-report` ("Urgent: 2 or 3"), and the week's count, the growth and the export
 * total of `analytics-peak-week`, `analytics-compare-channels` and `analytics-export-segment`.
 *
 * For each of those checks, over several seeds, the correct reply passes, and the correct reply with
 * one decoy added fails. The decoys are read from the running site or from the state it recorded,
 * never from what the planner stored for the check: every other product, region, flight and trip,
 * what changing to each other flight costs, the counts of the queues beside the triage queue, the
 * Reports page's calendar-hour counts, and the figures of the other weeks, channels and exports. A
 * region held only inside a longer word fails too, and the escalation counts pass and fail the same
 * way written one per line or all on one line.
 *
 * Not caught: an answer check added later that is not exclusive; each is listed here by hand.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import type { KitTask, KitTrial } from "../../../engine/kit/catalog";
import { numbersIn } from "../../../engine/kit/checks";
import { FormClient } from "../../../engine/kit/form-client";
import { trialSeed } from "../../../engine/kit/suite";
import {
	addDays,
	DIMENSION_KEYS,
	DIMENSIONS,
	type DimensionKey,
	monthEnd,
	PLANS,
	type Point,
} from "../../../suites/browser/apps/analytics/data";
import { AIRPORTS } from "../../../suites/browser/apps/travel/data";
import { BROWSER_TASKS } from "../../../suites/browser/main";

const REPEATS = [0, 1, 2, 3];

const MONTHS = [
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

/** A word that holds a region's name without naming the region. */
const HOLDING_WORD: Readonly<Record<string, string>> = {
	East: "at least",
	West: "Westfield",
	North: "Northgate",
	South: "Southampton",
	Central: "decentralized",
};

interface AnswerCase {
	readonly task: string;
	/** The answer checks the case covers: the correct reply passes every one. */
	readonly checks: readonly string[];
	/** What the case reads from the running site before the task is solved. */
	readonly observe?: (trial: KitTrial<unknown>) => Promise<unknown>;
	/** Replies adding a decoy to the correct one, each with the check it must fail. */
	readonly wrong: (state: unknown, correct: string, observed: unknown) => readonly Failing[];
	/** Other ways to write the correct reply, each passing every check. */
	readonly right?: (correct: string) => readonly string[];
}

interface Failing {
	readonly reply: string;
	readonly check: string;
}

function failing(check: string, replies: readonly string[]): Failing[] {
	return replies.map(reply => ({ reply, check }));
}

interface Recorded {
	readonly expected: Record<string, unknown>;
	readonly bookings?: readonly { readonly ref: string; readonly seeded: boolean }[];
	readonly baseline?: {
		readonly tickets: readonly { readonly status: string; readonly assigneeId: string | null }[];
	};
}

function originOf(instruction: string): string {
	const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(instruction)?.[0];
	if (!origin) throw new Error(`the instruction names no site: ${instruction}`);
	return origin;
}

function matched(pattern: RegExp, text: string): string[] {
	const match = pattern.exec(text);
	if (!match) throw new Error(`"${text}" does not match ${pattern}`);
	return match.slice(1).map(group => group ?? "");
}

function monthNumber(name: string): string {
	return String(MONTHS.indexOf(name) + 1).padStart(2, "0");
}

async function getJson<T>(client: FormClient, path: string): Promise<T> {
	const response = await client.get(path);
	if (response.status !== 200) throw new Error(`GET ${path}: ${response.status} ${response.body}`);
	return JSON.parse(response.body) as T;
}

/** A figure added to the correct reply, unless the reply already holds it as another figure. */
function withFigures(correct: string, figures: readonly number[], phrase: (figure: number) => string): string[] {
	const stated = numbersIn(correct);
	return [...new Set(figures)]
		.filter(figure => !stated.includes(figure))
		.map(figure => `${correct} ${phrase(figure)}`);
}

/** Every way to fly the instruction's route on its date, as Skyway's search lists them. */
async function dayItineraries(trial: KitTrial<unknown>): Promise<{ segments: { flightNo: string }[] }[]> {
	const [from, to, day, month, year] = matched(
		/fly from (.+?) to (.+?) departing on \w+ (\d+) (\w+) (\d{4}),/,
		trial.instruction,
	);
	const code = (city: string) => AIRPORTS.find(airport => airport.city === city)?.code ?? city;
	const client = new FormClient(originOf(trial.instruction));
	const items: { segments: { flightNo: string }[] }[] = [];
	for (;;) {
		const query = new URLSearchParams({
			from: code(from as string),
			to: code(to as string),
			date: `${year}-${monthNumber(month as string)}-${(day as string).padStart(2, "0")}`,
			limit: "20",
			offset: String(items.length),
		});
		const page = await getJson<{ total: number; items: typeof items }>(client, `/api/search?${query}`);
		items.push(...page.items);
		if (page.items.length === 0 || items.length >= page.total) return items;
	}
}

/** What changing the booking's return to each flight of the new date costs, from each review page. */
async function changeTotals(trial: KitTrial<unknown>): Promise<number[]> {
	const [email, password] = matched(/Sign in with email (\S+) and password (\S+?)\.(?:\s|$)/, trial.instruction);
	const [ref] = matched(/Your booking ([A-Z0-9]{6})/, trial.instruction);
	const [day, month, year] = matched(/Move its return flight to \w+ (\d+) (\w+) (\d{4})\./, trial.instruction);
	const client = new FormClient(originOf(trial.instruction));
	await client.post("/signin", { email: email as string, password: password as string, next: "/trips" });
	const date = `${year}-${monthNumber(month as string)}-${(day as string).padStart(2, "0")}`;
	const list = await client.get(`/trips/${ref}/change?leg=1&date=${date}`);
	const totals: number[] = [];
	for (const link of list.body.matchAll(/href="(\/trips\/[A-Z0-9]{6}\/change\/review\?[^"]+)"/g)) {
		const review = await client.get((link[1] as string).replaceAll("&amp;", "&"));
		totals.push(Number(matched(/Total to pay<\/th><th>\$(\d+\.\d{2})</, review.body)[0]));
	}
	return totals;
}

/** An analytics long date, `February 11, 2025`, as `2025-02-11`. */
function analyticsDate(text: string): string {
	const [month, day, year] = matched(/^(\w+) (\d+), (\d{4})$/, text);
	return `${year}-${monthNumber(month as string)}-${(day as string).padStart(2, "0")}`;
}

/** Every full week's signups in the quarter, for the plan and for every plan. */
async function weekCounts(trial: KitTrial<unknown>): Promise<number[]> {
	const [label, from, to] = matched(
		/For the (\w+) plan, .*?\((\w+ \d+, \d{4}) to (\w+ \d+, \d{4})\)/,
		trial.instruction,
	);
	const plan = PLANS.find(entry => entry.label === label)?.id ?? "";
	const client = new FormClient(originOf(trial.instruction));
	const range = {
		metric: "signups",
		from: analyticsDate(from as string),
		to: analyticsDate(to as string),
		group: "week",
	};
	const counts: number[] = [];
	const filters: readonly Record<string, string>[] = [{ plan }, {}];
	for (const filter of filters) {
		const query = new URLSearchParams({ ...range, ...filter });
		const series = await getJson<{ points: Point[] }>(client, `/api/series?${query}`);
		counts.push(...series.points.filter(point => !point.partial).map(point => point.value));
	}
	return counts;
}

/** Every channel's revenue growth between the instruction's two months, to one decimal. */
async function channelGrowths(trial: KitTrial<unknown>): Promise<number[]> {
	const months = matched(/between (\w+) (\d{4}) and (\w+) (\d{4})/, trial.instruction);
	const client = new FormClient(originOf(trial.instruction));
	const revenue = async (month: string, year: string) => {
		const from = `${year}-${monthNumber(month)}-01`;
		const query = new URLSearchParams({
			metric: "revenue",
			by: "channels",
			from,
			to: monthEnd(from),
			group: "month",
		});
		return (await getJson<{ points: Point[] }>(client, `/api/breakdown?${query}`)).points;
	};
	const before = await revenue(months[0] as string, months[1] as string);
	const after = await revenue(months[2] as string, months[3] as string);
	return before.map(point => {
		const later = after.find(entry => entry.key === point.key)?.value ?? 0;
		return Math.round(((later - point.value) / point.value) * 1000) / 10;
	});
}

/** The totals of the tempting wrong exports: the preset's own range, and the default view's filter kept. */
async function decoyExportTotals(trial: KitTrial<unknown>): Promise<number[]> {
	const [segment, preset, direction] = matched(
		/filtered to (.+?) with no other filter, over the date range of the "(.+?)" preset shifted one week (\w+)/,
		trial.instruction,
	);
	const client = new FormClient(originOf(trial.instruction));
	const boot = JSON.parse(
		matched(/window\.__METRICLY__ = (\{.*?\});\n/, (await client.get("/")).body)[0] as string,
	) as {
		view: Record<string, string[]>;
		presets: { label: string; from: string; to: string }[];
	};
	const range = boot.presets.find(entry => entry.label === preset);
	if (!range) throw new Error(`no preset "${preset}"`);
	const filters: Record<string, string> = {};
	const unfiltered: DimensionKey[] = [];
	for (const key of DIMENSION_KEYS) {
		const value = DIMENSIONS[key].values.find(entry =>
			segment?.includes(`${DIMENSIONS[key].title.toLowerCase()} ${entry.label}`),
		);
		if (value) filters[DIMENSIONS[key].param] = value.id;
		else unfiltered.push(key);
	}
	const [third] = unfiltered;
	if (!third || unfiltered.length !== 1) throw new Error(`"${segment}" does not name two filters`);
	const step = direction === "earlier" ? -7 : 7;
	const total = async (query: Record<string, string>) => {
		const series = await getJson<{ points: Point[] }>(
			client,
			`/api/series?${new URLSearchParams({ metric: "revenue", group: "week", ...query })}`,
		);
		return series.points.reduce((sum, point) => sum + point.value, 0);
	};
	const stray = { [DIMENSIONS[third].param]: (boot.view[third] ?? []).join(",") };
	return [
		await total({ ...filters, from: range.from, to: range.to }),
		await total({ ...filters, ...stray, from: addDays(range.from, step), to: addDays(range.to, step) }),
	];
}

/** The Reports page's beta counts of last month's breaches in calendar hours, by priority label. */
async function calendarCounts(trial: KitTrial<unknown>): Promise<Record<string, number>> {
	const [email, password] = matched(/Sign in with email (\S+) and password (\S+?)\.(?:\s|$)/, trial.instruction);
	const client = new FormClient(originOf(trial.instruction));
	await client.post("/signin", { email: email as string, password: password as string, next: "/reports" });
	const page = await client.get("/reports");
	const counts: Record<string, number> = {};
	for (const row of page.body.matchAll(/<tr><td>(Urgent|High|Normal|Low)<\/td><td>(\d+)<\/td><\/tr>/g)) {
		counts[row[1] as string] = Number(row[2]);
	}
	return counts;
}

const CASES: readonly AnswerCase[] = [
	{
		task: "sheet-sort-and-answer",
		checks: ["answer-third"],
		wrong: (raw, correct) => {
			const expected = (raw as Recorded).expected as { rows: string[][]; third: string };
			const others = expected.rows.map(row => row[1] as string).filter(product => product !== expected.third);
			return failing(
				"answer-third",
				others.map(product => `${correct} Or perhaps ${product}.`),
			);
		},
	},
	{
		task: "sheet-cross-sheet-summary",
		checks: ["answer-best-average"],
		wrong: (raw, correct) => {
			const expected = (raw as Recorded).expected as { regions: { region: string }[]; best: string };
			const others = expected.regions.map(entry => entry.region).filter(region => region !== expected.best);
			return failing("answer-best-average", [
				...others.map(region => `${correct} ${region} comes close.`),
				`I could not tell which region leads; see the ${HOLDING_WORD[expected.best]} figures.`,
			]);
		},
	},
	{
		task: "travel-earliest-arrival",
		checks: ["answer-flight"],
		observe: dayItineraries,
		wrong: (raw, correct, observed) => {
			const expected = (raw as Recorded).expected as { flightNo: string };
			const others = (observed as { segments: { flightNo: string }[] }[])
				.filter(item => item.segments.at(-1)?.flightNo !== expected.flightNo)
				.flatMap(item => item.segments.map(segment => segment.flightNo));
			return failing(
				"answer-flight",
				others.map(flightNo => `${correct} ${flightNo} lands earlier but does not count.`),
			);
		},
	},
	...["travel-cheapest-nonstop", "travel-multi-passenger-book"].map(
		(task): AnswerCase => ({
			task,
			checks: ["answer-reference"],
			wrong: (raw, correct) =>
				failing(
					"answer-reference",
					((raw as Recorded).bookings ?? [])
						.filter(booking => booking.seeded)
						.map(booking => `${correct} Your other trip is ${booking.ref}.`),
				),
		}),
	),
	{
		task: "travel-change-date-min-cost",
		checks: ["answer-amount"],
		observe: changeTotals,
		wrong: (_raw, correct, observed) =>
			failing(
				"answer-amount",
				withFigures(correct, observed as number[], total => `Another flight would have cost $${total.toFixed(2)}.`),
			),
	},
	{
		task: "helpdesk-triage-queue",
		checks: ["answer-count"],
		wrong: (raw, correct) => {
			const tickets = (raw as Recorded).baseline?.tickets ?? [];
			const unsolved = tickets.filter(ticket => ticket.status === "open" || ticket.status === "pending");
			const counts = [
				tickets.filter(ticket => ticket.status === "open").length,
				unsolved.length,
				unsolved.filter(ticket => ticket.assigneeId === null).length,
			];
			return failing(
				"answer-count",
				withFigures(correct, counts, count => `The queue view showed ${count}.`),
			);
		},
	},
	{
		task: "helpdesk-escalation-report",
		checks: ["answer-urgent", "answer-high", "answer-normal", "answer-low"],
		observe: calendarCounts,
		// The instruction's own form puts all four priorities on one line.
		right: correct => [correct.replaceAll("\n", ", ")],
		wrong: (_raw, correct, observed) => {
			const calendar = observed as Record<string, number>;
			const lines = correct.split("\n");
			return lines.flatMap((line, index) => {
				const [label = "", count = ""] = line.split(": ");
				const decoy = calendar[label];
				if (decoy === undefined || String(decoy) === count) return [];
				const hedged = lines.map((other, at) => (at === index ? `${line} or ${decoy}` : other));
				return [
					{ reply: hedged.join("\n"), check: `answer-${label.toLowerCase()}` },
					{ reply: hedged.join(", "), check: `answer-${label.toLowerCase()}` },
				];
			});
		},
	},
	{
		task: "analytics-peak-week",
		checks: ["right-count"],
		observe: weekCounts,
		wrong: (_raw, correct, observed) =>
			failing(
				"right-count",
				withFigures(correct, observed as number[], count => `Another week had ${count.toLocaleString("en-US")}.`),
			),
	},
	{
		task: "analytics-compare-channels",
		checks: ["right-growth"],
		observe: channelGrowths,
		wrong: (_raw, correct, observed) =>
			failing(
				"right-growth",
				withFigures(correct, observed as number[], growth => `Another channel grew ${growth.toFixed(1)}%.`),
			),
	},
	{
		task: "analytics-export-segment",
		checks: ["answer-total"],
		observe: decoyExportTotals,
		wrong: (_raw, correct, observed) =>
			failing(
				"answer-total",
				withFigures(
					correct,
					observed as number[],
					total => `Another export totals $${total.toLocaleString("en-US")}.`,
				),
			),
	},
];

function taskById(id: string): KitTask {
	const task = BROWSER_TASKS.find(entry => entry.id === id);
	if (!task) throw new Error(`no task ${id}`);
	return task;
}

describe("a reply that hedges or names a decoy", () => {
	for (const entry of CASES) {
		for (const repeat of REPEATS) {
			it(`fails ${entry.task}'s ${entry.checks.join(", ")}, seed of repeat ${repeat}`, async () => {
				const task = taskById(entry.task);
				await using dir = await TempDir.create("@evals-answer-decoys-");
				const trial = await task.start({
					seed: trialSeed({ task: task.id, repeat }),
					workspace: dir.path(),
					trialDir: dir.path(),
				});
				let correct = "";
				let observed: unknown = null;
				let failure: unknown = null;
				try {
					observed = entry.observe ? await entry.observe(trial) : null;
					correct = await trial.solve();
				} catch (error) {
					failure = error;
				}
				// Stopped whether or not the solution threw, so a failing case leaves no server behind.
				const state: unknown = JSON.parse(JSON.stringify(await trial.finish()));
				if (failure !== null) throw failure;
				const passes = (answer: string, check: string) =>
					task.grade(state, answer).outcomes.find(outcome => outcome.id === check)?.passed;
				const rights = [correct, ...(entry.right?.(correct) ?? [])];
				expect(
					rights.flatMap(reply =>
						entry.checks.filter(check => passes(reply, check) !== true).map(check => `${check}: ${reply}`),
					),
				).toEqual([]);
				const wrong = entry.wrong(state, correct, observed);
				expect(wrong.length).toBeGreaterThan(0);
				expect(wrong.filter(({ reply, check }) => passes(reply, check) !== false)).toEqual([]);
			});
		}
	}
});
