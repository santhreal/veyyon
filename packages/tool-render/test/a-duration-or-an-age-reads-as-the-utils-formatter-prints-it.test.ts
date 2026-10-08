/**
 * WHY: `@veyyon/tool-render` re-declared `formatDuration` (job, task) and `formatAge` (web_search)
 * with rules of its own, so a value the terminal printed as `1m5s`, `1h` or `just now` read as
 * `1m 5s`, `60m 0s` or `0m ago` in the HTML export and the live web transcript. The class is a
 * descriptor that formats a duration or an age with anything other than the `@veyyon/utils`
 * definitions the terminal renderers call.
 *
 * Every site below is driven through the registered descriptor (`resolveToolRenderer`), fed the
 * boundary inputs on which the retired copies disagreed with the owner, and its rendered text is
 * compared with the owner's answer for the same input. NaN cannot reach a descriptor (a result
 * arrives as JSON, which has no NaN, and `finiteNumber` drops it), so for NaN the suite asserts
 * that the descriptor prints no duration at all rather than `NaNms`.
 *
 * What this does not catch: a NEW descriptor site that formats a duration or an age by hand. The
 * site table is written out because a site is a JSX position, not a registry member.
 */
import { describe, expect, it } from "bun:test";
import { formatAge, formatDuration } from "@veyyon/utils/format";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps } from "../src/types";

/** Durations in milliseconds on which the retired copies disagreed with `formatDuration`. */
const DURATIONS = [65_000, 3_600_000, 999, 1_500, 90_061_000];
/** Ages in seconds on which the retired copy disagreed with `formatAge`. */
const AGES = [30, 1_209_600, 0, 7_200, 86_400 * 45];

/** Every text a selector matches in the rendered Body of `tool`. */
function bodyTexts(tool: string, args: Record<string, unknown>, details: object, selector: string): string[] {
	const Body = resolveToolRenderer(tool).Body;
	if (!Body) throw new Error(`${tool} has no Body`);
	const props: ToolRenderProps = { name: tool, args, result: { content: [], details } };
	const { document } = parseHTML(`<html><body>${renderToStaticMarkup(createElement(Body, props))}</body></html>`);
	return Array.from(document.querySelectorAll(selector), node => (node.textContent ?? "").trim());
}

/** Each descriptor site that prints a duration: renders it with `ms` and returns the site's texts. */
const DURATION_SITES: Record<string, (ms: number) => string[]> = {
	"job snapshot row": ms =>
		bodyTexts(
			"job",
			{ poll: ["j1"] },
			{ jobs: [{ id: "j1", type: "bash", status: "completed", label: "build", durationMs: ms }] },
			".tv-list .tv-faint",
		),
	"task result stats": ms =>
		bodyTexts("task", { tasks: [{ id: "A" }] }, { results: [{ id: "A", exitCode: 0, durationMs: ms }] }, ".tv-faint"),
	"task batch total": ms =>
		bodyTexts(
			"task",
			{ tasks: [{ id: "A" }] },
			{ results: [{ id: "A", exitCode: 0 }], totalDurationMs: ms },
			".tv-faint",
		),
	"task progress row": ms =>
		bodyTexts(
			"task",
			{ tasks: [{ id: "A" }] },
			{ progress: [{ id: "A", status: "running", durationMs: ms }] },
			".tv-faint",
		),
	"eval cell title": ms =>
		bodyTexts(
			"eval",
			{ language: "py", code: "print(1)" },
			{ cells: [{ index: 0, language: "py", code: "print(1)", status: "complete", durationMs: ms }] },
			".tv-cell .tv-out-title",
		),
};

describe("a duration a descriptor prints", () => {
	for (const [site, shown] of Object.entries(DURATION_SITES)) {
		it.each(DURATIONS)(`${site} prints formatDuration(%p)`, ms => {
			const tokens = shown(ms).flatMap(text => text.split(/[\s·]+/));
			expect(tokens).toContain(formatDuration(ms));
		});

		it(`${site} prints no duration for NaN`, () => {
			expect(shown(Number.NaN).join(" ")).not.toContain("NaN");
		});
	}
});

describe("an age a descriptor prints", () => {
	function shownAge(ageSeconds: number, publishedDate?: string): string {
		const source = { url: "https://example.com/a", title: "A", ageSeconds, publishedDate };
		return bodyTexts("web_search", { query: "q" }, { response: { sources: [source] } }, ".tv-list .tv-muted")
			.map(text => text.replace(/^·\s*/, ""))
			.join("");
	}

	it.each(AGES)("web_search source row prints formatAge(%p)", ageSeconds => {
		expect(shownAge(ageSeconds)).toBe(formatAge(ageSeconds));
	});

	it("falls back to the published date when the owner prints no age", () => {
		expect(formatAge(0)).toBe("");
		expect(shownAge(0, "2026-01-02")).toBe("2026-01-02");
	});
});
