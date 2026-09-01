/**
 * An eval card states the code that ran, what it printed, and what it spawned.
 *
 * WHY THIS SUITE EXISTS. `eval` is the one tool whose card is a program: the source is the subject of
 * the row, the output belongs under the cell that produced it, and a cell that spawns subagents or
 * calls prelude helpers reports both while it is still running. The tool describes all of it as a
 * `ToolView`, so every claim below drives the view and hands it to the terminal drawer, which is the
 * path a session takes.
 *
 * THE DEFECT CLASS THIS CLOSES. A card that loses part of a run: a cell whose source is not stated as
 * source in its own language, a collapsed cell that shows the START of a stream instead of its live
 * edge, a wall of progress lines that spends the whole window and pushes the interesting line out of
 * it, a spawned subagent that never reaches the card or reaches it without the tool it is in, a helper
 * call whose earlier siblings are dropped silently, a failed cell drawn as a successful one, and a
 * JSON display, notice or truncation warning that is computed and never stated. Every backend of
 * `EvalLanguage` and every member of a cell's own status union is swept through a total record, so a
 * new backend or a new cell state fails the type check here rather than drawing as Python.
 *
 * WHAT IT DOES NOT CATCH. Nothing here runs a kernel: which backend a call resolves to, what a cell
 * printed and how a timeout is clamped are `eval.ts`'s contracts. Byte equivalence with the renderer
 * this card replaced -- including the framing the conversion deliberately changed -- is
 * `test/differential/the-eval-card-draws-what-main-drew.test.ts`. How wide a host's window is, and
 * what glyph it marks a state with, are the terminal's.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@veyyon/coding-agent/theme/theme";
import { previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";
import { type EvalRenderArgs, evalToolView, type EvalViewResult } from "@veyyon/coding-agent/tools/shell/eval-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import type { FramedBlockView, ToolView, ToolViewContext, ViewSection, ViewStatus } from "@veyyon/view";

const WIDTH = 100;

let uiTheme: Theme;

function context(overrides: Partial<ToolViewContext> = {}): ToolViewContext {
	return { expanded: false, partial: false, ...overrides };
}

function cell(overrides: Partial<EvalCellResult> = {}): EvalCellResult {
	return {
		index: 0,
		code: "print('hi')",
		language: "python",
		output: "hi",
		status: "complete",
		durationMs: 1200,
		...overrides,
	};
}

function result(details: EvalToolDetails | undefined, text = ""): EvalViewResult {
	return { content: [{ type: "text", text }], details };
}

/** The card as the tool states it, before any host draws it. */
function view(details: EvalToolDetails | undefined, ctx = context(), text = ""): ToolView {
	return evalToolView.renderResult(result(details, text), ctx, undefined);
}

/** The same card as a framed block, or a failure naming what arrived instead. */
function framed(details: EvalToolDetails | undefined, ctx = context(), text = ""): FramedBlockView {
	const drawn = view(details, ctx, text);
	if (drawn.kind !== "framedBlock") throw new Error(`expected a framed block, got ${drawn.kind}`);
	return drawn;
}

/** The rows the terminal draws for a result card, as the words a reader sees. */
function rows(details: EvalToolDetails | undefined, ctx = context(), width = WIDTH, text = ""): string[] {
	return drawToolView(view(details, ctx, text), uiTheme, ctx.frame)
		.render(width)
		.map(line => stripAnsi(line).trimEnd());
}

/** The rows the terminal draws for a pending call. */
function callRows(args: EvalRenderArgs, ctx = context(), width = WIDTH): string[] {
	return drawToolView(evalToolView.renderCall(args, ctx), uiTheme, ctx.frame)
		.render(width)
		.map(line => stripAnsi(line).trimEnd());
}

/** The section carrying one label, or nothing when the card states none. */
function section(block: FramedBlockView, label: string): ViewSection | undefined {
	return block.sections.find(entry => entry.label === label);
}

function sectionText(entry: ViewSection | undefined): string {
	return (entry?.lines ?? []).map(line => line.map(span => span.text).join("")).join("\n");
}

describe("an eval card states code and output", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(loaded);
	});

	it("says the kernel is waiting when no code has arrived yet", () => {
		const drawn = evalToolView.renderCall({}, context());
		expect(drawn.kind).toBe("statusRow");
		expect(callRows({})[0]).toContain(">>>");
	});

	/**
	 * Every backend, through a total record: a new member of `EvalLanguage` fails the type check here
	 * instead of being highlighted as Python, which is what the fallback in the view would do.
	 */
	it("states each backend's source in the language a host highlights it by", () => {
		const highlighted: Record<EvalLanguage, string> = {
			python: "python",
			js: "javascript",
			ruby: "ruby",
			julia: "julia",
		};
		for (const [language, expected] of Object.entries(highlighted) as Array<[EvalLanguage, string]>) {
			const block = framed({ cells: [cell({ language, code: "x = 1" })] });
			expect(block.sections[0]?.code?.language).toBe(expected);
			expect(block.header.language).toBe(expected);
			expect(sectionText(block.sections[0])).toBe("x = 1");
		}
		// The same mapping on the way in, where the schema's own tokens are the shorter spelling.
		const tokens: Record<string, string> = { py: "python", js: "javascript", rb: "ruby", jl: "julia" };
		for (const [token, expected] of Object.entries(tokens)) {
			const call = evalToolView.renderCall({ language: token, code: "x = 1" }, context());
			if (call.kind !== "framedBlock") throw new Error("expected a framed block");
			expect(call.sections[0]?.code?.language).toBe(expected);
		}
	});

	/** Every cell state, through a total record over the union the tool reports. */
	it("reports the state of each cell, and the worst of them as the card's own", () => {
		// A settled cell is a cell that FINISHED, which is `done`; `success` is the mark a card that ran
		// a check draws, and main drew `done` for a complete cell.
		const marks: Record<EvalCellResult["status"], ViewStatus> = {
			complete: "done",
			error: "error",
			running: "running",
			pending: "pending",
		};
		for (const [status, expected] of Object.entries(marks) as Array<[EvalCellResult["status"], ViewStatus]>) {
			expect(framed({ cells: [cell({ status })] }).state).toBe(expected);
		}
		// A failure outranks anything still going, and anything still going outranks a settled cell.
		expect(framed({ cells: [cell({ status: "complete" }), cell({ status: "error" })] }).state).toBe("error");
		expect(framed({ cells: [cell({ status: "complete" }), cell({ status: "running" })] }).state).toBe("running");
		expect(framed({ cells: [cell({ status: "complete" }), cell({ status: "pending" })] }).state).toBe("pending");
		// A card the host is still streaming reports as arriving whatever the cells claim.
		expect(framed({ cells: [cell()] }, context({ partial: true })).state).toBe("running");
	});

	it("names each cell of a multi-cell call, and heads the card with how many there are", () => {
		const block = framed({
			cells: [cell({ title: "imports" }), cell({ index: 1, title: "load config", code: "cfg = load()" })],
		});
		expect(block.header.title).toBe("2 cells");
		expect(block.sections[0]?.label).toBe("[1/2] imports");
		expect(section(block, "[2/2] load config")).toBeDefined();
		// One cell is titled by what it is, and an untitled one by what it holds.
		expect(framed({ cells: [cell({ title: "imports" })] }).header.title).toBe("imports");
		expect(framed({ cells: [cell({ title: undefined })] }).header.title).toBe("Code");
	});

	it("shows the live edge of a long cell, and the whole source once opened", () => {
		const total = previewWindowRows() + 5;
		const code = Array.from({ length: total }, (_unused, index) => `value_${index} = ${index}`).join("\n");
		const first = "value_0 = 0";
		const last = `value_${total - 1} = ${total - 1}`;

		// Collapsed: the tool states the whole source and says the END is what matters, so the host --
		// the only party that knows the width and the rows it has -- drops the front and says so.
		const collapsed = framed({ cells: [cell({ code, output: "" })] });
		expect(collapsed.sections[0]?.tail).toBeDefined();
		expect(sectionText(collapsed.sections[0])).toContain(first);
		const drawn = rows({ cells: [cell({ code, output: "" })] }, context(), 120).join("\n");
		expect(drawn).toContain(last);
		expect(drawn).toContain("earlier line");
		expect(drawn).not.toContain(first);

		// Opened: every line, and no window note left over.
		const opened = rows({ cells: [cell({ code, output: "" })] }, context({ expanded: true }), 120).join("\n");
		expect(opened).toContain(first);
		expect(opened).toContain(last);
		expect(opened).not.toContain("earlier line");

		// The pending preview is bounded the same way, so a cell never snaps open when it settles.
		const pending = callRows({ language: "py", code }, context(), 120).join("\n");
		expect(pending).toContain(last);
		expect(pending).toContain("earlier line");
		expect(pending).not.toContain(first);
	});

	it("states a cell's output under its code, toned by whether the cell failed", () => {
		const ok = framed({ cells: [cell({ output: "42" })] });
		expect(sectionText(section(ok, "Output"))).toBe("42");
		expect(section(ok, "Output")?.lines[0]?.[0]?.tone).toBe("output");
		const failed = framed({ cells: [cell({ status: "error", output: "Traceback: boom" })] });
		expect(section(failed, "Output")?.lines[0]?.[0]?.tone).toBe("error");
		// A cell with nothing to show states no output group at all.
		expect(section(framed({ cells: [cell({ output: "   " })] }), "Output")).toBeUndefined();
	});

	it("states a markdown display as a document rather than as toned output", () => {
		const md = framed({ cells: [cell({ output: "# Title\n\nbody", hasMarkdown: true })] });
		expect(section(md, "Output")?.markdown).toBe(true);
		// A cell that FAILED carries its error text verbatim, whatever it emitted before it failed.
		const failed = framed({ cells: [cell({ status: "error", output: "# not a heading", hasMarkdown: true })] });
		expect(section(failed, "Output")?.markdown).toBeUndefined();
	});

	it("condenses a run of progress lines before the host measures its window", () => {
		const capture = [
			...Array.from({ length: 40 }, (_unused, index) => `Compiling crate_${index} v0.1.0`),
			"warning: unused variable `x`",
		];
		const collapsed = framed({ cells: [cell({ output: capture.join("\n") })] });
		const text = sectionText(section(collapsed, "Output"));
		expect(text).toContain("+39 earlier");
		expect(text).toContain("warning: unused variable `x`");
		expect(text.split("\n").filter(line => line.includes("Compiling"))).toHaveLength(1);
		// Opened, every counted-away line comes back and the count is gone.
		const opened = sectionText(section(framed({ cells: [cell({ output: capture.join("\n") })] }, context({ expanded: true })), "Output"));
		expect(opened.split("\n").filter(line => line.includes("Compiling"))).toHaveLength(40);
		expect(opened).not.toContain("+39 earlier");
	});

	it("keeps the newest helper calls and says how many earlier ones it held back", () => {
		const events: EvalStatusEvent[] = [
			{ op: "read", chars: 120, path: "/repo/src/app.ts" },
			{ op: "ls", count: 3, items: ["a.ts", "b.ts", "c.ts"] },
			{ op: "git_status", clean: false, staged: 1, modified: 2, branch: "main" },
			{ op: "log", message: "phase two" },
			{ op: "write", chars: 40, path: "/repo/out.json" },
		];
		const collapsed = section(framed({ cells: [cell({ statusEvents: events })] }), "Status");
		expect(collapsed?.list).toBe(true);
		expect(collapsed?.hidden?.count).toBe(2);
		expect(collapsed?.hidden?.noun).toEqual({ one: "call", many: "calls" });
		const kept = sectionText(collapsed);
		expect(kept).toContain("git_status");
		expect(kept).toContain("2 modified");
		expect(kept).toContain("phase two");
		expect(kept).not.toContain("read");

		// Opened: every call, plus what each one listed or read.
		const opened = section(framed({ cells: [cell({ statusEvents: events })] }, context({ expanded: true })), "Status");
		expect(opened?.hidden).toBeUndefined();
		const all = sectionText(opened);
		expect(all).toContain("120 chars");
		expect(all).toContain("from /repo/src/app.ts");
		expect(all).toContain("a.ts");
		expect(all).toContain("c.ts");
	});

	it("names a helper call that failed rather than describing what it did", () => {
		const failed = sectionText(
			section(framed({ cells: [cell({ statusEvents: [{ op: "read", error: "ENOENT: missing.txt" }] })] }), "Status"),
		);
		expect(failed).toContain("read");
		expect(failed).toContain("ENOENT: missing.txt");
	});

	it("lists what an expanded call read, and says how much more there was", () => {
		const preview = Array.from({ length: 6 }, (_unused, index) => `line ${index}`).join("\n");
		const opened = sectionText(
			section(framed({ cells: [cell({ statusEvents: [{ op: "cat", files: 2, chars: 80, preview }] })] }, context({ expanded: true })), "Status"),
		);
		expect(opened).toContain("2 files");
		expect(opened).toContain("line 0");
		expect(opened).toContain("line 2");
		expect(opened).toContain("3 more lines");
		expect(opened).not.toContain("line 3");
	});

	it("states a spawned subagent with the tool it is in and the intent it stated", () => {
		const running: EvalStatusEvent = {
			op: "agent",
			id: "AuthLoader",
			status: "running",
			currentTool: "read",
			lastIntent: "reading src/auth.ts",
			toolCount: 7,
			contextTokens: 47_000,
			contextWindow: 200_000,
			cost: 0.42,
		};
		const agents = section(framed({ cells: [cell({ statusEvents: [running] })] }), "Agents");
		const text = sectionText(agents);
		expect(text).toContain("AuthLoader");
		expect(text).toContain("7 tools");
		expect(text).toContain("47K/200K");
		expect(text).toContain("$0.42");
		expect(text).toContain("read: reading src/auth.ts");
		expect(agents?.lines[0]?.[0]?.status).toBe("running");
		// A helper call in the same cell still lands in its own group rather than among the agents.
		const both = framed({ cells: [cell({ statusEvents: [running, { op: "log", message: "spawned" }] })] });
		expect(sectionText(section(both, "Status"))).toContain("spawned");
		expect(sectionText(section(both, "Agents"))).not.toContain("spawned");
	});

	it("states what a settled subagent cost and how each failure ended", () => {
		const done = section(
			framed({
				cells: [
					cell({
						statusEvents: [
							{ op: "agent", id: "Done", status: "completed", durationMs: 9000, toolCount: 3 },
							{ op: "agent", id: "Broke", status: "failed", durationMs: 500 },
							{ op: "agent", id: "Stopped", status: "aborted", durationMs: 400 },
						],
					}),
				],
			}),
			"Agents",
		);
		const text = sectionText(done);
		expect(text).toContain("Done");
		expect(text).toContain("9.0s");
		expect(text).toContain("failed");
		expect(text).toContain("aborted");
		expect(done?.lines.map(line => line[0]?.status)).toEqual(["done", "error", "aborted"]);
	});

	it("states a subagent's task while it has no tool and no intent to report", () => {
		const text = sectionText(
			section(
				framed({ cells: [cell({ statusEvents: [{ op: "agent", id: "Fresh", status: "running", taskPreview: "port the loader" }] })] }),
				"Agents",
			),
		);
		expect(text).toContain("port the loader");
	});

	it("states what a call displayed, what it noticed, and what it truncated", () => {
		const block = framed({
			cells: [cell()],
			jsonOutputs: [{ ok: true }, { rows: [1, 2] }],
			notice: "python unavailable, ran on js",
			meta: {
				truncation: {
					direction: "head",
					truncatedBy: "lines",
					totalLines: 900,
					totalBytes: 90_000,
					outputLines: 100,
					outputBytes: 10_000,
					shownRange: { start: 1, end: 100 },
				},
			},
		});
		const trailing = block.sections[block.sections.length - 1];
		const text = sectionText(trailing);
		expect(text).toContain("display[1]");
		expect(text).toContain("display[2]");
		expect(text).toContain("ok");
		expect(text).toContain("python unavailable, ran on js");
		expect(text).toContain("900");
		expect(trailing?.lines.some(line => line.some(span => span.tone === "warning"))).toBe(true);
		// A single display is not labelled, since there is nothing to tell it apart from.
		expect(sectionText(framed({ cells: [cell()], jsonOutputs: [{ ok: true }] }).sections.at(-1))).not.toContain("display[1]");
	});

	it("states the returned text as the card when no cell ran", () => {
		const drawn = view({ statusEvents: [{ op: "log", message: "kernel down" }] }, context(), "eval failed to start");
		expect(drawn.kind).toBe("headedBlock");
		const text = rows({ statusEvents: [{ op: "log", message: "kernel down" }] }, context(), WIDTH, "eval failed to start").join("\n");
		expect(text).toContain("eval failed to start");
		expect(text).toContain("kernel down");
	});

	it("holds a long cell-less result to a window and says what came before it", () => {
		const text = Array.from({ length: 60 }, (_unused, index) => `out ${index}`).join("\n");
		const collapsed = rows(undefined, context(), WIDTH, text).join("\n");
		expect(collapsed).toContain("out 59");
		expect(collapsed).toContain("earlier line");
		expect(collapsed).not.toContain("out 0\n");
		const opened = rows(undefined, context({ expanded: true }), WIDTH, text).join("\n");
		expect(opened).toContain("out 0");
		expect(opened).not.toContain("earlier line");
	});

	it("keeps every row inside the columns the host gave it", () => {
		const long = "x".repeat(400);
		for (const width of [40, 80, 200]) {
			const drawn = rows(
				{
					cells: [cell({ code: long, output: long, statusEvents: [{ op: "agent", id: "A".repeat(80), status: "running" }] })],
					notice: long,
				},
				context(),
				width,
			);
			for (const row of drawn) expect(row.length).toBeLessThanOrEqual(width);
		}
	});
});
