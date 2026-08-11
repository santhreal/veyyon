import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { SettingPath, SettingValue } from "@veyyon/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { RetryRecoveryMode } from "@veyyon/coding-agent/modes/retry-display";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@veyyon/coding-agent/task/renderer";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@veyyon/coding-agent/task/types";
import { useFullColor } from "../helpers/theme-assertions";

function runningProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "KeySettingsHotPaths",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "investigate hot paths",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function finishedResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "Agent",
		agent: "task",
		agentSource: "bundled",
		task: "investigate hot paths",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function detailsFor(progress: AgentProgress): TaskToolDetails {
	return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] };
}

function findRow(component: { render: (w: number) => readonly string[] }, needle: string): string {
	const row = component
		.render(120)
		.join("\n")
		.split("\n")
		.find(line => Bun.stripANSI(line).includes(needle));
	expect(row).toBeDefined();
	return row!;
}

describe("task progress rendering", () => {
	// The completed-row check asserts the label settles from accent to the
	// plain foreground: `toContain(theme.fg("text", ...))` paired with
	// `not.toContain(theme.fg("accent", ...))`. Both sides collapse to the same
	// bare text unless the ANSI policy is `full`, which makes the pair
	// self-contradictory, so the suite only held together by inheriting a
	// colour-capable terminal. Declare the dependency instead of inheriting it.
	useFullColor();
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});
	it("renders running task rows static with the agent dot", async () => {
		const theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "CountPackages", description: "List workspace packages" });

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"CountPackages",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);
		const strippedRow = Bun.stripANSI(rawRow0);

		expect(strippedRow).toContain(`${theme.status.done} CountPackages: List workspace packages`);
		expect(strippedRow).not.toContain(theme.symbol("tool.task"));
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
		expect(rawRow0).toBe(rawRow1);
	});

	// Regression: the ⟨agent⟩ type badge must survive past the streaming call
	// preview — it stays on live progress rows and on finished result rows, and
	// the generic `deep` worker stays bare.
	it("keeps the agent type badge on progress and result rows", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const badge = `${theme.format.bracketLeft}sonic${theme.format.bracketRight}`;

		const progressRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: detailsFor(runningProgress({ id: "SonicCount", agent: "sonic" })),
					},
					options,
					theme,
				),
				"SonicCount",
			),
		);
		expect(progressRow).toContain(badge);

		const resultDetails: TaskToolDetails = {
			projectAgentsDir: null,
			results: [finishedResult({ id: "SonicCount", agent: "sonic" })],
			totalDurationMs: 0,
		};
		const resultRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: resultDetails },
					{ expanded: false, isPartial: false },
					theme,
				),
				"SonicCount",
			),
		);
		expect(resultRow).toContain(badge);

		const genericRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: detailsFor(runningProgress({ id: "PlainWorker", agent: "deep" })),
					},
					options,
					theme,
				),
				"PlainWorker",
			),
		);
		expect(genericRow).not.toContain(`${theme.format.bracketLeft}deep${theme.format.bracketRight}`);
	});

	it("shows the spawn count without a joined agent-type list in the header", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "ScoutProbe", agent: "scout" }),
				runningProgress({ index: 1, id: "SonicCount", agent: "sonic" }),
			],
		};
		const header = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: true, spinnerFrame: 0 },
					theme,
				),
				"2 agents",
			),
		);
		expect(header).not.toContain("2 agents:");
		expect(header).not.toContain("scout, sonic");
	});

	it("keeps the agent dot when shimmer is disabled", async () => {
		const theme = (await getThemeByName("dark"))!;
		const settings = Settings.instance;
		const readSetting: Settings["get"] = settings.get.bind(settings);
		vi.spyOn(settings, "get").mockImplementation(<P extends SettingPath>(path: P): SettingValue<P> => {
			if (path === "display.shimmer") return "disabled" as SettingValue<P>;
			return readSetting(path);
		});
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };

		const strippedRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(runningProgress()) },
					options,
					theme,
				),
				"KeySettingsHotPaths",
			),
		);

		expect(strippedRow).toContain(`${theme.status.done} KeySettingsHotPaths`);
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
	});

	it("renders pending task rows with the agent dot, not the pending glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "BestGpt",
			status: "pending",
			description: "Combine winners for gpt",
		});

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"BestGpt",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);
		const strippedRow = Bun.stripANSI(rawRow0);

		expect(strippedRow).toContain(`${theme.status.done} BestGpt: Combine winners for gpt`);
		expect(strippedRow).not.toContain(theme.status.pending);
		expect(rawRow0).toBe(rawRow1);
	});

	it("settles completed rows to the foreground color with the same dot", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "DonePkg",
			status: "completed",
			description: "List workspace packages",
		});

		const row = findRow(
			taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
				options,
				theme,
			),
			"DonePkg",
		);

		const stripped = Bun.stripANSI(row);
		expect(stripped).toContain(`${theme.status.done} DonePkg: List workspace packages`);
		expect(stripped).not.toContain(theme.symbol("tool.task"));
		// Same dot as live rows; completion reads as the label settling from
		// accent to the plain foreground color.
		const titlePart = `${theme.bold("DonePkg")}: List workspace packages`;
		expect(row).toContain(theme.fg("text", titlePart));
		expect(row).not.toContain(theme.fg("accent", titlePart));
	});

	it("shows the dispatch glyph in the header while agents run, not a spinner", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const header = findRow(
			taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: detailsFor(runningProgress()) },
				options,
				theme,
			),
			"Task",
		);

		const stripped = Bun.stripANSI(header);
		expect(stripped).toContain(`${theme.symbol("tool.task")} Task`);
		expect(stripped).not.toContain(theme.status.running);
		expect(stripped).not.toContain(theme.getSpinnerFrames("status")[0]);
	});

	it("renders the task brief markdown inside the result frame", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "BestGpt", status: "pending", description: "Combine winners" });

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Spawned agent BestGpt..." }], details: detailsFor(progress) },
					options,
					theme,
					{ agent: "task", name: "BestGpt", task: "# Target\nCombine the winning patches." },
				)
				.render(120)
				.join("\n"),
		);

		// The brief stays visible for the whole task lifecycle, not just while
		// the call args stream in.
		expect(rendered).toContain("Target");
		expect(rendered).toContain("Combine the winning patches.");
	});

	it("pins unfinished tasks below finished ones, finished sorted by runtime asc", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "FirstRunning", status: "running", durationMs: 9000 }),
				runningProgress({ index: 1, id: "DoneSlow", status: "completed", durationMs: 5000 }),
				runningProgress({ index: 2, id: "StillPending", status: "pending" }),
				runningProgress({ index: 3, id: "FailedFast", status: "failed", durationMs: 1000 }),
			],
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		// Finished agents sorted by runtime ascending; pending/running stay at the
		// bottom in dispatch order.
		const positions = ["FailedFast", "DoneSlow", "FirstRunning", "StillPending"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("orders finalized results by runtime asc, matching the live view", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				finishedResult({ index: 0, id: "SlowFinish", durationMs: 9000 }),
				finishedResult({ index: 1, id: "FastFinish", durationMs: 1000 }),
				finishedResult({ index: 2, id: "MidFinish", durationMs: 4000 }),
			],
			totalDurationMs: 9000,
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		const positions = ["FastFinish", "MidFinish", "SlowFinish"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("folds collapsed progress lists to the live edge with a status summary", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "DoneOne", status: "completed", durationMs: 1000 }),
				runningProgress({ index: 1, id: "DoneTwo", status: "completed", durationMs: 2000 }),
				runningProgress({ index: 2, id: "DoneThree", status: "completed", durationMs: 3000 }),
				runningProgress({ index: 3, id: "LiveOne", status: "running" }),
				runningProgress({ index: 4, id: "LiveTwo", status: "running" }),
				runningProgress({ index: 5, id: "LiveThree", status: "pending" }),
				runningProgress({ index: 6, id: "LiveFour", status: "pending" }),
			],
		};
		const result = { content: [{ type: "text", text: "" }], details };

		const collapsed = Bun.stripANSI(
			taskToolRenderer
				.renderResult(result, { expanded: false, isPartial: true, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		// Finished rows fold into the summary; the live edge stays visible.
		for (const id of ["LiveOne", "LiveTwo", "LiveThree", "LiveFour"]) {
			expect(collapsed).toContain(id);
		}
		for (const id of ["DoneOne", "DoneTwo", "DoneThree"]) {
			expect(collapsed).not.toContain(id);
		}
		expect(collapsed).toContain("… 3 more agents (3 done)");
		// The summary line sits above the visible rows (live edge at the bottom).
		expect(collapsed.indexOf("more agents")).toBeLessThan(collapsed.indexOf("LiveOne"));

		const expanded = Bun.stripANSI(
			taskToolRenderer
				.renderResult(result, { expanded: true, isPartial: true, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		for (const id of ["DoneOne", "DoneTwo", "DoneThree", "LiveOne", "LiveFour"]) {
			expect(expanded).toContain(id);
		}
		expect(expanded).not.toContain("more agents");
	});

	it("keeps problem rows visible when the collapsed result list folds", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				finishedResult({ index: 0, id: "FastOne", durationMs: 1000 }),
				finishedResult({ index: 1, id: "FastTwo", durationMs: 2000 }),
				finishedResult({ index: 2, id: "FastThree", durationMs: 3000 }),
				finishedResult({ index: 3, id: "SlowOne", durationMs: 8000 }),
				finishedResult({ index: 4, id: "SlowTwo", durationMs: 9000 }),
				finishedResult({ index: 5, id: "SlowFailed", exitCode: 1, error: "boom", durationMs: 10000 }),
			],
			totalDurationMs: 10000,
		};

		const collapsed = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);
		// The failed agent claims a slot even though it finished last; the
		// slowest successes fold away instead.
		expect(collapsed).toContain("SlowFailed");
		for (const id of ["FastOne", "FastTwo", "FastThree"]) {
			expect(collapsed).toContain(id);
		}
		expect(collapsed).not.toContain("SlowOne");
		expect(collapsed).not.toContain("SlowTwo");
		expect(collapsed).toContain("… 2 more agents");
		// The run summary footer still counts the full batch.
		expect(collapsed).toContain("5 succeeded");
		expect(collapsed).toContain("1 failed");
	});

	// The user must be able to see the model of every subagent launched. The
	// resolved-model badge now defaults on, so a launched subagent's model id
	// shows in its status line without any opt-in.
	it("shows the resolved model badge on a running subagent by default", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "ModelShown",
			description: "do work",
			resolvedModel: "openai/gpt-5.6-sol:xhigh",
		});
		const row = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"ModelShown",
			),
		);
		// `provider/` is dropped and the thinking level is rendered as a SEPARATE themed token, not
		// as a `:level` suffix. `modelBadgeFromSelector` splits the selector on its last colon and
		// reprints the level through the theme precisely because the raw `provider/id:level`
		// spelling was the divergence it was written to remove, so asserting `:xhigh` here would
		// pin the behaviour that was deliberately deleted.
		expect(row).toContain("gpt-5.6-sol xhigh");
	});

	it("hides the resolved model badge when the setting is turned off", async () => {
		settings.set("subagent.showResolvedModelBadge", false);
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "ModelHidden",
			description: "do work",
			resolvedModel: "anthropic/claude-opus-4-8",
		});
		const row = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"ModelHidden",
			),
		);
		expect(row).not.toContain("claude-opus-4-8");
	});
});

describe("task result detail-less state", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders a validation failure with the error glyph, not a success bullet", async () => {
		const theme = (await getThemeByName("dark"))!;
		// The task-brief section renders markdown, which reads the active theme.
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: 'Validation failed for tool "task": task: Invalid input' }],
				isError: true,
			},
			options,
			theme,
			{ agent: "explore", task: "Look around." },
		);
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		// A failed task must surface the error glyph and never the "done" bullet.
		expect(stripped).toContain(theme.status.error);
		expect(stripped).not.toContain(theme.status.done);
		expect(stripped).toContain("Task");
		expect(stripped).toContain("explore");
		expect(stripped).toContain("Validation failed");
	});

	it("renders a detail-less success with the accent bullet, not an error glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult({ content: [{ type: "text", text: "done" }] }, options, theme, {
			agent: "explore",
			task: "Look around.",
		});
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		expect(stripped).toContain(theme.status.done);
		expect(stripped).not.toContain(theme.status.error);
	});
});

/**
 * WHY: the badge a parent shows when a child's recovery gives up used to read
 * `rate-limited` for every mode and every cause. `retryFailure` is set from
 * `auto_retry_end` whenever `success` is false, which covers a retry that
 * exhausted its attempts, a continuation that ran out of allowance, a
 * continuation the operator cancelled, and a continued turn that came back
 * empty. None of those is a quota window, and only one of them is even a
 * retry, so the badge named a cause nobody established and contradicted the
 * detail row directly beneath it, which has always said which recovery gave up.
 *
 * The class: a terminal recovery failure names the RECOVERY, never a guessed
 * cause. `RECOVERY_BADGES` is typed as a total map over `RetryRecoveryMode`, so
 * adding a third recovery mode fails `check:types` until its badge is decided
 * here rather than defaulting to whatever the last branch happened to say.
 *
 * What this does not catch: the wording itself. A future rename of both the
 * badge and this table stays green, which is correct, because the contract is
 * that the mode is distinguished and the cause is not invented.
 */
describe("a recovery that gives up names the recovery", () => {
	const RECOVERY_BADGES: Record<RetryRecoveryMode, string> = {
		retry: "retries gave up",
		continue: "continuation gave up",
	};

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	const failedRow = async (retryFailure: AgentProgress["retryFailure"]): Promise<string> => {
		const theme = (await getThemeByName("dark"))!;
		const progress = runningProgress({
			id: "GaveUp",
			status: "failed",
			retryFailure,
		});
		return Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					{ expanded: false, isPartial: false },
					theme,
				),
				"GaveUp",
			),
		);
	};

	for (const [mode, badge] of Object.entries(RECOVERY_BADGES) as [RetryRecoveryMode, string][]) {
		it(`badges a ${mode} that gave up with "${badge}", not a rate limit`, async () => {
			const row = await failedRow({
				attempt: 2,
				errorMessage: "stream error: NGHTTP2_INTERNAL_ERROR",
				mode,
			});

			expect(row).toContain(badge);
			expect(row).not.toContain("rate-limited");
		});
	}

	// An absent mode is the documented default (a retry), and it has to render
	// as one: every event emitted before the continuation path existed omits it.
	it("treats an absent mode as a retry", async () => {
		const row = await failedRow({ attempt: 3, errorMessage: "429 Too Many Requests" });

		expect(row).toContain(RECOVERY_BADGES.retry);
		expect(row).not.toContain("rate-limited");
	});

	// The mode has to survive the subprocess boundary, or a settled background
	// task loses it: `SingleResult` is what crosses back, and the parent copies
	// its `retryFailure` straight onto the progress row it renders.
	it("carries the mode across a settled background result", async () => {
		const settled = finishedResult({
			exitCode: 1,
			retryFailure: { attempt: 2, errorMessage: "stream closed mid-batch", mode: "continue" },
		});
		const row = await failedRow(settled.retryFailure);

		expect(row).toContain(RECOVERY_BADGES.continue);
	});

	// The badge and the detail row beneath it must agree; the detail row is the
	// one that was already right, so it is the one the badge is measured against.
	it("agrees with the detail row about which recovery gave up", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const progress = runningProgress({
			id: "Disagree",
			status: "failed",
			retryFailure: { attempt: 2, errorMessage: "stream closed mid-batch", mode: "continue" },
		});
		const stripped = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);

		expect(stripped).toContain("continuation gave up after 2 attempts");
		expect(stripped).not.toContain("auto-retry gave up");
		expect(stripped).not.toContain("rate-limited");
	});
});
