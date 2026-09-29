/**
 * WHY: a date typed into a URL or a request body is a date an agent wrote, and it is sometimes
 * wrong. Metricly's date check matched the shape `YYYY-MM-DD` and then formatted the parsed day
 * back, and a month or day out of range (`2025-13-01`) parses to no day at all, so formatting it
 * threw: every endpoint that takes a date answered 500 with "Invalid Date" instead of the page's own
 * message, and the dashboard lost its error banner and default view.
 *
 * This suite sends malformed dates (a month or day out of range, a day past the month's end, a
 * short or unseparated form, words, nothing) to every endpoint of Metricly and Skyway that takes a
 * date, in each date parameter, and requires the answer the site gives for a bad date: its own
 * message, never a server error.
 *
 * Not caught: an endpoint that takes a date and is missing from `ENDPOINTS`; each is listed by hand.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import type { KitTask } from "../../../engine/kit/catalog";
import { FormClient, type FormResponse } from "../../../engine/kit/form-client";
import { trialSeed } from "../../../engine/kit/suite";
import { ANALYTICS_TASKS } from "../../../suites/browser/apps/analytics/tasks";
import { TRAVEL_TASKS } from "../../../suites/browser/apps/travel/tasks";

const MALFORMED = [
	"2025-13-01",
	"2025-00-10",
	"2025-02-30",
	"2025-04-31",
	"2025-02-00",
	"2025-1-5",
	"20250105",
	"not-a-date",
	"",
];

interface Endpoint {
	readonly app: "analytics" | "travel";
	readonly name: string;
	/** The request with `bad` in one date parameter, given a valid date the site accepts. */
	readonly send: (client: FormClient, bad: string, valid: string) => Promise<FormResponse>;
	/** What the answer holds for a bad date. */
	readonly status: number;
	readonly message: string;
}

/** Metricly's reads that take a range: the path, its other parameters, and the status a bad date gets. */
const METRICLY_READS: readonly { path: string; params: Record<string, string>; status: number }[] = [
	{ path: "/", params: { group: "day" }, status: 200 },
	{ path: "/api/series", params: { metric: "signups", group: "day" }, status: 400 },
	{ path: "/api/breakdown", params: { metric: "revenue", by: "channels", group: "day" }, status: 400 },
	{ path: "/api/drill", params: { metric: "signups" }, status: 400 },
	{ path: "/export.csv", params: { widget: "revenue", group: "week" }, status: 400 },
];

const ENDPOINTS: readonly Endpoint[] = [
	...METRICLY_READS.flatMap(read =>
		(["from", "to"] as const).map(
			(which): Endpoint => ({
				app: "analytics",
				name: `${read.path} ${which}`,
				send: (client, bad, valid) => {
					const range = { from: which === "from" ? bad : valid, to: which === "to" ? bad : valid };
					return client.get(`${read.path}?${new URLSearchParams({ ...read.params, ...range })}`);
				},
				status: read.status,
				message: `${which} must be a date written YYYY-MM-DD.`,
			}),
		),
	),
	...(["from", "to"] as const).map(
		(which): Endpoint => ({
			app: "analytics",
			name: `/api/reports ${which}`,
			send: (client, bad, valid) =>
				client.postJson("/api/reports", {
					name: `Report ${which} ${bad}`,
					metric: "signups",
					from: which === "from" ? bad : valid,
					to: which === "to" ? bad : valid,
					group: "day",
					countries: [],
					plans: [],
					channels: [],
				}),
			status: 400,
			message: `${which} must be a date written YYYY-MM-DD.`,
		}),
	),
	{
		app: "travel",
		name: "/api/search date",
		send: (client, bad) => client.get(`/api/search?${new URLSearchParams({ from: "NPT", to: "MLW", date: bad })}`),
		status: 400,
		message: "Name two airports and a date.",
	},
	{
		app: "travel",
		name: "/flights depart",
		send: (client, bad) =>
			client.get(
				`/flights?${new URLSearchParams({ trip: "oneway", from: "NPT", to: "MLW", depart: bad, adults: "1", children: "0" })}`,
			),
		status: 200,
		message: "Choose a departure date in the calendar.",
	},
	{
		app: "travel",
		name: "/flights return",
		send: (client, bad, valid) =>
			client.get(
				`/flights?${new URLSearchParams({ trip: "round", from: "NPT", to: "MLW", depart: valid, return: bad, adults: "1", children: "0" })}`,
			),
		status: 200,
		message: "Choose a return date on or after the departure date.",
	},
];

function originOf(instruction: string): string {
	const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(instruction)?.[0];
	if (!origin) throw new Error(`the instruction names no site: ${instruction}`);
	return origin;
}

/** A date each site accepts: Metricly's last day of data, Skyway's first bookable day. */
const VALID: Readonly<Record<Endpoint["app"], { task: KitTask; pattern: RegExp }>> = {
	analytics: { task: ANALYTICS_TASKS[0] as KitTask, pattern: /"today":"(\d{4}-\d{2}-\d{2})"/ },
	travel: { task: TRAVEL_TASKS[0] as KitTask, pattern: /data-min="(\d{4}-\d{2}-\d{2})"/ },
};

describe("a malformed date", () => {
	for (const app of ["analytics", "travel"] as const) {
		it(`is refused with ${app}'s own message on every endpoint that takes one`, async () => {
			const { task, pattern } = VALID[app];
			await using dir = await TempDir.create("@evals-malformed-dates-");
			const trial = await task.start({
				seed: trialSeed({ task: task.id, repeat: 0 }),
				workspace: dir.path(),
				trialDir: dir.path(),
			});
			const violations: string[] = [];
			try {
				const client = new FormClient(originOf(trial.instruction));
				const valid = pattern.exec((await client.get("/")).body)?.[1];
				if (!valid) throw new Error(`${app} shows no valid date on its home page`);
				for (const endpoint of ENDPOINTS.filter(entry => entry.app === app)) {
					for (const bad of MALFORMED) {
						const response = await endpoint.send(client, bad, valid);
						if (response.status !== endpoint.status || !response.body.includes(endpoint.message)) {
							violations.push(`${endpoint.name} "${bad}": ${response.status} ${response.body.slice(0, 80)}`);
						}
					}
				}
			} finally {
				await trial.finish();
			}
			expect(violations).toEqual([]);
		});
	}
});
