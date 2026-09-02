import { describe, expect, it } from "bun:test";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import { recallToolView, reflectToolView, retainToolView } from "@veyyon/coding-agent/tools/agent/memory-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { sanitizeText } from "@veyyon/utils";
import type { ToolView } from "@veyyon/view";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const COLLAPSED = { expanded: false } as const;
const EXPANDED = { expanded: true } as const;

const lines = (view: ToolView, uiTheme: Theme, width = 200) =>
	sanitizeText(drawToolView(view, uiTheme).render(width).join("\n")).split("\n");

describe("the retain card", () => {
	const args = {
		items: [
			{ content: "First fact to remember", context: "ctx-a" },
			{ content: "Second fact to remember", context: "ctx-b" },
			{ content: "Third fact to remember" },
		],
	};

	it("renders one inline bullet line per item with a count summary", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const result = { content: [{ type: "text", text: "3 memories stored." }], details: { count: 3 } };
		const rendered = lines(retainToolView.renderResult(result, COLLAPSED, args), uiTheme);

		expect(rendered[0]).toContain("Retain");
		expect(rendered[0]).toContain("3 memories stored");
		const items = rendered.filter(line => line.includes(bullet));
		expect(items).toHaveLength(3);
		expect(items[0]).toContain("First fact to remember");
		expect(items[2]).toContain("Third fact to remember");
		// No "Remember:" prefix and no raw JSON arg tree leaks into the output.
		expect(rendered.some(line => line.includes("Remember:"))).toBe(false);
		expect(rendered.some(line => line.includes("context") || line.includes("[0]"))).toBe(false);
	});

	it("truncates long memory content to one line", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const long = "x".repeat(400);
		const result = { content: [{ type: "text", text: "1 memory stored." }], details: { count: 1 } };
		const rendered = lines(
			retainToolView.renderResult(result, COLLAPSED, { items: [{ content: long }] }),
			uiTheme,
			80,
		);
		const item = rendered.find(line => line.includes(bullet));
		expect(item!.length).toBeLessThanOrEqual(80);
		expect(item).toContain("…");
	});

	it("shows pending bullet lines while the call streams", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const rendered = lines(retainToolView.renderCall(args, COLLAPSED), uiTheme);
		expect(rendered.filter(line => line.includes(bullet))).toHaveLength(3);
	});
});

describe("the recall card", () => {
	it("summarizes the match count and hides memories until expanded", async () => {
		const uiTheme = await theme();
		const result = {
			content: [
				{
					type: "text",
					text: "Found 2 relevant memories (as of 2026-05-30 UTC):\n\n- alpha memory\n- beta memory",
				},
			],
		};
		const collapsed = lines(recallToolView.renderResult(result, COLLAPSED, { query: "find stuff" }), uiTheme);
		expect(collapsed[0]).toContain("Recall");
		expect(collapsed[0]).toContain("find stuff");
		expect(collapsed[0]).toContain("2 found");
		expect(collapsed.some(line => line.includes("alpha memory"))).toBe(false);

		const expanded = lines(recallToolView.renderResult(result, EXPANDED, { query: "find stuff" }), uiTheme);
		expect(expanded.some(line => line.includes("alpha memory"))).toBe(true);
		expect(expanded.some(line => line.includes("beta memory"))).toBe(true);
	});

	it("flags an empty recall as a single warning line", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "No relevant memories found." }] };
		const rendered = lines(recallToolView.renderResult(result, COLLAPSED, { query: "q" }), uiTheme);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("no matches");
	});
});

describe("the reflect card", () => {
	it("renders the synthesized answer under a concise header", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "Line one.\nLine two.\nLine three." }] };
		const rendered = lines(reflectToolView.renderResult(result, EXPANDED, { query: "what do you know" }), uiTheme);
		expect(rendered[0]).toContain("Reflect");
		expect(rendered[0]).toContain("what do you know");
		expect(rendered.some(line => line.includes("Line one."))).toBe(true);
		expect(rendered.some(line => line.includes("Line three."))).toBe(true);
	});
});
