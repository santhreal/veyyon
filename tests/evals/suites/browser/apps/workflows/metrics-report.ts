/**
 * workflow-metrics-report: one signups report carried across three applications. Metricly holds the
 * weekly signups, drawn on canvas; a Gridwork workbook holds the report's table, whose Total
 * formulas add up what is typed into it; Parcel Mail holds who leads the team the total goes to.
 *
 * Each application's world is generated from its own stream of the trial seed and then bent: the
 * dashboard moves by whole weeks so its days end just before the mailbox's today, its default view
 * filters to a segment one dimension away from the report's, and the report's segments gain signups
 * until every weekly figure differs from what the default view or a neighbouring week gives and the
 * grand total differs from every other total a wrong step produces. The mailbox gains the team's
 * former lead, who asked for the report and received the last one, a message naming the new lead,
 * and a contact with the new lead's first name and a surname that starts alike. A draw that cannot
 * be bent is drawn again.
 */

import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerStatesOnly } from "../../../../engine/kit/checks";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	type AnalyticsWorld,
	addDays,
	CHANNELS,
	COUNTRIES,
	dailyTotals,
	dayIndex,
	dayNumber,
	generateAnalytics,
	labelOf,
	longDate,
	NO_FILTERS,
	PLANS,
	segmentsMatching,
	shortDate,
	weekday,
} from "../analytics/data";
import { type AnalyticsSnapshot, startAnalyticsSite } from "../analytics/site";
import {
	addContact,
	addMessage,
	dateBetween,
	firstName,
	fullDate,
	generateMail,
	type MailWorld,
	type Person,
	TODAY,
	timeOn,
} from "../mail/data";
import { type MailSnapshot, startMailSite } from "../mail/site";
import { type GridWorld, newWorkbook, sheetFrom, worldOf } from "../sheet/data";
import { cellName, columnLetter } from "../sheet/formula";
import { type GridSnapshot, type SheetState, startSheetSite } from "../sheet/site";

/** Every workbook's raw inputs, by workbook id, then sheet name, then address. */
type Inputs = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;

interface Expected {
	readonly book: string;
	readonly sheet: string;
	readonly before: Inputs;
	/** Each weekly cell of the table and the signups it must hold. */
	readonly cells: Readonly<Record<string, number>>;
	/** Per weekly cell, what the dashboard's default filters give for it, alone and with the named filters added. */
	readonly defaultFigures: Readonly<Record<string, readonly number[]>>;
	/** Per weekly cell, its plan's signups in the week before and in the week after. */
	readonly neighbourFigures: Readonly<Record<string, readonly number[]>>;
	/** Each Total cell and the formula it starts with. */
	readonly formulas: Readonly<Record<string, string>>;
	readonly grandTotal: number;
	/**
	 * The totals a wrong step gives or a trial shows beside the grand total: the default view's, the
	 * table shifted a week either way, with the unlisted plan, last period's, and the table's row and
	 * column totals. A figure a date writes (a day of the month, a year) is left out.
	 */
	readonly otherTotals: readonly number[];
	readonly lead: string;
	/** The team's former lead and the lead's look-alike contact. */
	readonly decoyRecipients: readonly string[];
}

interface MetricsReportState {
	readonly analytics: AnalyticsSnapshot;
	readonly sheet: GridSnapshot;
	readonly mail: MailSnapshot;
	readonly expected: Expected;
}

const TABLE_WEEKS = 4;
const BOOK_NAME = "Signups by plan";
const SHEET_NAME = "Report";
const TEAMS = ["Growth", "Acquisition", "Activation", "Lifecycle", "Monetization"];
/** A first name the lead and the look-alike share; no background contact has it. */
const SHARED_FIRST = ["Dana", "Sam", "Alex", "Jamie", "Kai", "Robin"];
/** Surnames that start alike; no background contact has either. */
const LOOKALIKE_SURNAMES: readonly (readonly [string, string])[] = [
	["Whitfield", "Whitman"],
	["Castellano", "Castleton"],
	["Novak", "Novotny"],
	["Lindqvist", "Lindgren"],
	["Hartley", "Hartman"],
	["Ashford", "Ashby"],
];
/** Per plan, the most signups a day of the report's segments gains, so neighbouring weeks spread apart. */
const JITTER: Readonly<Record<string, number>> = { free: 5, starter: 3, pro: 2, enterprise: 2 };
const MAX_DRAWS = 20;
const MAX_BENDS = 400;

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

// ---------------------------------------------------------------------------------------------
// Metricly

/** The Mondays of the weeks whose seven days all fall inside the range. */
function fullWeekMondays(from: string, to: string): string[] {
	const mondays: string[] = [];
	for (let monday = addDays(from, (7 - weekday(from)) % 7); addDays(monday, 6) <= to; monday = addDays(monday, 7)) {
		mondays.push(monday);
	}
	return mondays;
}

/**
 * The dashboard moved by whole weeks, keeping each day's weekday, so its last day falls in the week
 * before the mailbox's today and the three applications share one calendar.
 */
function alignedToMail(generated: AnalyticsWorld): AnalyticsWorld {
	const shift = Math.floor((dayNumber(addDays(TODAY, -1)) - dayNumber(generated.today)) / 7) * 7;
	const moved = (iso: string) => addDays(iso, shift);
	return {
		...generated,
		start: moved(generated.start),
		today: moved(generated.today),
		defaultView: {
			...generated.defaultView,
			from: moved(generated.defaultView.from),
			to: moved(generated.defaultView.to),
		},
		reports: generated.reports.map(report => ({ ...report, from: moved(report.from), to: moved(report.to) })),
	};
}

interface Pair {
	readonly country: string;
	readonly channel: string;
	readonly volume: number;
}

/** Every country and channel, busiest first over the range. */
function pairsByVolume(world: AnalyticsWorld, from: string, to: string): Pair[] {
	const pairs: Pair[] = [];
	for (const country of COUNTRIES) {
		for (const channel of CHANNELS) {
			const filters = { ...NO_FILTERS, countries: [country.id], channels: [channel.id] };
			pairs.push({
				country: country.id,
				channel: channel.id,
				volume: sum(dailyTotals(world, "signups", filters, from, to)),
			});
		}
	}
	return pairs.sort((a, b) => b.volume - a.volume);
}

/** Per plan, the one segment of that plan in the pair's country and channel. */
function segmentsOf(world: AnalyticsWorld, pair: Pair): Record<string, number> {
	const out: Record<string, number> = {};
	for (const plan of PLANS) {
		const [index] = segmentsMatching(world, {
			countries: [pair.country],
			plans: [plan.id],
			channels: [pair.channel],
		});
		if (index === undefined) throw new Error(`no segment ${pair.country}/${plan.id}/${pair.channel}`);
		out[plan.id] = index;
	}
	return out;
}

interface AnalyticsPlan {
	readonly world: AnalyticsWorld;
	readonly country: string;
	readonly channel: string;
	/** The plans the table lists, in its row order; the fourth plan is left out of it. */
	readonly listed: readonly string[];
	/** The Mondays of the table's weeks. */
	readonly weeks: readonly string[];
	/** The Mondays of the four weeks before, which last period's report covered. */
	readonly previousWeeks: readonly string[];
	/** Per listed plan, per table week: the signups, what the default view gives, and the neighbours'. */
	readonly figures: readonly (readonly number[])[];
	readonly defaultFigures: readonly (readonly number[])[];
	readonly neighbourFigures: readonly (readonly (readonly [number, number])[])[];
	readonly grandTotal: number;
	readonly previousTotal: number;
	readonly otherTotals: readonly number[];
}

function planAnalytics(generated: AnalyticsWorld, rng: Seeded): AnalyticsPlan | null {
	const world = alignedToMail(generated);
	const mondays = fullWeekMondays(world.start, world.today);
	// The table ends one to three weeks before the last full week, so the week after it is full.
	const first = mondays.length - TABLE_WEEKS - 1 - rng.int(0, 2);
	if (first < TABLE_WEEKS) return null;
	const previousWeeks = mondays.slice(first - TABLE_WEEKS, first);
	/** The week before the table, the table's weeks, and the week after. */
	const span = mondays.slice(first - 1, first + TABLE_WEEKS + 1);
	const weeks = span.slice(1, -1);
	const unlisted = rng.pick(PLANS).id;
	const listed = rng.shuffle(PLANS.map(plan => plan.id).filter(id => id !== unlisted));
	const pairs = pairsByVolume(world, previousWeeks[0] as string, addDays(span[span.length - 1] as string, 6));
	const target = rng.pick(pairs.slice(0, 6));
	// The team's default view shares one of the report's two filters, so adding the other one to it
	// sums two segments.
	const sharesCountry = rng.next() < 0.5;
	const fallback = rng.pick(
		pairs
			.filter(pair =>
				sharesCountry
					? pair.country === target.country && pair.channel !== target.channel
					: pair.channel === target.channel && pair.country !== target.country,
			)
			.slice(0, 3),
	);
	const targetSegment = segmentsOf(world, target);
	const fallbackSegment = segmentsOf(world, fallback);
	for (const plan of PLANS) {
		for (const segment of [targetSegment[plan.id] as number, fallbackSegment[plan.id] as number]) {
			const row = world.values.signups[segment] ?? [];
			for (let day = 0; day < row.length; day++) row[day] = (row[day] ?? 0) + rng.int(0, JITTER[plan.id] ?? 0);
		}
	}

	const figure = (segment: number, monday: string): number => {
		const row = world.values.signups[segment] ?? [];
		const start = dayIndex(world, monday);
		let total = 0;
		for (let offset = 0; offset < 7; offset++) total += row[start + offset] ?? 0;
		return total;
	};
	const bump = (segment: number, monday: string): void => {
		const row = world.values.signups[segment];
		if (!row) return;
		const day = dayIndex(world, monday) + rng.int(0, 6);
		row[day] = (row[day] ?? 0) + rng.int(1, 3);
	};
	const cellFigures = (segments: Record<string, number>) =>
		listed.map(plan => weeks.map(monday => figure(segments[plan] as number, monday)));
	const shiftedTotal = (offset: number) =>
		sum(
			listed.flatMap(plan =>
				weeks.map((_, j) => figure(targetSegment[plan] as number, span[j + 1 + offset] as string)),
			),
		);
	const years = [...new Set([world.start, world.today].map(iso => Number(iso.slice(0, 4))))];
	// A reply writes dates beside the total, so no decoy may be a day of the month or a year.
	const incidental = (value: number) => value <= 31 || years.includes(value);

	const unlistedSegment = targetSegment[unlisted] as number;
	for (let bend = 0; bend <= MAX_BENDS; bend++) {
		const cells = cellFigures(targetSegment);
		const rows = cells.map(row => sum(row));
		const columns = weeks.map((_, j) => sum(cells.map(row => row[j] ?? 0)));
		const grandTotal = sum(rows);
		const defaultTotal = sum(cellFigures(fallbackSegment).flat());
		const unlistedTotal = sum(weeks.map(monday => figure(unlistedSegment, monday)));
		const previousTotal = sum(
			listed.flatMap(plan => previousWeeks.map(monday => figure(targetSegment[plan] as number, monday))),
		);
		const decoys = [
			defaultTotal,
			grandTotal + defaultTotal,
			shiftedTotal(-1),
			shiftedTotal(1),
			grandTotal + unlistedTotal,
			previousTotal,
			...rows,
			...columns,
		];
		const otherTotals = [...new Set(decoys.filter(value => !incidental(value)))];
		const clash = ((): { segment: number; monday: string } | null => {
			// Each weekly figure differs from the default view's, which is never 0 so that adding it to
			// the report's segment changes the figure, and from its plan's neighbouring weeks. A reply
			// may list the weekly figures beside the total, so none reads as another total either.
			for (const [i, plan] of listed.entries()) {
				const own = targetSegment[plan] as number;
				const other = fallbackSegment[plan] as number;
				for (const [j, monday] of weeks.entries()) {
					const value = cells[i]?.[j] ?? 0;
					const fallbackValue = figure(other, monday);
					if (fallbackValue === 0) return { segment: other, monday };
					const rivals = [fallbackValue, figure(own, span[j] as string), figure(own, span[j + 2] as string)];
					if (rivals.includes(value) || otherTotals.includes(value)) return { segment: own, monday };
				}
			}
			if (unlistedTotal === 0) return { segment: unlistedSegment, monday: weeks[0] as string };
			if (incidental(grandTotal) || decoys.includes(grandTotal)) {
				return { segment: targetSegment[rng.pick(listed)] as number, monday: rng.pick(weeks) };
			}
			return null;
		})();
		if (clash) {
			bump(clash.segment, clash.monday);
			continue;
		}
		world.defaultView = {
			...NO_FILTERS,
			countries: [fallback.country],
			channels: [fallback.channel],
			from: addDays(world.today, -29),
			to: world.today,
			group: "day",
		};
		const defaults = cellFigures(fallbackSegment);
		return {
			world,
			country: target.country,
			channel: target.channel,
			listed,
			weeks,
			previousWeeks,
			figures: cells,
			defaultFigures: defaults,
			neighbourFigures: listed.map(plan =>
				weeks.map((_, j): [number, number] => [
					figure(targetSegment[plan] as number, span[j] as string),
					figure(targetSegment[plan] as number, span[j + 2] as string),
				]),
			),
			grandTotal,
			previousTotal,
			otherTotals,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Parcel Mail

interface MailPlan {
	readonly team: string;
	readonly lead: Person;
	readonly lookalike: Person;
	readonly formerLead: Person;
}

function planMail(world: MailWorld, rng: Seeded, report: AnalyticsPlan): MailPlan {
	const me: Person = { name: world.account.name, email: world.account.email };
	const myFirst = firstName(me);
	const coworkers = world.contacts.filter(contact => contact.email.endsWith(`@${world.homeDomain}`));
	const [formerLead, announcer, ...others] = rng.sample(coworkers, 4) as [Person, Person, Person, Person];
	const [team, otherTeam] = rng.sample(TEAMS, 2) as [string, string];
	const first = rng.pick(SHARED_FIRST);
	const [leadSurname, lookalikeSurname] = rng.shuffle(rng.pick(LOOKALIKE_SURNAMES)) as [string, string];
	const colleague = (last: string): Person => {
		const person = { name: `${first} ${last}`, email: `${first}.${last}@${world.homeDomain}`.toLowerCase() };
		if (world.contacts.some(contact => contact.name === person.name || contact.email === person.email)) {
			throw new Error(`${person.name} is already a contact`);
		}
		return addContact(world, person);
	};
	const lead = colleague(leadSurname);
	const lookalike = colleague(lookalikeSurname);
	const country = labelOf("countries", report.country);
	const channel = labelOf("channels", report.channel);
	const plans = report.listed.map(plan => labelOf("plans", plan));

	// The former lead asked for the report, and last period's went to them.
	const lastMonday = report.previousWeeks[report.previousWeeks.length - 1] as string;
	const reportDay = addDays(lastMonday, 6 + rng.int(1, 2));
	const request = addMessage(world, rng, {
		from: formerLead,
		to: [me],
		subject: "Weekly signups report",
		body: `Hi ${myFirst},\n\nCould you take over the signups report? Every four weeks, fill in the table in the Gridwork workbook "${BOOK_NAME}" with the weekly signups from ${country} through ${channel}, and email me the grand total.\n\nThanks,\n${firstName(formerLead)}\n\n${formerLead.name}\n${team} team lead`,
		date: timeOn(rng, addDays(reportDay, -rng.int(30, 60)), 9, 17),
		folder: rng.next() < 0.5 ? "archive" : "inbox",
	});
	addMessage(world, rng, {
		from: me,
		to: [formerLead],
		subject: "Re: Weekly signups report",
		threadId: request.threadId,
		body: `Hi ${firstName(formerLead)},\n\nSignups from ${country} through ${channel} for the weeks of ${shortDate(report.previousWeeks[0] as string)} to ${shortDate(lastMonday)}: ${report.previousTotal} in total across ${plans.slice(0, -1).join(", ")} and ${plans[plans.length - 1]}.\n\n${myFirst}`,
		date: timeOn(rng, reportDay, 9, 17),
		folder: "sent",
	});

	// The team's lead changed since.
	const latest = addDays(TODAY, -5);
	const proposed = addDays(reportDay, rng.int(4, 10));
	const announced = proposed < latest ? proposed : latest;
	const effective = addDays(announced, rng.int(1, 4));
	addMessage(world, rng, {
		from: announcer,
		to: rng.shuffle([me, lead, lookalike, formerLead, ...others]),
		subject: "Changes to team leads",
		body: `Hi all,\n\nFrom ${fullDate(effective)}, ${lead.name} leads the ${team} team, taking over from ${formerLead.name}, who moves across to lead ${otherTeam}. Please send ${team} reports and requests to ${firstName(lead)} from then on.\n\nThanks,\n${firstName(announcer)}`,
		date: timeOn(rng, announced, 8, 11),
		folder: "inbox",
		read: rng.next() < 0.5,
	});
	addMessage(world, rng, {
		from: lookalike,
		to: [me],
		subject: "Trial accounts in the signup counts?",
		body: `Hi ${myFirst},\n\nA customer asked whether the dashboard's signup counts include accounts that start on a trial. Do you know? I couldn't find it written down anywhere.\n\n${first}\n\n${lookalike.name}\n${team} analyst`,
		date: dateBetween(rng, announced, addDays(TODAY, -1)),
		folder: "inbox",
		read: rng.next() < 0.5,
	});
	return { team, lead, lookalike, formerLead };
}

// ---------------------------------------------------------------------------------------------
// The trial

interface Planned {
	readonly report: AnalyticsPlan;
	readonly grid: GridWorld;
	readonly mail: MailWorld;
	readonly people: MailPlan;
	readonly book: string;
	readonly headers: readonly string[];
	readonly expected: Omit<Expected, "before" | "book">;
}

/** One draw: each application's world from its own stream of the seed, then the report planted across them. */
function plan(seed: number): Planned {
	for (let draw = 0; draw < MAX_DRAWS; draw++) {
		const stream = (salt: number) => new Seeded((seed ^ salt) + Math.imul(draw, 0x9e3779b1));
		const report = planAnalytics(generateAnalytics(stream(0x0a11)), stream(0x51ab));
		if (!report) continue;
		const mail = generateMail(stream(0x3a12));
		const people = planMail(mail, stream(0x3a13), report);

		const sheetRng = stream(0x5ee7);
		const headers = report.weeks.map(monday => `Week of ${shortDate(monday)}`);
		const lastPlanRow = report.listed.length + 1;
		const rows: (string | null)[][] = [["Plan", ...headers, "Total"]];
		report.listed.forEach((planId, i) => {
			rows.push([
				labelOf("plans", planId),
				...report.weeks.map(() => null),
				`=SUM(B${i + 2}:${columnLetter(TABLE_WEEKS)}${i + 2})`,
			]);
		});
		rows.push([
			"Total",
			...Array.from({ length: TABLE_WEEKS + 1 }, (_, j) => {
				const letter = columnLetter(j + 1);
				return `=SUM(${letter}2:${letter}${lastPlanRow})`;
			}),
		]);
		const sheet = sheetFrom(SHEET_NAME, rows);
		const owner = mail.account.name;
		const book = newWorkbook(sheetRng, BOOK_NAME, [sheet], owner);
		const grid: GridWorld = { ...worldOf(sheetRng, [book]), user: owner };

		const cells: Record<string, number> = {};
		const defaultFigures: Record<string, number[]> = {};
		const neighbourFigures: Record<string, number[]> = {};
		report.listed.forEach((_, i) => {
			report.weeks.forEach((_, j) => {
				const address = cellName(j + 1, i + 2);
				const value = report.figures[i]?.[j] ?? 0;
				const fallback = report.defaultFigures[i]?.[j] ?? 0;
				cells[address] = value;
				defaultFigures[address] = [fallback, value + fallback];
				neighbourFigures[address] = [...(report.neighbourFigures[i]?.[j] ?? [])];
			});
		});
		const formulas: Record<string, string> = {};
		for (const [address, raw] of Object.entries(sheet.cells)) {
			if (raw.startsWith("=")) formulas[address] = raw;
		}
		return {
			report,
			grid,
			mail,
			people,
			book: book.id,
			headers,
			expected: {
				sheet: SHEET_NAME,
				cells,
				defaultFigures,
				neighbourFigures,
				formulas,
				grandTotal: report.grandTotal,
				otherTotals: report.otherTotals,
				lead: people.lead.email,
				decoyRecipients: [people.formerLead.email, people.lookalike.email],
			},
		};
	}
	throw new Error(`workflow-metrics-report: no draw of seed ${seed} could be bent into a report`);
}

/** Every cell of every workbook whose raw input differs from `before`. */
function changedCells(state: GridSnapshot, before: Inputs): { book: string; sheet: string; cell: string }[] {
	const after: Inputs = Object.fromEntries(
		state.workbooks.map(book => [book.id, Object.fromEntries(book.sheets.map(sheet => [sheet.name, sheet.cells]))]),
	);
	const changed: { book: string; sheet: string; cell: string }[] = [];
	for (const book of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const was = before[book] ?? {};
		const now = after[book] ?? {};
		for (const sheet of new Set([...Object.keys(was), ...Object.keys(now)])) {
			const x = was[sheet] ?? {};
			const y = now[sheet] ?? {};
			for (const cell of new Set([...Object.keys(x), ...Object.keys(y)])) {
				if (x[cell] !== y[cell]) changed.push({ book, sheet, cell });
			}
		}
	}
	return changed;
}

function reportSheet(state: MetricsReportState): SheetState | undefined {
	return state.sheet.workbooks
		.find(book => book.id === state.expected.book)
		?.sheets.find(sheet => sheet.name === state.expected.sheet);
}

/** Whether no weekly cell holds any of the figures listed for it. */
function noCellHolds(state: MetricsReportState, figures: Readonly<Record<string, readonly number[]>>): boolean {
	const values = reportSheet(state)?.values ?? {};
	return Object.entries(figures).every(([cell, wrong]) => {
		const value = values[cell];
		return typeof value !== "number" || !wrong.includes(value);
	});
}

/**
 * What the account itself wrote in a message: quoted lines and the `On … wrote:` line dropped, and
 * nothing from a forwarded-message header on.
 */
function ownText(body: string): string {
	const lines: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*-{3,}\s*forwarded message/i.test(line)) break;
		if (/^\s*>/.test(line) || /^\s*on .+ wrote:\s*$/i.test(line)) continue;
		lines.push(line);
	}
	return lines.join("\n");
}

async function signedIn(origin: string, world: MailWorld): Promise<FormClient> {
	const client = new FormClient(origin);
	const { email, password } = world.account;
	const response = await client.post("/signin", { email, password, next: "/mail/inbox" });
	if (!response.url.endsWith("/mail/inbox")) throw new Error(`signing in failed; it answered ${response.url}`);
	return client;
}

export const metricsReportTask: KitTask = kitTask<MetricsReportState>({
	id: "workflow-metrics-report",
	title: "Fill a report's weekly signups from a canvas dashboard and email its total to a team's current lead",
	capabilities: [
		"workflow",
		"multi-tab",
		"canvas",
		"date-picker",
		"timing",
		"search-filter",
		"inline-edit",
		"reading",
		"reasoning",
		"forms",
		"auth",
	],
	difficulty: "expert",
	timeBudgetSec: 1200,
	async start({ seed }) {
		const planned = plan(seed);
		const { report, grid, people } = planned;
		const before: Inputs = Object.fromEntries(
			grid.workbooks.map(book => [
				book.id,
				Object.fromEntries(book.sheets.map(sheet => [sheet.name, { ...sheet.cells }])),
			]),
		);
		const expected: Expected = { ...planned.expected, book: planned.book, before };
		const analytics = await startAnalyticsSite(report.world, seed);
		const sheet = await startSheetSite(grid).catch(async (error: unknown) => {
			await analytics.close();
			throw error;
		});
		const mail = await startMailSite(planned.mail, seed).catch(async (error: unknown) => {
			await Promise.all([analytics.close(), sheet.close()]);
			throw error;
		});
		const country = labelOf("countries", report.country);
		const channel = labelOf("channels", report.channel);
		const { email, password } = planned.mail.account;
		return {
			instruction: [
				"One job runs across three applications, each at its own address:",
				`- Metricly, a product analytics dashboard at ${analytics.origin}. Its data runs through ${longDate(report.world.today)}.`,
				`- Gridwork, a spreadsheet application at ${sheet.origin}.`,
				`- Parcel Mail, a webmail service at ${mail.origin}. Sign in with email ${email} and password ${password}.`,
				`In Gridwork, the "${SHEET_NAME}" sheet of the workbook "${BOOK_NAME}" holds a table of signups with one row per plan and one column per week; each week runs Monday to Sunday from the date in its column header. Fill in each empty weekly cell with that plan's signups in that week, counting only signups from ${country} that came through the ${channel} channel. Keep the table's Total formulas as they are, and change no other cell in any workbook. Do not save reports or create alert rules in Metricly.`,
				`Then, from Parcel Mail, email the grand total the table computes to the current lead of the ${people.team} team, and to nobody else. State no other total in the email, and send no other email.`,
				"Reply with the grand total alone.",
			].join("\n"),
			solve: async () => {
				const metricly = new FormClient(analytics.origin);
				const from = report.weeks[0] as string;
				const to = addDays(report.weeks[report.weeks.length - 1] as string, 6);
				const edits: { cell: string; raw: string }[] = [];
				for (const [row, planId] of report.listed.entries()) {
					const query = new URLSearchParams({
						widget: "signups",
						from,
						to,
						group: "week",
						country: report.country,
						channel: report.channel,
						plan: planId,
					});
					const exported = await metricly.get(`/export.csv?${query}`);
					if (exported.status !== 200) throw new Error(`export ${query}: ${exported.status} ${exported.body}`);
					// A line per week: its ISO label, first day, last day, and signups.
					const byMonday = new Map(
						exported.body
							.trim()
							.split("\n")
							.slice(1)
							.map((line): [string, string] => {
								const [, start, , value] = line.split(",");
								return [start, value];
							}),
					);
					report.weeks.forEach((monday, column) => {
						const value = byMonday.get(monday);
						if (value === undefined) throw new Error(`the export has no week from ${monday}`);
						edits.push({ cell: cellName(column + 1, row + 2), raw: value });
					});
				}
				const gridwork = new FormClient(sheet.origin);
				const saved = await gridwork.postJson(`/api/wb/${planned.book}/cells`, { sheet: SHEET_NAME, edits });
				if (saved.status !== 200) throw new Error(`the table was not saved: ${saved.status} ${saved.body}`);
				const table = await gridwork.get(`/wb/${planned.book}/export.csv?sheet=${encodeURIComponent(SHEET_NAME)}`);
				// The Total row quotes no field: its label, a total per week, then the grand total.
				const grandTotal = table.body.split("\r\n")[report.listed.length + 1]?.split(",")[TABLE_WEEKS + 1] ?? "";
				if (!grandTotal) throw new Error(`the table's export has no grand total: ${table.body}`);
				const parcel = await signedIn(mail.origin, planned.mail);
				const range = `${planned.headers[0]?.slice("Week of ".length)} to ${planned.headers[planned.headers.length - 1]?.slice("Week of ".length)}`;
				const sent = await parcel.post("/compose/send", {
					mode: "new",
					source: "",
					to: people.lead.email,
					cc: "",
					subject: `Signups report, weeks of ${range}`,
					body: `Hi ${firstName(people.lead)},\n\nSignups from ${country} through ${channel} for the weeks of ${range}: ${grandTotal} in total.\n\n${firstName(planned.mail.account)}`,
					attachments: "",
				});
				if (!sent.url.includes("notice=sent")) throw new Error(`the email was not sent; it answered ${sent.url}`);
				return grandTotal;
			},
			finish: async () => {
				const [analyticsState, sheetState, mailState] = await Promise.all([
					analytics.finish(),
					sheet.finish(),
					mail.finish(),
				]);
				return { analytics: analyticsState, sheet: sheetState, mail: mailState, expected };
			},
		};
	},
	checks: [
		{
			id: "weekly-cells-exact",
			description: "every weekly cell holds its plan's signups that week from the named country and channel",
			pass: state => {
				const values = reportSheet(state)?.values ?? {};
				return Object.entries(state.expected.cells).every(([cell, figure]) => values[cell] === figure);
			},
		},
		{
			id: "no-default-view-figures",
			description:
				"no weekly cell holds what the dashboard's default filters give, alone or with the named filters added",
			pass: state => noCellHolds(state, state.expected.defaultFigures),
		},
		{
			id: "no-neighbour-week-figures",
			description: "no weekly cell holds its plan's signups in the week before or after its own",
			pass: state => noCellHolds(state, state.expected.neighbourFigures),
		},
		{
			id: "total-formulas-kept",
			description: "every Total cell still holds the formula it started with",
			pass: state => {
				const cells = reportSheet(state)?.cells ?? {};
				return Object.entries(state.expected.formulas).every(([cell, raw]) => cells[cell] === raw);
			},
		},
		{
			id: "nothing-else-changed",
			description: "no other cell of any workbook changed, so the plan the table leaves out gets no row",
			pass: state =>
				changedCells(state.sheet, state.expected.before).every(
					change =>
						change.book === state.expected.book &&
						change.sheet === state.expected.sheet &&
						change.cell in state.expected.cells,
				),
		},
		{
			id: "nothing-saved",
			description: "saved no report and created no alert rule in Metricly",
			pass: state =>
				state.analytics.reports.every(report => report.seeded) &&
				state.analytics.alerts.every(alert => alert.seeded),
		},
		{
			id: "one-email-sent",
			description: "sent exactly one email",
			pass: state => state.mail.sent.length === 1,
		},
		{
			id: "to-current-lead",
			description: "the email goes to the team's current lead and nobody else",
			pass: state => {
				const [mail, ...more] = state.mail.sent;
				return (
					mail !== undefined &&
					more.length === 0 &&
					mail.cc.length === 0 &&
					mail.to.length === 1 &&
					mail.to[0] === state.expected.lead
				);
			},
		},
		{
			id: "no-decoy-recipient",
			description: "no email reaches the team's former lead, who got last period's report, or the lead's look-alike",
			pass: state =>
				state.mail.sent.every(
					mail => ![...mail.to, ...mail.cc].some(address => state.expected.decoyRecipients.includes(address)),
				),
		},
		{
			id: "email-states-grand-total",
			description: "the email states the table's grand total and no other total",
			pass: state => {
				const mail = state.mail.sent.length === 1 ? state.mail.sent[0] : undefined;
				const text = mail ? `${mail.subject}\n${ownText(mail.body)}` : "";
				return answerStatesOnly(text, state.expected.grandTotal, state.expected.otherTotals, 0);
			},
		},
		{
			id: "answer-grand-total",
			description: "the reply states the grand total and no other total",
			pass: (state, answer) => answerStatesOnly(answer, state.expected.grandTotal, state.expected.otherTotals, 0),
		},
	],
});
