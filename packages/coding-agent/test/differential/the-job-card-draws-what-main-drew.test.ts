/**
 * The job card draws what main's renderer drew.
 *
 * Every arm a `job` call passes through is compared as terminal bytes: the pending row of a poll, a
 * cancel, a list and a bare call; the snapshot of jobs still running beside jobs that failed and
 * settled; the live agents that sit outside job control; a snapshot longer than a collapsed card
 * shows; the sealed poll that collapses to nothing; and the fallback a result with neither a job nor
 * an agent in it falls back to. FIVE DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived
 * silently:
 *
 *  - A job's rows sit two columns under the row that heads them, where main opened every row with a
 *    dim tree branch and every continuation row with the branch's own continuation prefix. The tree
 *    was terminal chrome; each row still opens with its own state mark, which is what marks the set.
 *  - What a collapsed card held back is one note the host words, where main drew the count on the
 *    closing branch of each tree it cut -- one for the jobs and a second for the agents.
 *  - The header row is cut without an ellipsis, because the host composed it to fit, where main cut
 *    every row of the card alike.
 *  - A cut row closes its colour after the ellipsis, where main cut with a hard reset before it.
 *  - The fallback card's second row carries the mark alone, where main drew the whole card as one
 *    multi-line `Text` and that component re-emits the SGR carry of the row above at the start of the
 *    next one, so the row opened with two empty colour runs.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never calls `execute()`, so nothing here proves which jobs the
 * manager holds, what a poll waited for or what a cancel ended: `test/tools/job-waiting-poll.test.ts`
 * and `test/tools/job-cancels-an-agent-with-no-job.test.ts` own that, and a `details` shape whose
 * meaning changed would be drawn identically by both arms. Shimmer is
 * `disabled` under the harness settings, which is the shipped default, so the sweep a running job's
 * label takes is not compared here -- both arms read the same `shimmerEnabled()` and the sweep's phase
 * is wall-clock, so two arms drawn microseconds apart could never be equal bytes.
 * `a-job-card-states-what-is-still-running.test.ts` owns what the card claims.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { AgentActivitySnapshot, JobSnapshot, JobToolDetails } from "@veyyon/coding-agent/tools/shell/job";
import { type JobRenderArgs, type JobViewResult, jobToolView } from "@veyyon/coding-agent/tools/shell/job-view";
import { Ellipsis } from "@veyyon/natives";
import { truncateToWidth } from "@veyyon/utils/width";
import { jobToolRenderer } from "../oracles/job-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

const WIDTHS = [200, WIDTH, 40];

/** The frames a comparison is taken on: no frame at all, an even one and an odd one. */
const FRAMES = [undefined, 0, 3] as const;

/** The columns a card's rows sit in under the row that heads them. */
const BLOCK_INDENT = 2;

/** A width no fixture reaches, so a render at it is the card before any cut. */
const UNCUT = 400;

/** The rows a collapsed card shows before it holds anything back. */
const COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

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

function result(details: JobToolDetails, text = "jobs"): JobViewResult {
	return { content: [{ type: "text", text }], details };
}

function hostOptions(expanded: boolean, frame: number | undefined, partial = false): RenderResultOptions {
	return { expanded, isPartial: partial, spinnerFrame: frame };
}

function viewResult(
	value: JobViewResult,
	args: JobRenderArgs | undefined,
	expanded: boolean,
	frame: number | undefined,
	width: number,
	partial = false,
): string[] {
	return renderCompLines(
		drawToolView(jobToolView.renderResult(value, { expanded, partial, frame }, args), theme, frame),
		width,
	);
}

function oracleResult(
	value: JobViewResult,
	args: JobRenderArgs | undefined,
	expanded: boolean,
	frame: number | undefined,
	width: number,
	partial = false,
): string[] {
	return renderCompLines(
		jobToolRenderer.renderResult(
			{ ...value, content: value.content ?? [] },
			hostOptions(expanded, frame, partial),
			theme,
			args,
		),
		width,
	);
}

/**
 * The tree prefixes main opened a row with, longest first so a match is unambiguous.
 *
 * Read from the theme rather than spelled: the glyphs are a preset's, and a suite that hardcoded
 * `├─` would pass on the ASCII preset while comparing nothing.
 */
function treePrefixes(): string[] {
	return [
		`${theme.fg("dim", theme.tree.branch)} `,
		`${theme.fg("dim", theme.tree.last)} `,
		theme.fg("dim", `${theme.tree.vertical}  `),
		theme.fg("dim", "   "),
	];
}

/** The columns a tree prefix spends, which every one of them spends alike. */
const TREE_PREFIX_WIDTH = 3;

/**
 * The oracle's rows as a headed block lays them out.
 *
 * Three host policies move a row, and each is applied to the oracle rather than waived:
 *
 *  - The block heads its rows and cuts that header without an ellipsis, because it composed the row
 *    to fit; main cut every row alike, ellipsis and all. The oracle's header is therefore re-cut from
 *    an uncut render with the host's own policy.
 *  - Every row the block holds sits at the block's indent, where main opened it with a tree prefix of
 *    the same visible width. The prefix is dropped and the indent put in its place.
 *  - A row's own text has the columns its prefix leaves, and the two prefixes are one column apart, so
 *    the oracle is rendered one column wider than the view. The comparison stays byte for byte
 *    instead of becoming a comparison of trimmed prefixes.
 */
function asHostRows(renderAt: (width: number) => string[], width: number): string[] {
	const head = truncateToWidth(renderAt(UNCUT)[0] ?? "", width, Ellipsis.Omit);
	const prefixes = treePrefixes();
	const rows = renderAt(width - BLOCK_INDENT + TREE_PREFIX_WIDTH).slice(1);
	return [
		head,
		...rows.map(row => {
			const prefix = prefixes.find(candidate => row.startsWith(candidate));
			if (prefix === undefined) return row;
			return `${" ".repeat(BLOCK_INDENT)}${row.slice(prefix.length)}`;
		}),
	];
}

/**
 * The oracle's cut rows closed the way the host closes them.
 *
 * `truncateToWidth` ends a cut row with a hard reset before the ellipsis (`ESC[0m…`), which drops
 * every open attribute rather than the one colour the row opened; the host cuts the span's text, so
 * the ellipsis draws inside the row's colour and the colour closes after it. Every column before the
 * cut is still compared byte for byte.
 */
function closedAfterCut(rows: readonly string[]): string[] {
	return rows.map(row => (row.endsWith("\x1b[0m…") ? `${row.slice(0, -"\x1b[0m…".length)}…\x1b[39m` : row));
}

/** Every result arm of one snapshot, at every width, disclosure state and frame. */
function compareResult(
	value: JobViewResult,
	args: JobRenderArgs | undefined,
	options: { partial?: boolean; rowsPinnedElsewhere?: number } = {},
): void {
	for (const width of WIDTHS) {
		for (const expanded of [false, true]) {
			for (const frame of FRAMES) {
				const view = viewResult(value, args, expanded, frame, width, options.partial);
				const oracle = asHostRows(at => oracleResult(value, args, expanded, frame, at, options.partial), width);
				const pinned = options.rowsPinnedElsewhere ?? 0;
				const compared = pinned === 0 ? oracle : oracle.slice(0, oracle.length - pinned);
				expect(view.slice(0, compared.length)).toEqual(closedAfterCut(compared));
			}
		}
	}
}

const MIXED: JobToolDetails = {
	jobs: [
		job(),
		job({ id: "job_2", status: "completed", label: "build the addon", durationMs: 91_000, resultText: "ok\ndone" }),
		job({ id: "job_3", status: "failed", label: "lint", durationMs: 800, errorText: "1 error\nsecond line" }),
		job({ id: "job_4", status: "cancelled", label: "stale poll", durationMs: 15_000 }),
	],
	agents: [agent(), agent({ id: "Reviewer", parentId: undefined, activity: undefined, ageMs: 900 })],
};

describe("job tool differential", () => {
	it("draws the pending row of every call shape", () => {
		const calls: JobRenderArgs[] = [
			{ list: true },
			{ poll: ["job_1"] },
			{ poll: ["job_1", "job_2"] },
			{ cancel: ["job_9"] },
			{ cancel: ["job_9", "job_8"], poll: ["job_1"] },
			{},
		];
		for (const args of calls) {
			for (const width of WIDTHS) {
				for (const frame of FRAMES) {
					const view = renderCompLines(
						drawToolView(jobToolView.renderCall(args, { expanded: false, frame }), theme, frame),
						width,
					);
					const oracle = renderCompLines(
						jobToolRenderer.renderCall(args, hostOptions(false, frame), theme),
						width,
					);
					expect(view).toEqual(closedAfterCut(oracle));
				}
			}
		}
	});

	it("draws a snapshot of jobs and live agents", () => {
		compareResult(result(MIXED), { list: true });
	});

	it("draws a partial poll whose jobs are all still running", () => {
		compareResult(
			result({ jobs: [job(), job({ id: "job_2", durationMs: 60_000 })] }),
			{ poll: ["job_1", "job_2"] },
			{
				partial: true,
			},
		);
	});

	it("draws a settled poll that kept only what stopped running", () => {
		compareResult(
			result({
				jobs: [job(), job({ id: "job_2", status: "completed", label: "job_2", durationMs: 30_000 })],
			}),
			{ poll: ["job_1", "job_2"] },
		);
	});

	it("draws a cancel that reports the jobs it ended", () => {
		compareResult(
			result({
				jobs: [job({ id: "job_7", status: "cancelled", label: "sleep 900", durationMs: 3000 })],
				cancelled: [{ id: "job_7", status: "cancelled" }],
			}),
			{ cancel: ["job_7"] },
		);
	});

	it("draws a job whose label runs over several lines", () => {
		compareResult(
			result({
				jobs: [
					job({
						id: "job_long",
						status: "completed",
						label: ["first line of the label", "second line", "third line", "fourth line"].join("\n"),
						durationMs: 2_000,
						resultText: '{\n  "ok": true,\n  "rows": 12\n}',
					}),
				],
			}),
			{ list: true },
		);
	});

	it("draws a job whose label is its own id", () => {
		compareResult(
			result({ jobs: [job({ id: "AuthLoader", type: "task", label: "AuthLoader", status: "running" })] }),
			{ list: true },
			{ partial: true },
		);
	});

	it("draws a snapshot longer than a collapsed card shows, above the held-back note", () => {
		const jobs = Array.from({ length: COLLAPSED_ITEMS + 4 }, (_unused, index) =>
			job({ id: `job_${index}`, status: "completed", label: `task ${index}`, durationMs: 1000 * (index + 1) }),
		);
		// The last row of each arm is the count it held back, whose wording is the exception cell below.
		compareResult(result({ jobs }), { list: true }, { rowsPinnedElsewhere: 1 });
	});

	it("draws nothing for a sealed poll whose every job is still running", () => {
		const value = result({ jobs: [job(), job({ id: "job_2" })] });
		for (const width of WIDTHS) {
			for (const expanded of [false, true]) {
				const view = viewResult(value, { poll: ["job_1", "job_2"] }, expanded, 1, width);
				const oracle = oracleResult(value, { poll: ["job_1", "job_2"] }, expanded, 1, width);
				expect(view).toEqual(oracle);
				expect(view.join("")).toBe("");
			}
		}
	});

	/**
	 * EXCEPTION CELL. The tree is gone: a row sits at the block's indent and opens with its own state
	 * mark, where main opened it with a dim branch glyph. Both arms are asserted against their own
	 * bytes, so the difference is recorded rather than transformed away by the helper above.
	 */
	it("states each row at the host's indent, where main opened it with a tree branch", () => {
		const value = result(MIXED);
		const args: JobRenderArgs = { list: true };
		const view = viewResult(value, args, true, undefined, UNCUT);
		const oracle = oracleResult(value, args, true, undefined, UNCUT);
		expect(oracle[1]?.startsWith(`${theme.fg("dim", theme.tree.branch)} `)).toBe(true);
		expect(view[1]?.startsWith("  ")).toBe(true);
		expect(view[1]?.slice(BLOCK_INDENT)).toBe(oracle[1]?.slice(`${theme.fg("dim", theme.tree.branch)} `.length));
		// A continuation row: main carried the branch's own continuation prefix, the host carries none.
		const continued = oracle.findIndex(row => row.startsWith(theme.fg("dim", `${theme.tree.vertical}  `)));
		expect(continued).toBeGreaterThan(1);
		expect(view[continued]?.startsWith("    ")).toBe(true);
	});

	/**
	 * EXCEPTION CELL. What a collapsed card held back is one note in the host's own words, where main
	 * wrote the count itself on the closing branch of every tree it cut.
	 */
	it("states one held-back note, where main drew a count per tree", () => {
		const jobs = Array.from({ length: COLLAPSED_ITEMS + 2 }, (_unused, index) =>
			job({ id: `job_${index}`, status: "completed", label: `task ${index}`, durationMs: 1000 }),
		);
		const agents = Array.from({ length: COLLAPSED_ITEMS + 3 }, (_unused, index) => agent({ id: `Agent${index}` }));
		const value = result({ jobs, agents });
		const args: JobRenderArgs = { list: true };

		const view = viewResult(value, args, false, undefined, UNCUT);
		const oracle = oracleResult(value, args, false, undefined, UNCUT);
		// Main: one closing row per cut tree, in its own words, with no gesture for seeing the rest.
		const mainNotes = oracle.filter(row => row.includes("more"));
		expect(mainNotes).toHaveLength(2);
		expect(mainNotes[0]).toContain("… 2 more jobs");
		expect(mainNotes[1]).toContain("… 3 more agents");
		// The view: one note, the count of both, with the gesture the host names.
		const hostNotes = view.filter(row => row.includes("more"));
		expect(hostNotes).toHaveLength(1);
		expect(hostNotes[0]).toContain("… 5 more");
		expect(hostNotes[0]).toContain("expand");
		// A card that cut only one of the two sets names it.
		const jobsOnly = viewResult(result({ jobs }), args, false, undefined, UNCUT);
		expect(jobsOnly.filter(row => row.includes("more"))[0]).toContain("… 2 more jobs");
		const agentsOnly = viewResult(result({ jobs: [job()], agents }), args, false, undefined, UNCUT);
		expect(agentsOnly.filter(row => row.includes("more"))[0]).toContain("… 3 more agents");
		// Expanded, both arms hold nothing back at all.
		expect(viewResult(value, args, true, undefined, UNCUT).filter(row => row.includes("more"))).toEqual([]);
	});

	/**
	 * EXCEPTION CELL. The header is the host's row, so it is cut without an ellipsis; main cut it with
	 * one, because it cut every row of the card the same way.
	 */
	it("cuts the header without an ellipsis, where main cut it with one", () => {
		const value = result(MIXED);
		const args: JobRenderArgs = { list: true };
		const narrow = 24;
		const view = viewResult(value, args, false, undefined, narrow);
		const oracle = oracleResult(value, args, false, undefined, narrow);
		expect(oracle[0]?.endsWith("…")).toBe(true);
		expect(view[0]?.endsWith("…")).toBe(false);
		expect(view[0]).toBe(
			truncateToWidth(oracleResult(value, args, false, undefined, UNCUT)[0] ?? "", narrow, Ellipsis.Omit),
		);
	});

	/**
	 * EXCEPTION CELL. The fallback card's second row carries the mark alone. Main drew the card as one
	 * multi-line `Text`, and that component re-emits the SGR carry of the row above at the start of the
	 * next row, so main's row opened with the header's two colours as empty runs.
	 */
	it("draws the fallback card without the carry main's multi-line Text re-emitted", () => {
		const value: JobViewResult = { content: [{ type: "text", text: "No jobs to process" }], details: { jobs: [] } };
		// A colour opened and closed with nothing drawn between: the shape a re-emitted carry takes.
		const emptyRuns = /^(?:\x1b\[[0-9;]+m\x1b\[39m)+/;
		for (const args of [{ list: true }, { poll: ["job_1"] }, undefined]) {
			for (const width of WIDTHS) {
				const view = viewResult(value, args, false, 1, width);
				const oracle = oracleResult(value, args, false, 1, width);
				expect(view[0]).toBe(oracle[0]);
				const carry = emptyRuns.exec(oracle[1] ?? "")?.[0] ?? "";
				// The header carried two colours, so the carry is two empty runs.
				expect(carry.split("\x1b[39m").length - 1).toBe(2);
				expect(emptyRuns.test(view[1] ?? "")).toBe(false);
				expect(view[1]).toBe(`${" ".repeat(BLOCK_INDENT)}${oracle[1]?.slice(carry.length)}`);
			}
		}
	});

	it("falls back to the tool's own text when a result carries no details", () => {
		const value: JobViewResult = { content: [{ type: "text", text: "nothing to report" }] };
		const view = viewResult(value, { list: true }, false, undefined, WIDTH);
		const oracle = oracleResult(value, { list: true }, false, undefined, WIDTH);
		expect(view[0]).toBe(oracle[0]);
		expect(view[1]).toContain("nothing to report");
	});
});
