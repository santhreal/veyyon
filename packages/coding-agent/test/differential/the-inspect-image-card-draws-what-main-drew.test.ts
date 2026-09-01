/**
 * The `inspect_image` card draws what main's renderer drew.
 *
 * FOUR DIFFERENCES ARE ASSERTED AS EXCEPTION CELLS. The question under the call row, which main drew
 * after the zero-width colour runs its single `Text` closed. The answer panel, which states the
 * outcome on the rail where main asked for the legacy muted edge by hand. The header, which appends
 * the model and the media type as the row's own metadata rather than joining them on with an unstyled
 * dot. And a card with no answer, which keeps that metadata on the row where main hung it on a second
 * row beneath.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { InspectImageToolDetails } from "@veyyon/coding-agent/tools/fs/inspect-image";
import {
	type InspectImageViewArgs,
	type InspectImageViewResult,
	inspectImageToolView,
} from "@veyyon/coding-agent/tools/fs/inspect-image-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as inspectImageOracle from "../oracles/inspect-image-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	lineView,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("inspect_image tool differential", () => {
	const details: InspectImageToolDetails = {
		model: "openai/gpt-4o",
		imagePath: "/repo/shots/error.png",
		mimeType: "image/png",
	};
	const args: InspectImageViewArgs = { path: "/repo/shots/error.png", question: "What error text is visible?" };
	/** The block's rail glyph, read after the theme is loaded rather than while the file is read. */
	const rail = (): string => theme.symbol("block.rail");

	function oracleLines(
		result: InspectImageViewResult,
		options: RenderResultOptions,
		callArgs: InspectImageViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(
			inspectImageOracle.inspectImageToolRenderer.renderResult(result, options, theme, callArgs),
			width,
		);
	}

	function viewLines(
		result: InspectImageViewResult,
		context: ToolViewContext,
		callArgs: InspectImageViewArgs = args,
		width = WIDTH,
	): string[] {
		return renderCompLines(drawToolView(inspectImageToolView.renderResult(result, context, callArgs), theme), width);
	}

	/**
	 * One drawn row with the settled rail repainted in the colour main asked for.
	 *
	 * The rail is the one byte every row of the panel differs by, and it is pinned in its own cell
	 * below. Swapping it here leaves the rest of the row — every span, tone, cut and note — compared
	 * byte for byte instead of stripped to its letters.
	 */
	function onMainsRail(line: string): string {
		const drawn = theme.fg("dim", rail());
		return line.startsWith(drawn) ? `${theme.fg("borderMuted", rail())}${line.slice(drawn.length)}` : line;
	}

	/**
	 * The settled row both arms build: the emblem this theme draws for the tool, the title, the image.
	 *
	 * The emblem is read from the theme rather than written out, since a theme that draws none leaves
	 * the row opening on its title and both arms drop the column with it.
	 */
	function inspectTitle(pathText: string): string {
		const emblem = theme.styledSymbol("tool.inspectImage", "accent");
		const named = `${theme.fg("accent", "Inspect")}: ${theme.fg("muted", pathText)}`;
		return emblem ? `${emblem} ${named}` : named;
	}

	const answered: InspectImageViewResult = {
		content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
		details,
	};

	it("draws the pending call row with exact byte parity, at every width and disclosure", () => {
		const calls: InspectImageViewArgs[] = [
			{},
			{ path: "/repo/shots/error.png" },
			{ path: `${homedir()}/shots/error.png` },
			{ path: "" },
		];
		for (const callArgs of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = renderCompLines(
						drawToolView(lineView(inspectImageToolView.renderCall(callArgs, context)), theme),
						width,
					);
					const oracle = renderCompLines(
						inspectImageOracle.inspectImageToolRenderer.renderCall(callArgs, options, theme),
						width,
					);
					expect(drawn).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: a path outside the home directory stays, and one inside it is shortened, so
		// the rows compared above carry a description rather than an empty column.
		const inRepo = renderCompLines(
			drawToolView(lineView(inspectImageToolView.renderCall({ path: "/repo/shots/error.png" }, COLLAPSED)), theme),
		);
		const inHome = renderCompLines(
			drawToolView(
				lineView(inspectImageToolView.renderCall({ path: `${homedir()}/shots/error.png` }, COLLAPSED)),
				theme,
			),
		);
		expect(stripVTControlCharacters(inRepo.join(""))).toContain("Inspect: /repo/shots/error.png");
		expect(stripVTControlCharacters(inHome.join(""))).toContain("Inspect: ~/shots/error.png");
	});

	it("exception cell: the question under a call row opens no empty colour runs", () => {
		const question = "What error text is visible?";
		const drawn = renderCompLines(drawToolView(inspectImageToolView.renderCall(args, COLLAPSED), theme));
		const oracle = renderCompLines(
			inspectImageOracle.inspectImageToolRenderer.renderCall(args, HOST_COLLAPSED, theme),
		);
		const asked = `${theme.fg("dim", "Question:")} ${theme.fg("accent", question)}`;
		const emptyRuns = `${theme.fg("muted", "")}${theme.fg("accent", "")}${theme.fg("muted", "")}`;
		// Main built the two rows as one `Text`, whose wrapping closed the colours the header above had
		// opened, leaving three zero-width runs between the indent and the question. The host emits a
		// run only for a span with something in it, so the question draws in the same colours with
		// fewer bytes.
		expect(drawn[1]).toBe(`  ${asked}`);
		expect(oracle[1]).toBe(`  ${emptyRuns}${asked}`);
		expect(stripVTControlCharacters(drawn[1] ?? "")).toBe(stripVTControlCharacters(oracle[1] ?? ""));
		expect(drawn[0]).toBe(oracle[0]);
	});

	it("fills the panel main filled, row for row, at every width and disclosure", () => {
		const results: InspectImageViewResult[] = [
			answered,
			{ content: [{ type: "text", text: "one line" }], details },
			// More lines than either window shows, which is the held-back note in both states.
			{
				content: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n") }],
				details,
			},
			// A tab and a line past the column budget, which the card de-tabs and cuts at 120 columns.
			{ content: [{ type: "text", text: `col\tumn\n${"x".repeat(200)}` }], details },
			// Trailing blank lines the model ended on, which neither card frames.
			{ content: [{ type: "text", text: "answer\n\n\n" }], details },
			// The answer with nothing said about how it was produced.
			{ content: [{ type: "text", text: "answer" }] },
		];
		for (const result of results) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					const drawn = viewLines(result, context, args, width);
					const oracle = oracleLines(result, options, args, width);
					// Every row below the header, byte for byte, once the rail carries the colour main
					// asked for: the answer, the question above it, the blank row between them, the cut
					// at 120 columns and the note saying what was held back.
					expect(drawn.slice(1).map(onMainsRail)).toEqual(oracle.slice(1));
					// The header differs by the separator between the row and its metadata alone, which is
					// pinned in its own cell.
					expect(stripVTControlCharacters(drawn[0] ?? "").replaceAll(" · ", " ")).toBe(
						stripVTControlCharacters(oracle[0] ?? "").replaceAll(" · ", " "),
					);
				}
			}
		}
		// Anti-vacuity: the rows compared above are the model's answer and the question that led to
		// it, and the windows are the four rows a collapsed card shows and the sixteen an expanded one
		// shows, not a frame with nothing in it.
		const long: InspectImageViewResult = {
			content: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n") }],
			details,
		};
		const collapsed = viewLines(long, COLLAPSED).map(line => stripVTControlCharacters(line));
		const expanded = viewLines(long, EXPANDED).map(line => stripVTControlCharacters(line));
		expect(collapsed.filter(line => /line \d+$/u.test(line))).toHaveLength(4);
		expect(expanded.filter(line => /line \d+$/u.test(line))).toHaveLength(16);
		expect(collapsed.at(-1)).toContain("… 20 more lines");
		expect(expanded.at(-1)).toContain("… 8 more lines");
		const asked = viewLines(answered, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(asked.some(line => line.includes("Question: What error text is visible?"))).toBe(true);
	});

	it("exception cell: the panel states the outcome on its rail where main kept the legacy muted edge", () => {
		// Vacuity guard: on a theme where the two colours resolve to the same bytes this cell would
		// pass without comparing anything.
		expect(theme.getColorHex("dim")).not.toBe(theme.getColorHex("borderMuted"));
		const drawn = viewLines(answered, COLLAPSED);
		const oracle = oracleLines(answered, HOST_COLLAPSED);
		// A settled card of fetched data now says so on the rail, in the colour every framed view uses
		// for a success, where main asked for the muted edge by hand. The row count and every other
		// byte are unchanged.
		expect(drawn.every(line => line.startsWith(theme.fg("dim", rail())))).toBe(true);
		expect(oracle.every(line => line.startsWith(theme.fg("borderMuted", rail())))).toBe(true);
		expect(drawn).toHaveLength(oracle.length);
		// The failing card is the control: its rail states the failure in both arms, so the outcome
		// moved onto the rail for a success and nothing else changed.
		const failed: InspectImageViewResult = {
			content: [{ type: "text", text: "no such file" }],
			details,
			isError: true,
		};
		expect(viewLines(failed, COLLAPSED).every(line => line.startsWith(theme.fg("error", rail())))).toBe(true);
		expect(oracleLines(failed, HOST_COLLAPSED).every(line => line.startsWith(theme.fg("error", rail())))).toBe(true);
	});

	it("exception cell: the header carries the model and the type as the row's own metadata", () => {
		const title = inspectTitle("/repo/shots/error.png");
		const meta = theme.fg("dim", `openai/gpt-4o${theme.sep.dot}image/png`);
		// Main joined the header and its metadata with an unstyled dot; the host appends the row's
		// metadata the way it appends every other row's, which is a space and the same dim run. The
		// words, their colours and their order are the ones main drew.
		expect(viewLines(answered, COLLAPSED)[0]).toBe(`${theme.fg("dim", rail())} ${title} ${meta}`);
		expect(oracleLines(answered, HOST_COLLAPSED)[0]).toBe(
			`${theme.fg("borderMuted", rail())} ${title}${theme.sep.dot}${meta}`,
		);
	});

	it("exception cell: a card with no answer keeps the model and the type on its row", () => {
		const empty: InspectImageViewResult = { content: [], details };
		const title = inspectTitle("/repo/shots/error.png");
		const meta = theme.fg("dim", `openai/gpt-4o${theme.sep.dot}image/png`);
		// Nothing to frame in either arm. Main hung the model and the type on a second row of their
		// own, at column zero, under a row that had already said what was inspected; the row carries
		// them itself, which is where every other converted card puts the same detail.
		expect(viewLines(empty, COLLAPSED)).toEqual([`${title} ${meta}`]);
		expect(oracleLines(empty, HOST_COLLAPSED)).toEqual([
			title,
			`${theme.fg("accent", "")}${theme.fg("muted", "")}${meta}`,
		]);
		// A card told nothing about the request is one row in both arms, so the second row above is
		// the metadata and not a blank the frame left behind.
		const bare: InspectImageViewResult = { content: [] };
		expect(viewLines(bare, COLLAPSED)).toEqual(oracleLines(bare, HOST_COLLAPSED));
		expect(stripVTControlCharacters(viewLines(bare, COLLAPSED).join(""))).toBe("Inspect: /repo/shots/error.png");
	});

	it("draws the failure card main drew, sanitising the same text, at every width and disclosure", () => {
		const failures: InspectImageViewResult[] = [
			{ content: [{ type: "text", text: "no such file" }], details, isError: true },
			// The prefix and the padding the shared sanitiser strips.
			{ content: [{ type: "text", text: "Error:   the model refused\t" }], details, isError: true },
			// A home path in the message, which is shortened before it reaches the card.
			{
				content: [{ type: "text", text: `cannot read ${homedir()}/shots/error.png` }],
				details,
				isError: true,
			},
			// Past the line budget, which is cut rather than wrapped into the frame.
			{ content: [{ type: "text", text: "x".repeat(TRUNCATE_LENGTHS.LINE + 40) }], details, isError: true },
			// A failure that said nothing, which both cards fall back to wording themselves.
			{ content: [], details, isError: true },
			// A failure before the request was described at all.
			{ content: [{ type: "text", text: "no such file" }], isError: true },
		];
		for (const result of failures) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [WIDTH, 40, 12]) {
					expect(viewLines(result, context, args, width)).toEqual(oracleLines(result, options, args, width));
				}
			}
		}
		// Anti-vacuity: the cards compared above carry the failure text, shortened and cut, under a
		// header that names the image.
		const homePath = viewLines(failures[2]!, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(homePath.some(line => line.includes("cannot read ~/shots/error.png"))).toBe(true);
		expect(homePath.some(line => line.includes(homedir()))).toBe(false);
		const silent = viewLines(failures[4]!, COLLAPSED).map(line => stripVTControlCharacters(line));
		expect(silent.some(line => line.includes("inspection failed"))).toBe(true);
	});
});
