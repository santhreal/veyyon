/**
 * The `set_cwd` card draws what main's renderer drew.
 *
 * ONE DIFFERENCE IS ASSERTED AS AN EXCEPTION CELL. Main built the call row with `new Text(text)`,
 * whose default arguments pad a row by one column and one row, so it drew with a blank row above and
 * below and a one-column indent. Every other renderer passes `0, 0`, and a view is drawn that way, so
 * the converted row loses the padding and draws in the column its siblings draw in. The cell pins the
 * difference to the padding alone.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import { SET_CWD_TOOL_NAME } from "@veyyon/coding-agent/tools/fs/reroot-hint";
import { type SetCwdToolDetails, setCwdToolView } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import * as setCwdOracle from "../oracles/set-cwd-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	framedView,
	HOST_COLLAPSED,
	lineView,
	renderCompLines,
	useDifferentialTheme,
} from "./harness";

useDifferentialTheme();

describe("set_cwd tool differential", () => {
	const cwd = "/repo/packages/coding-agent";
	const previous = "/repo";

	function resultOf(details: SetCwdToolDetails | undefined): AgentToolResult<SetCwdToolDetails> {
		return { content: [{ type: "text", text: "cwd changed" }], details };
	}

	/**
	 * The oracle's rows around the migrated row, which is the one accepted difference here.
	 *
	 * `main`'s call row was `new Text(text)`, and `Text` defaults to one column of horizontal padding
	 * and one row of vertical padding, so the row drew with a blank row above it, a blank row below it
	 * and a one-column indent. Every other tool renderer in the tree passes `0, 0`, and `drawToolView`
	 * draws a one-line view the same way, so the converted row sits in the column its siblings sit in.
	 * Asserting this shape rather than string equality pins the difference to the padding alone: the
	 * content bytes, escapes included, still have to match.
	 */
	function paddedLike(rows: readonly string[]): string[] {
		return ["", ...rows.map(row => ` ${row}`), ""];
	}

	it("exception cell: the call row carries the same bytes without the default Text padding", () => {
		for (const path of [cwd, "relative/dir", "~/projects/veyyon"]) {
			const oracleComp = setCwdOracle.renderCall({ path }, HOST_COLLAPSED, theme);
			const card = setCwdToolView.renderCall({ path }, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(lineView(card), theme));
			expect(viewLines).toHaveLength(1);
			expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
		}
	});

	it("collapses the home directory and truncates a long path exactly as the renderer did", () => {
		// A path under the real home directory is the only input that tells `shortenPath` apart from
		// the identity, and the oracle calls it too, so the tilde is asserted on its own as well as
		// against the frozen bytes.
		const home = join(homedir(), "projects", "veyyon");
		const oracleHome = setCwdOracle.renderCall({ path: home }, HOST_COLLAPSED, theme);
		const homeLines = renderCompLines(
			drawToolView(lineView(setCwdToolView.renderCall({ path: home }, COLLAPSED)), theme),
		);
		expect(renderCompLines(oracleHome)).toEqual(paddedLike(homeLines));
		expect(stripVTControlCharacters(homeLines.join(""))).toBe(`${SET_CWD_TOOL_NAME} ~/projects/veyyon`);

		const long = `/repo/${"segment/".repeat(30)}leaf`;
		const oracleComp = setCwdOracle.renderCall({ path: long }, HOST_COLLAPSED, theme);
		const viewLines = renderCompLines(
			drawToolView(lineView(setCwdToolView.renderCall({ path: long }, COLLAPSED)), theme),
		);

		expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
		// Anti-vacuity: the bound is the one the renderer applied, so a view that dropped the
		// truncation would draw a longer row than this and fail the parity cell above.
		expect(stripVTControlCharacters(viewLines.join("")).length).toBeLessThanOrEqual(
			`${SET_CWD_TOOL_NAME} `.length + TRUNCATE_LENGTHS.TITLE,
		);
	});

	it("renders the placeholder call row when no path arrived", () => {
		for (const args of [{}, { path: 42 } as unknown as { path: string }]) {
			const oracleComp = setCwdOracle.renderCall(args, HOST_COLLAPSED, theme);
			const card = setCwdToolView.renderCall(args as { path: string }, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(lineView(card), theme));
			expect(renderCompLines(oracleComp)).toEqual(paddedLike(viewLines));
			expect(stripVTControlCharacters(viewLines.join(""))).toBe(`${SET_CWD_TOOL_NAME} …`);
		}
	});

	it("renders a move, a no-op and a detail-less result with exact framed block parity", () => {
		const cases: Array<SetCwdToolDetails | undefined> = [
			{ previous, cwd, requested: cwd },
			{ previous: cwd, cwd, requested: "." },
			undefined,
		];
		const drawn: string[][] = [];
		for (const details of cases) {
			const res = resultOf(details);
			const oracleComp = setCwdOracle.renderResult(res, HOST_COLLAPSED, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(framedView(card), theme));
			expect(viewLines).toEqual(renderCompLines(oracleComp));
			drawn.push(viewLines);
		}
		// A no-op reads differently from a move, which is the defect the header text was changed for;
		// three identical frames would satisfy every parity cell above.
		expect(new Set(drawn.map(lines => lines.join("\n"))).size).toBe(3);
	});

	it("renders every rule-delta shape with exact framed block parity", () => {
		const deltas: Array<Pick<SetCwdToolDetails, "rulesApplied" | "rulesDropped">> = [
			{ rulesApplied: ["AGENTS.md"] },
			{ rulesDropped: ["CLAUDE.md"] },
			{ rulesApplied: ["AGENTS.md", "docs/AGENTS.md"] },
			{ rulesApplied: ["AGENTS.md"], rulesDropped: ["CLAUDE.md"] },
			{ rulesApplied: [], rulesDropped: [] },
		];
		const headers = new Set<string>();
		for (const delta of deltas) {
			const res = resultOf({ previous, cwd, requested: cwd, ...delta });
			const oracleComp = setCwdOracle.renderResult(res, HOST_COLLAPSED, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, COLLAPSED);
			const viewLines = renderCompLines(drawToolView(framedView(card), theme));
			expect(viewLines).toEqual(renderCompLines(oracleComp));
			headers.add(stripVTControlCharacters(viewLines[0] ?? ""));
		}
		// Each side of the delta on its own, both sides together, plural against singular, and a delta
		// that reported nothing: five shapes draw five headers, so no two of them collapsed into one.
		expect(headers.size).toBe(5);
		expect(
			[...headers].filter(header => header.includes("rule file") && !header.includes("rule files")),
		).toHaveLength(2);
	});

	it("draws the same card in both disclosure states", () => {
		const res = resultOf({ previous, cwd, requested: cwd, rulesApplied: ["AGENTS.md"] });
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const oracleComp = setCwdOracle.renderResult(res, hostDisclosure, theme);
			if (oracleComp === undefined) throw new Error("the frozen renderer drew no result card");
			const card = setCwdToolView.renderResult(res, disclosure);
			expect(renderCompLines(drawToolView(framedView(card), theme))).toEqual(renderCompLines(oracleComp));
		}
	});
});
