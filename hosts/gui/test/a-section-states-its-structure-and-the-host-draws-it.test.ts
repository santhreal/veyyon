/**
 * WHY THIS EXISTS.
 *
 * The reason the tool cards were welded to the terminal was structure, not colour: a card drew its
 * own elbow glyphs, counted its own gutter width, and cut its own lines to a column count it read
 * off the screen. Every one of those decisions is a host's, and a section states the structure
 * instead -- these lines are a tree, these are a change, this many were held back, show the end.
 *
 * The class this closes is a section member the model states and a host silently drops, which is
 * how a card ends up drawing the thing itself again "because the host does not handle it". Every
 * member of `ViewSection`, both block kinds and the notice are drawn here, and each is asserted on
 * the structure a second host has to expose for a stylesheet to lay it out.
 *
 * WHAT IT DOES NOT CATCH. The terminal's own answers to the same members -- its gutter arithmetic
 * and its connector glyphs are pinned by the differential suites next to it -- and any question
 * about how the markup LOOKS once a stylesheet is on it, which no assertion here can see.
 */

import { describe, expect, it } from "bun:test";
import type { ViewLine } from "@veyyon/view";
import { drawFramedBlock, drawHeadedBlock, drawNotice, drawStatusRow, drawTextBlock } from "../src/draw-tool-view";
import { STATUS_CLASSES, VIEW_DIFF_SIDES, VIEW_STATUSES } from "../src/tokens";

/** Numbered rows, as a tool that has read a file states them. */
function lines(...texts: readonly string[]): readonly ViewLine[] {
	return texts.map(text => [{ text }]);
}

describe("a status row", () => {
	it("answers every status the contract declares, and marks the live ones live", () => {
		for (const status of VIEW_STATUSES) {
			const drawn = drawStatusRow({ kind: "statusRow", status, title: "Read" });
			expect(drawn).toContain(`data-status="${status}"`);
			expect(drawn).toContain(STATUS_CLASSES[status]);
		}

		const running = drawStatusRow({ kind: "statusRow", status: "running", title: "Read" });
		const settled = drawStatusRow({ kind: "statusRow", status: "success", title: "Read" });
		expect(running).toContain('data-live="true"');
		expect(settled).not.toContain("data-live");
	});

	it("draws an emblem in place of the status mark when the embedder has that icon", () => {
		const view = { kind: "statusRow", status: "running", title: "Task", emblem: "agent.deep" } as const;
		const withIcon = drawStatusRow(view, { symbols: { "agent.deep": "&#9679;" } });
		const without = drawStatusRow(view);

		expect(withIcon).toContain('data-emblem="agent.deep"');
		expect(withIcon).not.toContain("v-mark");
		expect(without).toContain("v-mark");
	});

	it("carries the badge, the language and the meta entries a row states", () => {
		const drawn = drawStatusRow({
			kind: "statusRow",
			status: "success",
			title: "Bash",
			description: "bun run check",
			badge: { label: "cached", tone: "muted" },
			language: "sh",
			meta: [[{ text: "2.1s" }], [{ text: "exit 0" }]],
		});

		expect(drawn).toContain("cached");
		expect(drawn).toContain('data-language="sh"');
		expect(drawn.split('class="v-meta-entry"').length - 1).toBe(2);
	});

	/**
	 * A path is cut by whoever knows the width, and in a document that is the stylesheet. The host
	 * carries the tool's answer as a mark and keeps every character of the path either way.
	 */
	it("keeps a whole description and states whether the tool said it fits", () => {
		const path = "/repo/packages/coding-agent/src/modes/terminal/components/tool-execution.ts";
		const fits = drawStatusRow({ kind: "statusRow", title: "Read", description: path, descriptionFits: true });
		const not = drawStatusRow({ kind: "statusRow", title: "Read", description: path });

		expect(fits).toContain(path);
		expect(not).toContain(path);
		expect(fits).toContain("v-fits");
		expect(not).not.toContain("v-fits");
	});

	it("names the file a description points at, and follows its link only when the scheme is safe", () => {
		const located = drawStatusRow({
			kind: "statusRow",
			title: "Read",
			description: "app.ts",
			descriptionFile: "/repo/src/app.ts",
			descriptionFileLine: 12,
		});
		const unsafe = drawStatusRow({
			kind: "statusRow",
			title: "Open",
			description: "here",
			descriptionLink: "javascript:alert(1)",
		});

		expect(located).toContain('data-file="/repo/src/app.ts"');
		expect(located).toContain('data-file-line="12"');
		expect(unsafe).not.toContain("<a ");
		expect(unsafe).toContain("here");
	});
});

describe("a section states its structure and the host draws it", () => {
	it("numbers a code window by where it sits in the file", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{
					lines: lines("const a = 1;", "const b = 2;"),
					code: { language: "typescript", firstLineNumber: 40, totalLines: 400, lead: "$ read src/app.ts" },
				},
			],
		});

		expect(drawn).toContain('data-language="typescript"');
		expect(drawn).toContain('data-line="40"');
		expect(drawn).toContain('data-line="41"');
		expect(drawn).toContain('data-total-lines="400"');
		expect(drawn).toContain("$ read src/app.ts");
	});

	/**
	 * Several windows onto one file is the shape a hardcoded `first + index` gutter gets wrong, and
	 * a `null` entry is a row standing in for what was elided.
	 */
	it("numbers each row of a several-window read by its own number", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("a", "…", "b"), code: { lineNumbers: [5, null, 960] } }],
		});

		expect(drawn).toContain('data-line="5"');
		expect(drawn).toContain('data-line="960"');
		expect(drawn.split("<li").length - 1).toBe(3);
	});

	it("marks every side of a change the contract declares", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{
					lines: lines("kept", "gone", "new", "…"),
					diff: { sides: [...VIEW_DIFF_SIDES].reverse(), path: "src/app.ts" },
				},
			],
		});

		for (const side of VIEW_DIFF_SIDES) expect(drawn).toContain(`data-side="${side}"`);
		expect(drawn).toContain('data-path="src/app.ts"');
	});

	it("draws a change rather than source when a section contradicts itself", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("-gone"), diff: { sides: ["removed"] }, code: { language: "typescript" } }],
		});

		expect(drawn).toContain("v-diff");
		expect(drawn).not.toContain("v-code");
	});

	it("states where a tree row sits, and draws no connector glyph of its own", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{
					lines: lines("src", "app.ts", "detail"),
					tree: { depth: [0, 1, 1], opens: [true, true, false], last: [false, true, true] },
				},
			],
		});

		expect(drawn).toContain('data-depth="0"');
		expect(drawn).toContain('data-depth="1"');
		expect(drawn).toContain('data-opens="true"');
		expect(drawn).toContain('data-opens="false"');
		expect(drawn).toContain('data-last="true"');
		for (const glyph of ["└", "├", "│", "─"]) expect(drawn).not.toContain(glyph);
	});

	it("draws a list section as list rows", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("one", "two"), list: true }],
		});

		expect(drawn).toContain("v-list");
		expect(drawn.split('class="v-item"').length - 1).toBe(2);
	});

	it("renders a markdown section as a document rather than as its source", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: [[{ text: "# Title" }], [{ text: "body **bold**" }]], markdown: true }],
		});

		expect(drawn).toContain("<h1");
		expect(drawn).toContain("<strong>bold</strong>");
		expect(drawn).not.toContain("# Title");
	});

	it("escapes the markup inside a document a model wrote", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: [[{ text: "<script>alert(1)</script>" }]], markdown: true }],
		});

		expect(drawn).not.toContain("<script>");
		expect(drawn).toContain("&lt;script&gt;");
	});

	/**
	 * A tail window is the END of a run of output. The rows the tool allowed survive, the ones before
	 * them are stated as a count rather than dropped in silence, and the two terminal-only members
	 * change nothing here because a document has no viewport to spend.
	 */
	it("keeps the end of a windowed section and says how much came before", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("1", "2", "3", "4", "5"), tail: { max: 2 } }],
		});

		expect(drawn).toContain("4");
		expect(drawn).toContain("5");
		expect(drawn).toContain('data-dropped="3"');
		expect(drawn).toContain("3 earlier lines");
	});

	it("keeps every row when the window is the host's to choose", () => {
		const viewportOnly = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("1", "2", "3"), tail: { viewport: true, reserve: 4 } }],
		});

		expect(viewportOnly).not.toContain("data-dropped");
		for (const row of ["1", "2", "3"]) expect(viewportOnly).toContain(row);
	});

	it("marks an atomic row rather than cutting it to a width nobody gave", () => {
		const long = "x".repeat(400);
		const drawn = drawFramedBlock({ kind: "framedBlock", sections: [{ lines: lines(long), clip: true }] });

		expect(drawn).toContain("v-clip");
		expect(drawn).toContain(long);
	});

	it("offers a gesture for a hold-back that can be revealed and states the rest as a sentence", () => {
		const revealable = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{ lines: lines("1"), hidden: { count: 4, revealable: true, noun: { one: "file", many: "files" } } },
			],
		});
		const closed = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{ lines: lines("1"), hidden: { count: 1, revealable: false, noun: { one: "file", many: "files" } } },
			],
		});
		const none = drawFramedBlock({
			kind: "framedBlock",
			sections: [{ lines: lines("1"), hidden: { count: 0, revealable: true } }],
		});

		expect(revealable).toContain("<button");
		expect(revealable).toContain("4 more files");
		expect(closed).not.toContain("<button");
		expect(closed).toContain("1 more file");
		expect(none).not.toContain("v-hidden");
	});

	it("divides a later section from the one above it and never the first", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			sections: [
				{ lines: lines("brief"), separator: true },
				{ lines: lines("work"), separator: true },
			],
		});

		expect(drawn.split('data-separator="true"').length - 1).toBe(1);
	});

	it("labels a group when the tool named one", () => {
		const drawn = drawFramedBlock({ kind: "framedBlock", sections: [{ label: "output", lines: lines("ok") }] });

		expect(drawn).toContain("<h3");
		expect(drawn).toContain("output");
	});
});

describe("a block carries what the card is", () => {
	it("states a frame's state, its contents and its gutter", () => {
		const drawn = drawFramedBlock({
			kind: "framedBlock",
			state: "error",
			contents: "listing",
			gutter: true,
			sections: [{ lines: lines("no such file") }],
		});

		expect(drawn).toContain('data-state="error"');
		expect(drawn).toContain('data-contents="listing"');
		expect(drawn).toContain('data-gutter="true"');
	});

	it("reads a frame with no stated contents as a report", () => {
		expect(drawFramedBlock({ kind: "framedBlock", sections: [] })).toContain('data-contents="report"');
	});

	it("draws a headed block with its header, its rows and its hold-back and no frame", () => {
		const drawn = drawHeadedBlock({
			kind: "headedBlock",
			header: { kind: "statusRow", status: "success", title: "Search" },
			lines: lines("src/app.ts", "src/cli.ts"),
			hidden: { count: 8, revealable: true, noun: { one: "match", many: "matches" } },
		});

		expect(drawn).toContain("v-headed");
		expect(drawn).not.toContain("v-framed");
		expect(drawn).toContain("src/cli.ts");
		expect(drawn).toContain("8 more matches");
	});

	it("windows a headed block's rows the way a section's are windowed", () => {
		const drawn = drawHeadedBlock({
			kind: "headedBlock",
			lines: lines("1", "2", "3"),
			tail: { max: 1 },
		});

		expect(drawn).toContain('data-dropped="2"');
		expect(drawn).toContain("3");
	});

	it("draws a text block as one paragraph", () => {
		const drawn = drawTextBlock({ kind: "textBlock", spans: [{ text: "waiting" }, { text: " …", tone: "muted" }] });

		expect(drawn.startsWith("<p")).toBe(true);
		expect(drawn).toContain("waiting");
	});
});

describe("a notice", () => {
	it("is announced as an alert when it reports a failure and as a status otherwise", () => {
		const failed = drawNotice({ kind: "notice", state: "error", headline: [{ text: "rejected" }] });
		const warned = drawNotice({ kind: "notice", state: "warning", headline: [{ text: "slow" }] });

		expect(failed).toContain('role="alert"');
		expect(warned).toContain('role="status"');
		expect(failed).toContain(STATUS_CLASSES.error);
	});

	/**
	 * The whole notice is one state, so a tone on a span inside it is the tool overriding the state
	 * it just set. The contract lets a host ignore it, and ignoring it is what keeps an error notice
	 * from carrying a success-coloured word.
	 */
	it("ignores a tone inside it and keeps the emphasis", () => {
		const drawn = drawNotice({
			kind: "notice",
			state: "error",
			headline: [{ text: "the edit was rejected", tone: "success", bold: true }],
		});

		expect(drawn).not.toContain("v-tone-success");
		expect(drawn).toContain("<strong>");
	});

	it("draws its mark, its tag and its body when it has them", () => {
		const drawn = drawNotice(
			{
				kind: "notice",
				state: "info",
				mark: "hint.tip",
				tag: "hashline",
				headline: [{ text: "re-read the file" }],
				body: [[{ text: "the tag is stale" }]],
			},
			{ symbols: { "hint.tip": "&#8505;" } },
		);

		expect(drawn).toContain('data-mark="hint.tip"');
		expect(drawn).toContain("hashline");
		expect(drawn).toContain("the tag is stale");
	});
});
