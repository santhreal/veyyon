/**
 * WHY: a kit suite grades a trial from two files, the `state.json` its services' `finish` wrote and
 * the `answer.txt` the backend wrote, so a finished run can be graded again after a check is fixed.
 * A grade that read live objects instead, a state file that went missing silently, a catalog whose
 * task names an unknown capability, or a seed that depended on the arm would each skew every
 * comparison without failing a run. These cases drive `defineSuite` end to end on a one-task suite
 * whose site counts presses: prepare, solve over HTTP, finish, write the answer, score.
 *
 * Not caught: the local-cli backend's own part (writing `answer.txt`, the sandbox); its suite
 * covers that.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { kitTask } from "../../engine/kit/catalog";
import { answerHasNumber } from "../../engine/kit/checks";
import { FormClient } from "../../engine/kit/form-client";
import { summarizeKitRun } from "../../engine/kit/report";
import { defineSuite, KIT_FILES, trialSeed } from "../../engine/kit/suite";
import { hostSite, text } from "../../engine/kit/web-host";
import { LOCAL_TRIAL_FILES } from "../../engine/run/layout";
import type { TrialResultRecord } from "../../engine/run/record";

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

	it("pairs arms only on trials both graded, and counts passes within each budget", () => {
		const summary = summarizeKitRun(
			[
				record("main", "a", 1, 90_000, 12),
				record("head", "a", 1, 40_000, 4),
				record("main", "b", 0, 200_000, 30),
				record("head", "b", 1, 60_000, 8),
				record("main", "c", 1, 50_000, 6),
				record("head", "c", null, 0, 0),
			],
			{ model: "p/m", tasks: ["a", "b", "c"], repeats: 1 },
			"kit-probe",
		);
		const [pair] = summary.paired;
		expect(pair).toMatchObject({ baseline: "main", candidate: "head", pairs: 2, wins: 1, losses: 0, bothPassed: 1 });
		expect(pair?.tokens).toEqual({ baseline: 290_000, candidate: 100_000 });
		const head = summary.arms.find(arm => arm.arm === "head");
		expect([head?.graded, head?.errors, head?.passes]).toEqual([2, 1, 2]);
		expect(head?.passesWithinTurns).toEqual([1, 2, 2, 2]);
		expect(head?.byCapability).toEqual({ forms: { passes: 2, graded: 2 } });
	});
});
