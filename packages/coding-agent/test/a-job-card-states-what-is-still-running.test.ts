/**
 * A job card states what is still running, what settled, and what each job returned.
 *
 * WHY THIS SUITE EXISTS. The job tool is how a turn watches its own background work, and the card is
 * the only place that work is visible: which jobs are still going, which failed, what each one
 * returned and which live agents sit outside job control entirely. The tool describes that as a
 * `ToolView`, so the claims below drive the view and hand it to the terminal drawer, which is the path
 * a session takes.
 *
 * THE DEFECT CLASS THIS CLOSES. A card that loses a job: a snapshot that drops a row, a sealed poll
 * that keeps a stale waiting frame or drops a settled one, an agent folded into the job counts, a
 * failure whose text never reaches the card, a collapsed card that holds rows back without saying so,
 * and a row that overruns the columns the host gave it. Every job state is asserted, not the one that
 * came to mind, and the counts are read back per category.
 *
 * WHAT IT DOES NOT CATCH. Nothing here executes the tool: which jobs the manager holds, what a poll
 * waited for and what a cancel ended are `job.ts`'s own contracts, covered by
 * `test/tools/job-waiting-poll.test.ts` and `test/tools/job-cancels-an-agent-with-no-job.test.ts`.
 * Byte equivalence with the renderer this card replaced is
 * `test/differential/the-job-card-draws-what-main-drew.test.ts`, and how a shimmer sweep looks is the
 * terminal's.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { getThemeByName, setThemeInstance, type Theme } from "@veyyon/coding-agent/theme/theme";
import {
	type AgentActivitySnapshot,
	COLLAPSED_LIST_LIMIT,
	type JobSnapshot,
	type JobToolDetails,
} from "@veyyon/coding-agent/tools/shell/job";
import { type JobRenderArgs, type JobViewResult, jobToolView } from "@veyyon/coding-agent/tools/shell/job-view";
import { prompt } from "@veyyon/utils";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import type { ToolView, ToolViewContext, ViewLine } from "@veyyon/view";

const WIDTH = 100;

let uiTheme: Theme;

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		id: "job_1",
		type: "bash",
		status: "running",
		label: "bun test packages/coding-agent",
		durationMs: 4200,
		...overrides,
	};
}

function agent(overrides: Partial<AgentActivitySnapshot> = {}): AgentActivitySnapshot {
	return { id: "AuthLoader", parentId: "Main", activity: "reading src/auth.ts", ageMs: 12_000, ...overrides };
}

function context(overrides: Partial<ToolViewContext> = {}): ToolViewContext {
	return { expanded: false, partial: false, ...overrides };
}

/** The result card as the terminal draws it, sanitized to the words a reader sees. */
function rows(
	details: JobToolDetails | undefined,
	args: JobRenderArgs | undefined,
	ctx: ToolViewContext,
	options: { text?: string; width?: number } = {},
): string[] {
	const result: JobViewResult = { content: [{ type: "text", text: options.text ?? "jobs" }], details };
	const view = jobToolView.renderResult(result, ctx, args);
	return drawToolView(view, uiTheme, ctx.frame)
		.render(options.width ?? WIDTH)
		.map(line => stripAnsi(line).trimEnd());
}

/** The card as the tool states it, before any host draws it. */
function view(
	details: JobToolDetails | undefined,
	args: JobRenderArgs | undefined,
	ctx: ToolViewContext,
	text = "jobs",
): ToolView {
	return jobToolView.renderResult({ content: [{ type: "text", text }], details }, ctx, args);
}

/** The pending row as the terminal draws it. */
function callRow(args: JobRenderArgs, ctx: ToolViewContext = context()): string {
	return stripAnsi(
		drawToolView(jobToolView.renderCall(args, ctx), uiTheme, ctx.frame).render(WIDTH)[0] ?? "",
	).trimEnd();
}

describe("a job card states what is still running", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(loaded);
	});

	it("names what the call is waiting on, for every shape of call", () => {
		expect(callRow({ list: true })).toContain("background jobs");
		expect(callRow({ poll: ["job_1"] })).toContain("poll job_1");
		expect(callRow({ poll: ["job_1", "job_2"] })).toContain("poll 2 jobs");
		expect(callRow({ cancel: ["job_9"] })).toContain("cancel job_9");
		expect(callRow({ cancel: ["job_9", "job_8"] })).toContain("cancel 2 jobs");
		expect(callRow({ cancel: ["job_9"], poll: ["job_1"] })).toContain("cancel job_9, poll job_1");
		expect(callRow({})).toContain("all running jobs");
	});

	it("reports how many jobs are still going, and how the rest ended", () => {
		const details: JobToolDetails = {
			jobs: [
				job(),
				job({ id: "job_2", status: "completed", label: "build" }),
				job({ id: "job_3", status: "failed", label: "lint" }),
				job({ id: "job_4", status: "cancelled", label: "stale" }),
			],
		};
		const header = rows(details, { list: true }, context())[0] ?? "";
		expect(header).toContain("waiting on 1 of 4 jobs");
		expect(header).toContain("1 done");
		expect(header).toContain("1 failed");
		expect(header).toContain("1 cancelled");
	});

	it("says every job is waited on when every job is running", () => {
		const details: JobToolDetails = { jobs: [job(), job({ id: "job_2" })] };
		expect(rows(details, { poll: ["job_1", "job_2"] }, context({ partial: true }))[0]).toContain("waiting on 2 jobs");
	});

	it("says a snapshot is settled when nothing is running", () => {
		const details: JobToolDetails = { jobs: [job({ status: "completed" }), job({ id: "job_2", status: "failed" })] };
		expect(rows(details, { list: true }, context())[0]).toContain("2 jobs settled");
	});

	it("counts live agents outside the job counts, and says so when there are no jobs", () => {
		const withJobs = rows({ jobs: [job()], agents: [agent(), agent({ id: "Reviewer" })] }, { list: true }, context());
		expect(withJobs[0]).toContain("waiting on 1 job");
		expect(withJobs[0]).toContain("2 agents");
		const agentsOnly = rows({ jobs: [], agents: [agent()] }, { list: true }, context());
		expect(agentsOnly[0]).toContain("1 running agent");
		expect(agentsOnly[0]).toContain("no jobs");
		// The agent's own row states what it was doing and who spawned it.
		expect(agentsOnly[1]).toContain("AuthLoader");
		expect(agentsOnly[1]).toContain("⟦agent⟧");
		expect(agentsOnly[1]).toContain("reading src/auth.ts");
		expect(agentsOnly[1]).toContain("← Main");
	});

	it("states each job's id, kind, label and elapsed time on its own row", () => {
		const row = rows({ jobs: [job({ type: "task", durationMs: 91_000 })] }, { list: true }, context())[1] ?? "";
		expect(row).toContain("job_1");
		expect(row).toContain("⟦task⟧");
		expect(row).toContain("bun test packages/coding-agent");
		expect(row).toContain("1m31s");
	});

	it("drops the id column when a job's label is already its id", () => {
		const row =
			rows(
				{ jobs: [job({ id: "AuthLoader", label: "AuthLoader", type: "task" })] },
				undefined,
				context({ partial: true }),
			)[1] ?? "";
		expect(row.split("AuthLoader")).toHaveLength(2);
	});

	it("marks every job state differently", () => {
		const marks = new Set<string>();
		for (const status of ["running", "completed", "failed", "cancelled"] as const) {
			const row =
				rows({ jobs: [job({ status, label: status })] }, { list: true }, context({ partial: true }))[1] ?? "";
			marks.add(row.trimStart().slice(0, 1));
		}
		expect(marks.size).toBe(4);
	});

	it("carries a failure's text on the job's own row, and a result's text under it", () => {
		const failed = rows(
			{ jobs: [job({ id: "job_3", status: "failed", label: "lint", errorText: "1 error in src/app.ts" })] },
			{ list: true },
			context(),
		);
		expect(failed[2]).toContain("1 error in src/app.ts");
		const done = rows(
			{ jobs: [job({ id: "job_2", status: "completed", label: "build", resultText: "addon built" })] },
			{ list: true },
			context(),
		);
		expect(done[2]).toContain("addon built");
	});

	it("flattens a structured result onto the one line a collapsed card has for it", () => {
		const resultText = '{\n  "ok": true,\n  "rows": 12\n}';
		const collapsed = rows({ jobs: [job({ status: "completed", resultText })] }, { list: true }, context());
		expect(collapsed).toHaveLength(3);
		expect(collapsed[2]).toContain('{ "ok": true, "rows": 12 }');
	});

	it("shows more of a job's label and its output when the card is opened", () => {
		const details: JobToolDetails = {
			jobs: [
				job({
					status: "completed",
					label: ["first", "second", "third", "fourth"].join("\n"),
					resultText: ["one", "two", "three", "four", "five"].join("\n"),
				}),
			],
		};
		const collapsed = rows(details, { list: true }, context());
		expect(collapsed[1]).toContain("first");
		expect(collapsed[1]).toContain("…");
		expect(collapsed).toHaveLength(3);
		const expanded = rows(details, { list: true }, context({ expanded: true }));
		expect(expanded[1]).toContain("first");
		expect(expanded[2]).toContain("second");
		expect(expanded[3]).toContain("third");
		// Three label lines, then four preview lines, under the header.
		expect(expanded).toHaveLength(8);
		expect(expanded[7]).toContain("four");
	});

	it("says how many rows a collapsed card held back, and holds none back when opened", () => {
		const jobs = Array.from({ length: COLLAPSED_LIST_LIMIT + 3 }, (_unused, index) =>
			job({ id: `job_${index}`, status: "completed", label: `task ${index}` }),
		);
		const collapsed = rows({ jobs }, { list: true }, context());
		expect(collapsed).toHaveLength(COLLAPSED_LIST_LIMIT + 2);
		expect(collapsed.at(-1)).toContain("3 more jobs");
		expect(collapsed.at(-1)).toContain("expand");
		const expanded = rows({ jobs }, { list: true }, context({ expanded: true }));
		expect(expanded).toHaveLength(jobs.length + 1);
		expect(expanded.at(-1)).not.toContain("more");
	});

	it("names the unit it held back, and states a bare count when it cut both sets", () => {
		const jobs = Array.from({ length: COLLAPSED_LIST_LIMIT + 2 }, (_unused, index) =>
			job({ id: `job_${index}`, status: "completed" }),
		);
		const agents = Array.from({ length: COLLAPSED_LIST_LIMIT + 1 }, (_unused, index) =>
			agent({ id: `Agent${index}` }),
		);
		expect(rows({ jobs }, { list: true }, context()).at(-1)).toContain("2 more jobs");
		expect(rows({ jobs: [job()], agents }, { list: true }, context()).at(-1)).toContain("1 more agent");
		const both = rows({ jobs, agents }, { list: true }, context()).at(-1) ?? "";
		expect(both).toContain("… 3 more ");
		expect(both).not.toContain("jobs");
		expect(both).not.toContain("agents");
	});

	it("drops a sealed poll whose every job is still running, and keeps it while it streams", () => {
		const details: JobToolDetails = { jobs: [job(), job({ id: "job_2" })] };
		expect(rows(details, { poll: ["job_1", "job_2"] }, context()).join("")).toBe("");
		expect(rows(details, { poll: ["job_1", "job_2"] }, context({ partial: true })).length).toBe(3);
	});

	it("keeps a sealed poll's settled rows and drops the running ones beside them", () => {
		const details: JobToolDetails = {
			jobs: [job(), job({ id: "job_2", status: "completed", label: "build" })],
		};
		const sealed = rows(details, { poll: ["job_1", "job_2"] }, context());
		expect(sealed).toHaveLength(2);
		expect(sealed[0]).toContain("1 job settled");
		expect(sealed[1]).toContain("build");
	});

	it("keeps every row of a list and of a cancel-only call, running ones included", () => {
		const details: JobToolDetails = { jobs: [job(), job({ id: "job_2", status: "cancelled", label: "stale" })] };
		expect(rows(details, { list: true }, context())).toHaveLength(3);
		expect(rows(details, { cancel: ["job_2"] }, context())).toHaveLength(3);
		// A cancel that also polls is a poll, so its still-running rows collapse once sealed.
		expect(rows({ jobs: [job()] }, { cancel: ["job_2"], poll: ["job_1"] }, context()).join("")).toBe("");
	});

	it("keeps a snapshot that carries agents, however the call was made", () => {
		const details: JobToolDetails = { jobs: [job()], agents: [agent()] };
		expect(rows(details, { poll: ["job_1"] }, context())).toHaveLength(3);
	});

	it("falls back to the tool's own text when a result carries no job and no agent", () => {
		const empty = rows({ jobs: [] }, { list: true }, context(), { text: "No jobs to process" });
		expect(empty[0]).toContain("background jobs");
		expect(empty[1]).toContain("No jobs to process");
		const noDetails = rows(undefined, { poll: ["job_1"] }, context(), { text: "nothing to report" });
		expect(noDetails[1]).toContain("nothing to report");
	});

	it("sorts the running jobs first, then the failures, then what settled", () => {
		const details: JobToolDetails = {
			jobs: [
				job({ id: "job_done", status: "completed", label: "done", durationMs: 1000 }),
				job({ id: "job_cancelled", status: "cancelled", label: "cancelled", durationMs: 1000 }),
				job({ id: "job_failed", status: "failed", label: "failed", durationMs: 1000 }),
				job({ id: "job_running", status: "running", label: "running", durationMs: 1000 }),
			],
		};
		const drawn = rows(details, { list: true }, context({ partial: true }));
		expect(drawn[1]).toContain("running");
		expect(drawn[2]).toContain("failed");
		expect(drawn[3]).toContain("cancelled");
		expect(drawn[4]).toContain("done");
	});

	it("puts the longest-running job first among jobs in the same state", () => {
		const details: JobToolDetails = {
			jobs: [
				job({ id: "job_short", label: "short", durationMs: 1000 }),
				job({ id: "job_long", label: "long", durationMs: 90_000 }),
			],
		};
		const drawn = rows(details, { list: true }, context({ partial: true }));
		expect(drawn[1]).toContain("long");
		expect(drawn[2]).toContain("short");
	});

	it("cuts a long label and a long preview at the columns each is budgeted, marking the cut", () => {
		const details: JobToolDetails = {
			jobs: [job({ status: "completed", label: "x".repeat(200), resultText: "y".repeat(400) })],
		};
		const drawn = rows(details, { list: true }, context(), { width: 200 });
		expect(drawn[1]?.match(/x+…/)?.[0]).toHaveLength(60);
		expect(drawn[2]?.match(/y+…/)?.[0]).toHaveLength(80);
	});

	it("says a job has no label rather than leaving the row's words blank", () => {
		const row = rows({ jobs: [job({ label: "" })] }, { list: true }, context({ partial: true }))[1] ?? "";
		expect(row).toContain("(no label)");
	});

	it("states a running label as live only where the surface repaints", () => {
		const running = job({ label: "compiling" });
		const labelSpan = (frame: number | undefined): ViewLine[number] | undefined => {
			const card = view({ jobs: [running] }, { list: true }, context({ frame }));
			if (card.kind !== "headedBlock") throw new Error(`expected a card, got ${card.kind}`);
			return card.lines[0]?.find(span => span.text === "compiling");
		};
		expect(labelSpan(3)?.live).toBe(true);
		expect(labelSpan(undefined)?.live).toBeUndefined();
		const settled = view(
			{ jobs: [job({ status: "completed", label: "compiling" })] },
			{ list: true },
			context({ frame: 3 }),
		);
		if (settled.kind !== "headedBlock") throw new Error(`expected a card, got ${settled.kind}`);
		expect(settled.lines[0]?.find(span => span.text === "compiling")?.live).toBeUndefined();
	});

	it("shows a failure's text rather than the output the job managed before it", () => {
		const drawn = rows(
			{ jobs: [job({ status: "failed", errorText: "exit 1", resultText: "12 tests passed" })] },
			{ list: true },
			context(),
		);
		expect(drawn[2]).toContain("exit 1");
		expect(drawn.join("\n")).not.toContain("12 tests passed");
	});

	it("shows an agent's own words rather than the envelope it returned them in", () => {
		const resultText = '<task-result status="ok">\n<output>\nmigrated 4 callsites\n</output>\n</task-result>';
		const drawn = rows(
			{ jobs: [job({ id: "AuthLoader", type: "task", label: "AuthLoader", status: "completed", resultText })] },
			{ list: true },
			context(),
		);
		expect(drawn[2]).toContain("migrated 4 callsites");
		expect(drawn.join("\n")).not.toContain("task-result");
	});

	it("shows the body of the envelope the task prompt actually writes, in both its shapes", () => {
		const envelope = (preview: string, truncated: boolean): string =>
			prompt.render(PROMPTS["tools/task-summary"].text, {
				agentName: "task",
				id: "SpawnProbe",
				status: "completed",
				duration: "8.7s",
				preview,
				truncated,
				meta: { lineCount: 3, charSize: "120 B" },
				mergeSummary: "",
			});
		const delivered = `${envelope("Probe finished: spawned worker, ping ok.", false)}\n\nSpawnProbe is now idle — message it via \`irc\` to follow up; transcript at history://SpawnProbe`;
		for (const [resultText, body] of [
			[delivered, "Probe finished: spawned worker, ping ok."],
			[envelope("first line of long output", true), "first line of long output"],
		] as const) {
			const drawn = rows(
				{ jobs: [job({ id: "SpawnProbe", type: "task", label: "SpawnProbe", status: "completed", resultText })] },
				{ list: true },
				context({ expanded: true }),
			).join("\n");
			expect(drawn).toContain(body);
			expect(drawn).not.toContain("<task-result");
			expect(drawn).not.toContain("<output>");
			expect(drawn).not.toContain("<preview");
		}
	});

	it("states an agent-only roster's count once, in its title", () => {
		const header =
			rows({ jobs: [], agents: [agent(), agent({ id: "Reviewer" })] }, { list: true }, context())[0] ?? "";
		expect(header).toContain("2 running agents");
		expect(header.match(/agent/g)).toHaveLength(1);
	});

	it("holds no row and no header at all when a sealed poll's every job is still running", () => {
		const details: JobToolDetails = { jobs: [job()] };
		for (const args of [{ poll: ["job_1"] }, undefined]) {
			const card = view(details, args, context());
			if (card.kind !== "textBlock") throw new Error(`expected an empty block, got ${card.kind}`);
			expect(card.spans.map(span => span.text).join("")).toBe("");
		}
	});

	it("keeps every row inside the columns the host gave it", () => {
		const details: JobToolDetails = {
			jobs: [job({ label: "x".repeat(300), resultText: "y".repeat(300) })],
			agents: [agent({ id: "A".repeat(80), activity: "z".repeat(300) })],
		};
		for (const width of [40, 60, WIDTH]) {
			for (const expanded of [false, true]) {
				for (const row of rows(details, { list: true }, context({ expanded, partial: true }), { width })) {
					expect(row.length).toBeLessThanOrEqual(width);
				}
			}
		}
	});
});
