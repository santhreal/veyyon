/**
 * The transcript's designed code-fence chrome.
 *
 * Why this suite exists: with the raw ``` markers on screen, operators read
 * fenced blocks as UNRENDERED markdown ("this is rendering raw", live report
 * 2026-07-22). The product theme now replaces both fence rows via
 * MarkdownTheme.codeBlockFence: the block opens with a short rule + language
 * tag (`──╴bash`) and closes with the bare rule (`──`) — the same dim-rule
 * section language the transcript already uses (compaction marker, cache-miss
 * marker). These tests pin the exact rendered bytes so a regression back to
 * literal backticks (or a louder, animated fence) fails immediately.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getMarkdownTheme, initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { Markdown } from "@veyyon/tui";

function plain(lines: readonly string[]): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
	return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

describe("markdown code fence chrome", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	/** The exact designed rows: `──╴lang` opener, `──` closer, both in the one
	 * mdCodeBlockBorder token — no hardcoded hex, no second color. */
	it("renders the rule + language tag opener and the bare rule closer", () => {
		const md = getMarkdownTheme();
		const rule = theme.boxSharp.horizontal.repeat(2);
		expect(md.codeBlockFence?.("bash", "open")).toBe(theme.fg("mdCodeBlockBorder", `${rule}╴bash`));
		expect(md.codeBlockFence?.("bash", "close")).toBe(theme.fg("mdCodeBlockBorder", rule));
		expect(md.codeBlockFence?.(undefined, "open")).toBe(theme.fg("mdCodeBlockBorder", rule));
	});

	/** End to end through the Markdown component: a fenced block in transcript
	 * content must surface the designed chrome and never a literal backtick
	 * fence — the regression this whole change exists to prevent. */
	it("renders a fenced block with no literal backticks in the transcript theme", () => {
		const md = new Markdown("intro\n\n```bash\nbun run.ts --jobs 2\n```\n\nafter", 1, 1, getMarkdownTheme());
		const lines = plain(md.render(80));
		expect(lines).toContain(` ${theme.boxSharp.horizontal.repeat(2)}╴bash`);
		expect(lines).toContain(` ${theme.boxSharp.horizontal.repeat(2)}`);
		expect(lines.some(line => line.includes("```"))).toBe(false);
		// The body keeps its content verbatim (indented, highlighted, never dropped).
		expect(lines.some(line => line.includes("bun run.ts --jobs 2"))).toBe(true);
	});
});
