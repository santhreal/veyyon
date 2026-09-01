/**
 * Every converted tool has a differential suite, and every suite in this directory belongs to one.
 *
 * WHY THIS SUITE EXISTS. The proof that a converted card draws what main's renderer drew is one file
 * per tool beside this one. Nothing in that arrangement states which tools are meant to be covered, so
 * a tool converted to a `ToolView` with no suite written for it is invisible: every suite passes, the
 * bucket is green, and the one card nobody compared is the one that regressed. This resolves the
 * directory at run time and pairs it against `CONVERTED_TOOLS`, so a conversion lands red until its
 * suite exists, and a suite deleted or renamed lands red until the list agrees.
 *
 * THE DEFECT CLASS THIS CLOSES. Coverage that is claimed by a list and never checked against the
 * files: a tool added to the list with no suite, a suite whose tool left the list, and a differential
 * file nobody claims.
 *
 * It also holds the two anti-vacuity claims the per-tool suites all depend on and none of them can
 * make about itself: that the comparisons run under full ANSI styling, without which every styling
 * difference collapses to the same plain string, and that the frozen oracles still draw something.
 *
 * WHAT IT DOES NOT CATCH. Nothing here reads what a suite asserts, so a suite reduced to one cell
 * still counts as coverage. Each per-tool file owns the depth of its own matrix.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { theme } from "@veyyon/coding-agent/theme/theme";
import * as certifyArmsOracle from "../oracles/certify-arms-main-renderer";
import * as fetchOracle from "../oracles/fetch-main-renderer";
import * as goalOracle from "../oracles/goal-main-renderer";
import * as initExperimentOracle from "../oracles/init-experiment-main-renderer";
import * as logExperimentOracle from "../oracles/log-experiment-main-renderer";
import * as runExperimentOracle from "../oracles/run-experiment-main-renderer";
import * as setCwdOracle from "../oracles/set-cwd-main-renderer";
import * as updateNotesOracle from "../oracles/update-notes-main-renderer";
import { CONVERTED_TOOLS, HOST_COLLAPSED, renderCompText, useDifferentialTheme } from "./harness";

useDifferentialTheme();

/**
 * The tools that share one suite, because they share one card and one oracle.
 *
 * Pinned by exact equality rather than inferred: a tool whose card diverges from the one it shares
 * needs its own suite, and this is where that decision is recorded.
 */
const SHARED_SUITES: Readonly<Record<string, string>> = { retain: "memory", recall: "memory", reflect: "memory" };

/** The suite file a tool's card is compared in, by the naming rule the directory follows. */
function suiteSlug(tool: string): string {
	return SHARED_SUITES[tool] ?? tool.replaceAll("_", "-");
}

function suiteFiles(): string[] {
	return readdirSync(join(import.meta.dirname)).filter(name => name.endsWith(".test.ts"));
}

describe("differential coverage", () => {
	it("pins the complete list of converted tools by exact equality", () => {
		expect([...CONVERTED_TOOLS]).toEqual([
			"goal",
			"init_experiment",
			"update_notes",
			"certify_arms",
			"log_experiment",
			"run_experiment",
			"set_cwd",
			"retain",
			"recall",
			"reflect",
			"read_url",
			"resolve",
			"debug",
			"ssh",
			"todo",
			"inspect_image",
			"search_tool_bm25",
			"ast_edit",
			"irc",
			"write",
			"file_search",
			"text_search",
			"structure_search",
			"launch",
			"search",
		]);
	});

	it("has a suite file for every converted tool", () => {
		const present = new Set(suiteFiles());
		const missing = CONVERTED_TOOLS.filter(
			tool => !present.has(`the-${suiteSlug(tool)}-card-draws-what-main-drew.test.ts`),
		);
		expect(missing).toEqual([]);
	});

	it("has a converted tool for every suite file", () => {
		const claimed = new Set(CONVERTED_TOOLS.map(tool => `the-${suiteSlug(tool)}-card-draws-what-main-drew.test.ts`));
		claimed.add("every-converted-tool-has-a-differential-suite.test.ts");
		expect(suiteFiles().filter(name => !claimed.has(name))).toEqual([]);
	});

	it("proves the pairing is not vacuous: a tool with no suite is named", () => {
		const present = new Set(suiteFiles());
		expect(present.has("the-nonexistent-card-draws-what-main-drew.test.ts")).toBe(false);
		expect(suiteSlug("search_tool_bm25")).toBe("search-tool-bm25");
		expect(suiteSlug("reflect")).toBe("memory");
	});
});

describe("differential anti-vacuity", () => {
	it("runs under full ANSI styling policy so styling comparisons are meaningful", () => {
		expect(theme.fg("accent", "sample")).not.toBe("sample");
		expect(theme.bold("sample")).not.toBe("sample");
		expect(theme.italic("sample")).not.toBe("sample");
	});

	it("confirms every frozen oracle produces non-empty output", () => {
		const goalCall = goalOracle.renderCall({ op: "get" }, HOST_COLLAPSED, theme);
		expect(renderCompText(goalCall).length).toBeGreaterThan(0);

		const initCall = initExperimentOracle.renderCall({ name: "test_run" }, HOST_COLLAPSED, theme);
		expect(renderCompText(initCall).length).toBeGreaterThan(0);

		const notesCall = updateNotesOracle.renderCall({ body: "notes content" }, HOST_COLLAPSED, theme);
		expect(renderCompText(notesCall).length).toBeGreaterThan(0);

		const armsCall = certifyArmsOracle.renderCall(
			{ arms: [{ arm: "A", hypothesis: "hyp", diff: "diff", modified_paths: ["p.ts"] }] },
			HOST_COLLAPSED,
			theme,
		);
		expect(renderCompText(armsCall).length).toBeGreaterThan(0);

		const logCall = logExperimentOracle.renderCall(
			{ status: "keep", metric: 1.0, description: "kept" },
			HOST_COLLAPSED,
			theme,
		);
		expect(renderCompText(logCall).length).toBeGreaterThan(0);

		const runCall = runExperimentOracle.renderCall({}, HOST_COLLAPSED, theme);
		expect(renderCompText(runCall).length).toBeGreaterThan(0);

		const cwdCall = setCwdOracle.renderCall({ path: "/repo" }, HOST_COLLAPSED, theme);
		expect(renderCompText(cwdCall).length).toBeGreaterThan(0);

		const urlCall = fetchOracle.renderReadUrlCall({ path: "https://example.com" }, HOST_COLLAPSED, theme);
		expect(renderCompText(urlCall).length).toBeGreaterThan(0);
	});

	it("positive control: distinct inputs produce distinct rendered outputs", () => {
		const callA = initExperimentOracle.renderCall({ name: "alpha" }, HOST_COLLAPSED, theme);
		const callB = initExperimentOracle.renderCall({ name: "beta" }, HOST_COLLAPSED, theme);
		expect(renderCompText(callA)).not.toBe(renderCompText(callB));
	});
});
