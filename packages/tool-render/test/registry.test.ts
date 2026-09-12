import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import { stripAnsi } from "../src/util";

/**
 * Every wire name the coding-agent can emit must resolve to a renderer with a
 * Summary. Current aliases (apply_patch→edit, js/python/notebook→eval, …)
 * must share the primary renderer. Prototype keys must never resolve accidentally.
 */
const REGISTERED_NAMES = [
	"argot_load",
	"argot_unload",
	"ask",
	"ast_edit",
	"bash",
	"browser",
	"puppeteer",
	"checkpoint",
	"rewind",
	"debug",
	"edit",
	"apply_patch",
	"eval",
	"js",
	"python",
	"notebook",
	"fetch",
	"generate_image",
	"github",
	"goal",
	"inspect_image",
	"irc",
	"job",
	"await",
	"poll",
	"cancel_job",
	"launch",
	"learn",
	"lsp",
	"manage_skill",
	"memory_edit",
	"recall",
	"reflect",
	"retain",
	"read",
	"report_finding",
	"report_tool_issue",
	"resolve",
	"search",
	"search_tool_bm25",
	"set_cwd",
	"ssh",
	"task",
	"todo",
	"web_search",
	"write",
	"yield",
] as const;

const ALIASES: Array<[string, string]> = [
	["apply_patch", "edit"],
	["puppeteer", "browser"],
	["js", "eval"],
	["python", "eval"],
	["notebook", "eval"],
	["await", "job"],
	["poll", "job"],
	["cancel_job", "job"],
];

describe("@veyyon/tool-render registry", () => {
	it("resolves known tools and falls back to generic for unknown names", () => {
		const bash = resolveToolRenderer("bash");
		const unknown = resolveToolRenderer("definitely-not-a-real-tool-xyz");
		expect(bash.Summary).toBeDefined();
		expect(unknown.Summary).toBeDefined();
		expect(bash).not.toBe(unknown);
	});

	it("every registered wire name returns a renderer with Summary", () => {
		const missing: string[] = [];
		for (const name of REGISTERED_NAMES) {
			const r = resolveToolRenderer(name);
			if (typeof r.Summary !== "function" && typeof r.Summary !== "object") {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});

	it("aliases share the primary tool's renderer instance", () => {
		for (const [alias, primary] of ALIASES) {
			expect(resolveToolRenderer(alias)).toBe(resolveToolRenderer(primary));
		}
	});

	it("retired search tool names do not register and fall back to generic", () => {
		const generic = resolveToolRenderer("definitely-not-a-real-tool-xyz");
		for (const retired of ["glob", "grep", "find", "ast_grep"]) {
			expect(resolveToolRenderer(retired)).toBe(generic);
		}
	});

	it("does not treat Object.prototype keys as registered tools", () => {
		const generic = resolveToolRenderer("definitely-not-a-real-tool-xyz");
		// constructor / toString / hasOwnProperty must fall through to generic.
		expect(resolveToolRenderer("constructor")).toBe(generic);
		expect(resolveToolRenderer("toString")).toBe(generic);
		expect(resolveToolRenderer("hasOwnProperty")).toBe(generic);
		expect(resolveToolRenderer("__proto__")).toBe(generic);
	});

	it("preserves historical specialized Summary/Body rendering without display and delegates to ToolExecution with display", () => {
		const readRenderer = resolveToolRenderer("read");
		expect(readRenderer.Summary).toBeDefined();
		expect(readRenderer.Body).toBeDefined();

		// Summary without display: specialized PathText with the selector the tool read.
		// The schema has no `offset`/`limit` window: a range travels in the path.
		const summaryWithout = renderToStaticMarkup(
			createElement(readRenderer.Summary, {
				name: "read",
				args: { path: "src/main.ts:10-29" },
			}),
		);
		expect(summaryWithout).toContain("src/main.ts");
		expect(summaryWithout).toContain(":10-29");

		// Body without display: specialized read rendering with resolved KvGrid
		const htmlWithout = renderToStaticMarkup(
			createElement(readRenderer.Body!, {
				name: "read",
				args: { path: "src/main.ts" },
				result: {
					content: [{ type: "text", text: "const a = 1;" }],
					details: { resolvedPath: "src/main.ts" },
				},
			}),
		);
		expect(htmlWithout).toContain("resolved");
		expect(htmlWithout).toContain("src/main.ts");
		expect(htmlWithout).toContain("const a = 1;");

		// With a projected view: the canonical projection draws the card.
		const htmlWith = renderToStaticMarkup(
			createElement(readRenderer.Body!, {
				name: "read",
				args: { path: "src/main.ts" },
				display: {
					resultView: { kind: "statusRow", status: "success", title: "projected output text" },
				},
			}),
		);
		expect(htmlWith).toContain("projected output text");

		// With a display that fell through to the generic key=value card: one owner per card, so
		// the specialized descriptor draws from the result and the generic text is not repeated.
		const htmlGeneric = renderToStaticMarkup(
			createElement(readRenderer.Body!, {
				name: "read",
				args: { path: "src/main.ts" },
				result: {
					content: [{ type: "text", text: "const a = 1;" }],
					details: { resolvedPath: "src/main.ts" },
				},
				display: {
					generic: { icon: "done", outputText: "generic fallthrough text", isJson: false },
				},
			}),
		);
		expect(htmlGeneric).toContain("const a = 1;");
		expect(htmlGeneric).not.toContain("generic fallthrough text");
	});
	it("keeps stripAnsi browser-safe (no Node deps in the util path)", () => {
		expect(stripAnsi("plain\x1b[31mred\x1b[0m")).toBe("plainred");
	});
});
