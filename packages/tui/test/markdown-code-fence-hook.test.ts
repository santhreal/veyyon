/**
 * MarkdownTheme.codeBlockFence — the themed fence-row hook.
 *
 * Why this suite exists: fenced blocks used to render their literal ```
 * markers in every theme, which operators read as UNRENDERED markdown
 * ("this is rendering raw", 2026-07-22). The fix routes the opening and
 * closing rows through an optional theme hook so a product theme can draw
 * designed chrome instead, while the default (no hook) stays byte-identical
 * to the historical ``` rendering that other consumers and tests pin.
 */
import { describe, expect, it } from "bun:test";
import { Markdown, type MarkdownTheme } from "@veyyon/tui";
import { defaultMarkdownTheme } from "./test-themes";

function plain(lines: readonly string[]): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
	return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

const SOURCE = "```ts\nconst x = 1;\n```";

describe("MarkdownTheme.codeBlockFence hook", () => {
	/** Without the hook the literal ``` markers must survive unchanged — the
	 * documented default that downstream snapshot tests rely on. */
	it("defaults to literal backtick fences when the hook is absent", () => {
		const md = new Markdown(SOURCE, 0, 0, defaultMarkdownTheme);
		const lines = plain(md.render(60));
		expect(lines).toContain("```ts");
		expect(lines).toContain("```");
	});

	/** With the hook, BOTH fence rows are fully replaced: the language reaches
	 * the open row, the close row carries no language, and no literal backtick
	 * fence remains anywhere in the render. */
	it("replaces both fence rows with the hook's output", () => {
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlockFence: (lang, pos) => (pos === "open" ? `[open:${lang ?? "none"}]` : "[close]"),
		};
		const md = new Markdown(SOURCE, 0, 0, theme);
		const lines = plain(md.render(60));
		expect(lines).toContain("[open:ts]");
		expect(lines).toContain("[close]");
		expect(lines.some(line => line.includes("```"))).toBe(false);
	});

	/** A fence with no language tag must hand the hook `undefined`, not the
	 * empty string — the hook's signature contract. */
	it("passes undefined for a language-less fence", () => {
		const seen: (string | undefined)[] = [];
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlockFence: (lang, pos) => {
				if (pos === "open") seen.push(lang);
				return "~";
			},
		};
		new Markdown("```\nplain\n```", 0, 0, theme).render(60);
		expect(seen).toEqual([undefined]);
	});

	/** Code blocks nested in list items route through a separate render path;
	 * the hook must apply there too or list-nested code regresses to raw ```. */
	it("applies inside list items", () => {
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlockFence: (_lang, pos) => (pos === "open" ? "[open]" : "[close]"),
		};
		const md = new Markdown("- item\n\n  ```ts\n  const y = 2;\n  ```", 0, 0, theme);
		const lines = plain(md.render(60));
		expect(lines.some(line => line.includes("[open]"))).toBe(true);
		expect(lines.some(line => line.includes("[close]"))).toBe(true);
		expect(lines.some(line => line.includes("```"))).toBe(false);
	});
});
