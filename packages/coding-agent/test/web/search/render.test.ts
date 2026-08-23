import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { renderSearchResult, type SearchRenderDetails } from "@veyyon/coding-agent/web/search/render";
import type { SearchResponse } from "@veyyon/coding-agent/web/search/types";
import { sanitizeText } from "@veyyon/utils";

const ANSWER = [
	"## Overview Heading",
	"This is the **first** paragraph with bold text.",
	"",
	"Para two line here.",
	"Para three line here.",
	"Para four line here.",
	"Para five line here.",
	"Para six line here.",
	"Para seven line here.",
	"Para eight line here.",
	"The FINAL_UNIQUE_MARKER paragraph at the very end.",
].join("\n");

function buildResult(answer: string): {
	content: Array<{ type: string; text?: string }>;
	details: SearchRenderDetails;
} {
	const response: SearchResponse = {
		provider: "perplexity",
		answer,
		sources: [
			{ title: "Src One", url: "https://example.com/a", snippet: "snip a" },
			{ title: "Src Two", url: "https://example.com/b", snippet: "snip b" },
		],
	};
	return { content: [{ type: "text", text: answer }], details: { response } };
}

/** Slice the sanitized lines belonging to the framed "Answer" section. */
function answerSection(lines: string[]): string {
	const start = lines.findIndex(l => / Answer /.test(l));
	const end = lines.findIndex((l, i) => i > start && / Sources /.test(l));
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

describe("renderSearchResult", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the answer as markdown (strips ## and ** markers)", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// Heading hashes and bold asterisks are consumed by the markdown renderer.
		expect(answer).not.toContain("##");
		expect(answer).not.toContain("**");
		// The text content survives.
		expect(answer.toLowerCase()).toContain("overview heading");
		expect(answer).toContain("first");
	});

	it("shows the full answer when expanded — no answer truncation summary", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// The final paragraph is present and there is no "… N more lines" cap inside the Answer section.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("shows the full answer when collapsed by default", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// TUI collapsed view keeps the answer intact; only explicit compact mode caps it.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("truncates the answer only when compact mode provides maxAnswerLines", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
			maxAnswerLines: 3,
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));

		expect(answer).toMatch(/more line/);
		expect(answer).not.toContain("FINAL_UNIQUE_MARKER");
	});

	it("renders sources as railed body lines without tree connectors", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const rendered = component.render(120);
		const plainLines = rendered.map(l => sanitizeText(l));
		const rail = uiTheme.symbol("block.rail");

		expect(plainLines[0]!).toContain("2 sources");

		// Every line (header and body) starts on the rail
		for (const line of plainLines) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}

		// Sources section contains the sources
		const sourcesIndex = plainLines.findIndex(l => /Sources/.test(l));
		expect(sourcesIndex).toBeGreaterThan(0);
		expect(plainLines[sourcesIndex + 1]!).toContain("Src One");
		expect(plainLines[sourcesIndex + 2]!).toContain("Src Two");
	});

	it("respects collapsed vs expanded sources budgets with overflow summary line", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const sources = Array.from({ length: 12 }, (_, i) => ({
			title: `Source Result ${i}`,
			url: `https://example.com/res${i}`,
		}));
		const res: { content: Array<{ type: string; text?: string }>; details: SearchRenderDetails } = {
			content: [{ type: "text", text: "Some answer" }],
			details: {
				response: {
					provider: "perplexity",
					answer: "Some answer",
					sources,
				},
			},
		};

		const rail = uiTheme.symbol("block.rail");

		// Collapsed mode: shows 8 sources + 1 overflow summary line
		const collapsed = renderSearchResult(res, { expanded: false, isPartial: false }, uiTheme).render(120);
		const plainCollapsed = collapsed.map(l => sanitizeText(l));
		expect(plainCollapsed[0]!).toContain("12 sources");
		for (const line of plainCollapsed.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainCollapsed.some(l => l.includes("… 4 more sources"))).toBe(true);

		// Expanded mode: shows all 12 sources
		const expanded = renderSearchResult(res, { expanded: true, isPartial: false }, uiTheme).render(120);
		const plainExpanded = expanded.map(l => sanitizeText(l));
		expect(plainExpanded[0]!).toContain("12 sources");
		for (const line of plainExpanded.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainExpanded.some(l => l.includes("more source"))).toBe(false);
	});

	it("renders fallback text and error panels as railed framed blocks without tree connectors", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const rail = uiTheme.symbol("block.rail");

		// Fallback text (no response details)
		const fallbackComp = renderSearchResult(
			{ content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }] },
			{ expanded: true, isPartial: false },
			uiTheme,
		);
		const fallbackLines = fallbackComp.render(120).map(l => sanitizeText(l));
		for (const line of fallbackLines) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}

		// Error panel
		const errorComp = renderSearchResult(
			{ content: [], details: { error: "Network timeout", response: { provider: "brave" } as never } },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const errorLines = errorComp.render(120).map(l => sanitizeText(l));
		expect(errorLines[0]!).toContain("Web Search");
		expect(errorLines[0]!).toContain("Brave");
		for (const line of errorLines) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(errorLines[1]!).toContain("Error: Network timeout");
	});
});
