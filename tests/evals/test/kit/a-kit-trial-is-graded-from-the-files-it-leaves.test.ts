/**
 * WHY: a kit suite grades a trial from two files, the `state.json` its services' `finish` wrote and
 * the `answer.txt` the backend wrote, so a finished run can be graded again after a check is fixed.
 * A grade that read live objects instead, a state file that went missing silently, a catalog whose
 * task names an unknown capability, or a seed that depended on the arm would each skew every
 * comparison without failing a run. These cases drive `defineSuite` end to end on a one-task suite
 * whose site counts presses: prepare, solve over HTTP, finish, write the answer, score.
 *
 * The regrade reads the same files: a run copied to another host recorded trial directories that no
 * longer exist there, and every trial regraded as an error until the regrade looked for them under
 * the run directory it reads. A run without its `run.json` has no plan order, and a report that
 * took the arms in settle order paired every arm against whichever finished first; it is refused.
 *
 * Not caught: the local-cli backend's own part (writing `answer.txt`, the sandbox); its suite
 * covers that.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { kitTask } from "../../engine/kit/catalog";
import { answerHasNumber, answerHasText, numbersIn } from "../../engine/kit/checks";
import { FormClient } from "../../engine/kit/form-client";
import { DEFAULT_BUDGETS, renderKitReport, summarizeKitRun } from "../../engine/kit/report";
import { defineSuite, KIT_FILES, trialSeed } from "../../engine/kit/suite";
import { hostSite, text } from "../../engine/kit/web-host";
import { openRunJournal } from "../../engine/run/journal";
import { LOCAL_TRIAL_FILES, trialDirFor } from "../../engine/run/layout";
import { RUN_RECORD_FILE } from "../../engine/run/output";
import type { TrialResultRecord } from "../../engine/run/record";
import browserSuite from "../../suites/browser/main";
import { kitReport } from "../../tools/kit-report";

interface PressState {
	readonly presses: number;
	readonly expected: number;
}

const pressTask = kitTask<PressState>({
	id: "press-n-times",
	title: "Press a button a stated number of times",
	capabilities: ["forms"],
	difficulty: "easy",
	async start({ seed }) {
		let presses = 0;
		const expected = 2 + (seed % 3);
		const site = await hostSite(request => {
			if (request.method === "POST" && request.url.pathname === "/press") presses++;
			return text(String(presses));
		});
		return {
			instruction: `Press ${expected} times at ${site.origin}/press, then say how many.`,
			async solve() {
				const client = new FormClient(site.origin);
				for (let i = 0; i < expected; i++) await client.post("/press");
				return `Pressed ${expected} times.`;
			},
			async finish() {
				await site.close();
				return { presses, expected };
			},
		};
	},
	checks: [
		{
			id: "pressed",
			description: "pressed the stated number of times",
			pass: state => state.presses === state.expected,
		},
		{
			id: "reported",
			description: "reported the count",
			pass: (state, answer) => answerHasNumber(answer, state.expected),
		},
	],
});

const CAPABILITIES = { forms: "forms" };

function suiteOf(tasks = [pressTask]) {
	return defineSuite({
		id: "kit-probe",
		version: "1.0.0",
		displayName: "Kit probe",
		description: "one task",
		sourceDir: import.meta.dirname,
		capabilities: CAPABILITIES,
		tasks,
		tools: ["probe-tool"],
		settings: { probe: { enabled: true } },
		defaultTimeBudgetSec: 30,
		hostEnvironment: async () => ({ env: { PROBE_BINARY: "/opt/probe/bin" }, readable: ["/opt/probe"] }),
	});
}

const CELL = { variant: "arm", suite: "kit-probe", task: "press-n-times", repeat: 0 };

describe("a kit trial", () => {
	it("is graded from the state its services recorded and the answer the agent gave", async () => {
		await using dir = await TempDir.create("@evals-kit-trial-");
		const suite = suiteOf();
		const environment = await suite.prepareTrial?.(CELL, { trialDir: dir.path(), workspace: dir.join("workspace") });
		if (!environment?.instruction) throw new Error("the kit suite prepared no instruction");
		expect(environment.tools).toEqual(["probe-tool"]);
		expect(environment.settings).toEqual({ probe: { enabled: true } });
		expect(environment.env).toEqual({ PROBE_BINARY: "/opt/probe/bin" });
		expect(environment.readable).toEqual(["/opt/probe"]);

		const match = /Press (\d+) times at (http:\/\/[^/\s]+)\/press/.exec(environment.instruction);
		if (!match) throw new Error(`the instruction names no site: ${environment.instruction}`);
		const expected = Number(match[1]);
		const client = new FormClient(match[2] as string);
		for (let i = 0; i < expected; i++) await client.post("/press");
		await environment.finish();
		expect(JSON.parse(await fs.readFile(dir.join(KIT_FILES.state), "utf8"))).toEqual({ presses: expected, expected });

		await fs.writeFile(dir.join(LOCAL_TRIAL_FILES.answer), `I pressed it ${expected} times.`);
		const passed = await suite.scoreTrial(CELL, { trialDir: dir.path() });
		expect([passed.reward, passed.partial, passed.error]).toEqual([1, 1, null]);

		await fs.writeFile(dir.join(LOCAL_TRIAL_FILES.answer), "Done.");
		const unreported = await suite.scoreTrial(CELL, { trialDir: dir.path() });
		expect([unreported.reward, unreported.partial]).toEqual([0, 0.5]);
		expect(unreported.extra.checks).toEqual([
			{ id: "pressed", description: "pressed the stated number of times", passed: true },
			{ id: "reported", description: "reported the count", passed: false },
		]);
	});

	it("that left no state is an error, not a failure", async () => {
		await using dir = await TempDir.create("@evals-kit-trial-");
		const score = await suiteOf().scoreTrial(CELL, { trialDir: dir.path() });
		expect(score.reward).toBeNull();
		expect(score.error).toContain(KIT_FILES.state);
	});

	it("is seeded by its task and repeat, never by its arm", () => {
		const seed = trialSeed({ task: "press-n-times", repeat: 0 });
		expect(trialSeed({ task: "press-n-times", repeat: 0 })).toBe(seed);
		expect(trialSeed({ task: "press-n-times", repeat: 1 })).not.toBe(seed);
		expect(trialSeed({ task: "press-other", repeat: 0 })).not.toBe(seed);
	});
});

describe("a kit catalog", () => {
	it("is refused before a trial when a task is unsound", async () => {
		const variant = (id: string, capabilities: readonly string[], checks: number) =>
			kitTask<unknown>({
				id,
				title: id,
				capabilities,
				difficulty: "easy",
				start: pressTask.start,
				checks: Array.from({ length: checks }, () => ({ id: "a", description: "a", pass: () => true })),
			});
		const duplicate = variant("press-n-times", ["forms"], 1);
		const unknown = variant("strange", ["telepathy"], 1);
		const unchecked = variant("unchecked", ["forms"], 0);
		const verdict = await suiteOf([pressTask, duplicate, unknown, unchecked]).preflight({});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe(
			'press-n-times: the id is used twice; strange: unknown capability "telepathy"; unchecked: has no checks',
		);
	});
});

describe("an answer check", () => {
	it("reads a number however the agent formats it, and a date's parts as positive numbers", () => {
		expect(answerHasNumber("The order total is $1,234.50.", 1234.5)).toBe(true);
		expect(answerHasNumber("Growth was 12.3%", 12.3)).toBe(true);
		expect(answerHasNumber("It fell by -40 units", -40)).toBe(true);
		expect(numbersIn("Due 2026-05-03")).toEqual([2026, 5, 3]);
		expect(answerHasNumber("The order total is $1,234.50.", 1234)).toBe(false);
	});

	it("matches text regardless of case, spacing and curly quotes", () => {
		expect(answerHasText("The  SKU is ‘SK-5HANU’", "the sku is 'sk-5hanu'")).toBe(true);
		expect(answerHasText("SK-5HANU", "SK-5HANV")).toBe(false);
	});
});

describe("a kit run report", () => {
	const record = (
		variant: string,
		task: string,
		reward: number | null,
		tokens: number,
		turns: number,
	): TrialResultRecord => ({
		cell: { variant, suite: "kit-probe", task, repeat: 0 },
		score: {
			reward,
			partial: reward,
			error: reward === null ? "the agent never started" : null,
			usage: { inputTokens: tokens, outputTokens: 0, durationSec: 10, extra: { turns } },
			extra: { capabilities: ["forms"], difficulty: "easy" },
		},
	});

	it("pairs every arm against the plan's first, only on trials both graded, and counts passes within each budget", () => {
		// The candidate's trials settled first, as a faster arm's do; the plan still names main first.
		const summary = summarizeKitRun(
			[
				record("head", "a", 1, 40_000, 4),
				record("main", "a", 1, 90_000, 12),
				record("head", "b", 1, 60_000, 8),
				record("main", "b", 0, 200_000, 30),
				record("head", "c", null, 0, 0),
				record("main", "c", 1, 50_000, 6),
			],
			{ model: "p/m", tasks: ["a", "b", "c"], repeats: 1, variants: ["main", "head"] },
			"kit-probe",
		);
		expect(summary.arms.map(arm => arm.arm)).toEqual(["main", "head"]);
		const [pair] = summary.paired;
		expect(pair).toMatchObject({ baseline: "main", candidate: "head", pairs: 2, wins: 1, losses: 0, bothPassed: 1 });
		expect(pair?.tokens).toEqual({ baseline: 290_000, candidate: 100_000 });
		const head = summary.arms.find(arm => arm.arm === "head");
		expect([head?.graded, head?.errors, head?.passes]).toEqual([2, 1, 2]);
		expect(head?.passesWithinTurns).toEqual([1, 2, 2, 2]);
		expect(head?.byCapability).toEqual({ forms: { passes: 2, graded: 2 } });
	});

	/**
	 * A run of one `shop-warranty-answer` trial whose files hold a pass under today's checks, while
	 * the score recorded when the run ended says it failed, as a check with a bug would.
	 */
	async function warrantyRun(root: string, options: { recordedAt?: string; runRecord?: boolean } = {}) {
		const runDir = path.join(root, "run-1");
		const cell = { variant: "veyyon", suite: "browser", task: "shop-warranty-answer", repeat: 1 };
		const trialDir = trialDirFor(root, "run-1", cell);
		await fs.mkdir(trialDir, { recursive: true });
		const state = {
			orders: [],
			returns: [],
			cart: [],
			appliedCoupon: null,
			newsletterSignups: 0,
			failedSignins: 0,
			stock: {},
			expected: { names: ["A", "B", "C"], sku: "SK-AAAAA", years: 5, others: ["SK-BBBBB", "SK-CCCCC"] },
		};
		await fs.writeFile(path.join(trialDir, KIT_FILES.state), JSON.stringify(state));
		await fs.writeFile(path.join(trialDir, LOCAL_TRIAL_FILES.answer), "SK-AAAAA carries a 5-year warranty.");
		if (options.runRecord !== false) {
			await fs.writeFile(path.join(runDir, RUN_RECORD_FILE), JSON.stringify({ variants: [{ name: "veyyon" }] }));
		}
		const journal = await openRunJournal(root, "run-1", "plan");
		await journal.append({
			cell,
			score: { reward: 0, partial: 0, error: null, usage: null, extra: {} },
			artifacts: { trialDir: options.recordedAt ?? trialDir, extra: { model: "p/m" } },
		});
		await journal.close();
		return runDir;
	}

	it("grades a finished run again from its trial files, with the suite as it is now", async () => {
		await using dir = await TempDir.create("@evals-kit-regrade-");
		const runDir = await warrantyRun(dir.path());

		const report = await kitReport(runDir, true);
		const summary = JSON.parse(await fs.readFile(path.join(runDir, "summary-regraded.json"), "utf8"));
		expect(path.basename(report)).toBe("report-regraded.md");
		expect(summary.arms).toMatchObject([{ arm: "veyyon", graded: 1, errors: 0, passes: 1 }]);
		expect(summary.model).toBe("p/m");
	});

	it("grades a run moved since it ran from the trial files under the directory it is read from", async () => {
		await using dir = await TempDir.create("@evals-kit-regrade-");
		// The directory the run recorded, on the host it ran on; nothing is there now.
		const recordedAt = path.join(dir.path(), "ran-here", "run-1", "veyyon", "shop-warranty-answer", "repeat-1");
		const runDir = await warrantyRun(dir.path(), { recordedAt });

		await kitReport(runDir, true);
		const summary = JSON.parse(await fs.readFile(path.join(runDir, "summary-regraded.json"), "utf8"));
		expect(summary.arms).toMatchObject([{ arm: "veyyon", graded: 1, errors: 0, passes: 1 }]);
	});

	it("refuses a run without its run record instead of taking a baseline from the settle order", async () => {
		await using dir = await TempDir.create("@evals-kit-regrade-");
		const runDir = await warrantyRun(dir.path(), { runRecord: false });
		for (const regrade of [false, true]) {
			await expect(kitReport(runDir, regrade)).rejects.toThrow(path.join(runDir, RUN_RECORD_FILE));
		}
		await expect(fs.readdir(runDir)).resolves.not.toContain("report.md");
	});

	it("counts passes within the budgets the suite declares, in the run's report and in a regrade", async () => {
		const budgets = browserSuite.spec.budgets;
		if (!budgets) throw new Error("the browser suite declares no budgets");
		// One pass at 60 turns, 1.5M tokens and 400 s: past every default ladder, inside the suite's.
		const spent = { turns: 60, tokens: 1_500_000, seconds: 400 };
		const within = (ladder: readonly number[], value: number) => ladder.map(budget => (value <= budget ? 1 : 0));
		for (const [measure, value] of Object.entries(spent) as [keyof typeof spent, number][]) {
			expect(within(DEFAULT_BUDGETS[measure], value)).not.toContain(1);
			expect(within(budgets[measure], value)).toContain(1);
		}
		await using dir = await TempDir.create("@evals-kit-budgets-");
		const runDir = dir.join("run-1");
		const journal = await openRunJournal(dir.path(), "run-1", "plan");
		await journal.append({
			cell: { variant: "veyyon", suite: "browser", task: "shop-warranty-answer", repeat: 0 },
			score: {
				reward: 1,
				partial: 1,
				error: null,
				usage: {
					inputTokens: spent.tokens,
					outputTokens: 0,
					durationSec: spent.seconds,
					extra: { turns: spent.turns },
				},
				extra: {},
			},
			artifacts: { extra: { model: "p/m" } },
		});
		await journal.close();
		const expected = {
			passesWithinTurns: within(budgets.turns, spent.turns),
			passesWithinTokens: within(budgets.tokens, spent.tokens),
			passesWithinSeconds: within(budgets.seconds, spent.seconds),
		};

		await browserSuite.writeRunReport?.({
			runDir,
			model: "p/m",
			tasks: ["shop-warranty-answer"],
			repeats: 1,
			variants: ["veyyon"],
		});
		const written = JSON.parse(await fs.readFile(path.join(runDir, "summary.json"), "utf8"));
		expect(written.budgets).toEqual(budgets);
		expect(written.arms[0]).toMatchObject(expected);

		await fs.writeFile(path.join(runDir, RUN_RECORD_FILE), JSON.stringify({ variants: [{ name: "veyyon" }] }));
		await kitReport(runDir, true);
		const regraded = JSON.parse(await fs.readFile(path.join(runDir, "summary-regraded.json"), "utf8"));
		expect(regraded.budgets).toEqual(budgets);
		expect(regraded.arms[0]).toMatchObject(expected);
	});

	it("labels a token budget of a million or more in millions", () => {
		const summary = summarizeKitRun([], { model: "p/m", tasks: [], repeats: 1, variants: [] }, "kit-probe", {
			turns: [10],
			tokens: [500_000, 1_000_000, 2_500_000],
			seconds: [60],
		});
		expect(renderKitReport(summary, {})).toContain("| arm | ≤ 500k | ≤ 1M | ≤ 2.5M |");
	});
});
