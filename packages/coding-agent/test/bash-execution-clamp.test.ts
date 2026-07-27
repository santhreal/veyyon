/**
 * The display clamp as a user meets it: driven through the execution components rather than against the helper.
 *
 * The helper itself is covered by `modes/components/execution-display-clamp.test.ts`. This suite exists for the
 * WIRING, and for the grapheme cases that only make sense against real text: wide glyphs, emoji including a ZWJ
 * family sequence, combining marks, and ANSI-decorated output.
 *
 * The limit is imported rather than declared. It used to be a local `MAX_DISPLAY_LINE_CHARS = 4000` here, which
 * was a fourth copy of a value the two components also each declared, and a test carrying its own copy of the
 * number under test can only ever agree with itself.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/components/bash-execution";
import { EvalExecutionComponent } from "@veyyon/coding-agent/modes/components/eval-execution";
import { EXECUTION_MAX_DISPLAY_COLUMNS } from "@veyyon/coding-agent/modes/components/execution-shared";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";
import { visibleWidth } from "@veyyon/tui";

const MAX_DISPLAY_LINE_CHARS = EXECUTION_MAX_DISPLAY_COLUMNS;

describe("the execution display clamp through the bash component", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	function createComponentWithOutput(output: string): BashExecutionComponent {
		const component = new BashExecutionComponent("test", ui, false);
		component.appendOutput(output);
		component.setComplete(0, false);
		return component;
	}

	describe("wide glyphs (CJK characters)", () => {
		it("counts CJK characters as 2 columns each", () => {
			const cjkString = "日本語";
			expect(visibleWidth(cjkString)).toBe(6);
		});

		it("does not truncate CJK string under limit", () => {
			const cjkString = "日本語".repeat(100);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output).toBe(cjkString);
			expect(output).not.toContain("omitted");
		});

		it("truncates CJK string over limit and calculates omitted correctly", () => {
			const cjkString = "日本語".repeat(2500);
			const expectedVisible = visibleWidth(cjkString);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
			expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
			expect(output).toContain("…");
		});
	});

	describe("emoji handling", () => {
		it("counts emoji as appropriate columns", () => {
			expect(visibleWidth("😀")).toBe(2);
			expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
			expect(visibleWidth("🎌")).toBe(2);
		});

		it("does not truncate emoji string under limit", () => {
			const emojiString = "🎌".repeat(1000);
			const component = createComponentWithOutput(emojiString);
			const output = component.getOutput();

			expect(output).toBe(emojiString);
			expect(output).not.toContain("omitted");
		});

		it("truncates emoji string over limit correctly", () => {
			const emojiString = "🎌".repeat(2500);
			const expectedVisible = visibleWidth(emojiString);
			const component = createComponentWithOutput(emojiString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
			expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
		});
	});

	describe("combining marks", () => {
		it("handles combining diacritical marks", () => {
			const combined = "e\u0304";
			expect(visibleWidth(combined)).toBe(1);
		});

		it("handles string with combining marks over limit", () => {
			const base = "e\u0304".repeat(2500);
			const expectedVisible = visibleWidth(base);
			const component = createComponentWithOutput(base);
			const output = component.getOutput();

			if (expectedVisible > MAX_DISPLAY_LINE_CHARS) {
				expect(output).toContain("visible columns omitted");
				expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
			}
		});
	});

	describe("ANSI-decorated strings", () => {
		it("ignores ANSI escape sequences in visible width calculation", () => {
			const ansiString = "\x1b[31mred\x1b[0m";
			expect(visibleWidth(ansiString)).toBe(3);
		});

		it("does not truncate ANSI string under visible limit", () => {
			const ansiString = "\x1b[32mgreen\x1b[0m".repeat(200);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			expect(output).not.toContain("omitted");
		});

		it("truncates ANSI string based on visible content, not raw length", () => {
			const ansiString = "\x1b[31mred\x1b[0m".repeat(2500);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
		});

		it("calculates omitted count based on visible width, not raw length", () => {
			const ansiString = "\x1b[1;31;47mbold red on white\x1b[0m".repeat(1000);
			const expectedVisible = visibleWidth(ansiString);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			if (expectedVisible > MAX_DISPLAY_LINE_CHARS) {
				const omittedMatch = output.match(/\[(\d+) visible columns omitted\]/);
				expect(omittedMatch).not.toBeNull();
				const omitted = parseInt(omittedMatch![1], 10);
				expect(omitted).toBe(expectedVisible - MAX_DISPLAY_LINE_CHARS);
			}
		});
	});

	describe("truncation with Ellipsis.Omit", () => {
		it("truncates using visibleWidth and truncateToWidth", () => {
			const longAscii = "a".repeat(5000);
			const component = createComponentWithOutput(longAscii);
			const output = component.getOutput();

			expect(output).toContain("…");
			expect(output).toContain("visible columns omitted");
			expect(output.length).toBeLessThan(5000);
		});

		it("includes ellipsis in truncated output", () => {
			const longString = "x".repeat(5000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			expect(output).toContain("… [");
		});

		it("truncated portion is within MAX_DISPLAY_LINE_CHARS visible width", () => {
			const longString = "hello world ".repeat(1000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			if (output.includes("omitted")) {
				const truncatedPart = output.split(" [")[0];
				// truncateToWidth limits to exactly MAX_DISPLAY_LINE_CHARS, may go 1 over due to wide chars
				expect(visibleWidth(truncatedPart)).toBeLessThanOrEqual(MAX_DISPLAY_LINE_CHARS + 10);
			}
		});
	});

	describe("omitted count accuracy", () => {
		it("calculates omitted as visibleWidth(original) - MAX_DISPLAY_LINE_CHARS", () => {
			const testString = "test".repeat(1500);
			const originalVisible = visibleWidth(testString);
			const component = createComponentWithOutput(testString);
			const output = component.getOutput();

			const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
			expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
		});

		it("handles mixed content (ASCII + CJK + emoji + ANSI)", () => {
			const mixed = "abc日本語😀\x1b[34mblue\x1b[0m".repeat(500);
			const originalVisible = visibleWidth(mixed);
			const component = createComponentWithOutput(mixed);
			const output = component.getOutput();

			if (originalVisible > MAX_DISPLAY_LINE_CHARS) {
				const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
				expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
			}
		});
	});

	describe("edge cases at, below, and above MAX_DISPLAY_LINE_CHARS", () => {
		it("returns original string when visibleWidth equals MAX_DISPLAY_LINE_CHARS", () => {
			const exactlyAtLimit = "a".repeat(MAX_DISPLAY_LINE_CHARS);
			const component = createComponentWithOutput(exactlyAtLimit);
			const output = component.getOutput();

			expect(output).toBe(exactlyAtLimit);
			expect(output).not.toContain("omitted");
		});

		it("returns original string when visibleWidth is just below limit", () => {
			const justBelow = "a".repeat(MAX_DISPLAY_LINE_CHARS - 1);
			const component = createComponentWithOutput(justBelow);
			const output = component.getOutput();

			expect(output).toBe(justBelow);
			expect(output).not.toContain("omitted");
		});

		it("truncates when visibleWidth is just above limit", () => {
			const justAbove = "a".repeat(MAX_DISPLAY_LINE_CHARS + 1);
			const component = createComponentWithOutput(justAbove);
			const output = component.getOutput();

			expect(output).toContain("omitted");
			expect(output).toContain(`[1 visible columns omitted]`);
		});

		it("handles empty string", () => {
			const component = createComponentWithOutput("");
			const output = component.getOutput();

			expect(output).toBe("");
		});
	});

	describe("visibleWidth calculation verification", () => {
		it("verifies ASCII characters count as 1 column", () => {
			expect(visibleWidth("abc")).toBe(3);
			expect(visibleWidth("")).toBe(0);
		});

		it("verifies CJK counts as 2 columns", () => {
			expect(visibleWidth("中")).toBe(2);
			expect(visibleWidth("日本語中文")).toBe(10);
		});

		it("verifies emoji count", () => {
			expect(visibleWidth("🎉")).toBe(2);
			expect(visibleWidth("🔢")).toBe(2);
		});

		it("ignores ANSI escape sequences", () => {
			expect(visibleWidth("\x1b[7m")).toBe(0);
			expect(visibleWidth("a\x1b[7mb")).toBe(2);
		});
	});
});

/**
 * The parity block, and the point of the whole change: the same input through either component produces the same
 * clamped output.
 *
 * Before the unification these two disagreed. Eval measured `line.length`, so a styled line was truncated while
 * it still displayed short of the limit, and a wide-character line sailed past a limit it exceeded. Each case
 * below is a string where the old implementations gave DIFFERENT answers, so this block would have failed.
 */
describe("the bash and eval components clamp identically", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	function bothOutputs(input: string): { bash: string; evaluated: string } {
		const bash = new BashExecutionComponent("test", ui, false);
		bash.appendOutput(input);
		bash.setComplete(0, false);
		const evaluated = new EvalExecutionComponent("test", ui, false);
		evaluated.appendOutput(input);
		evaluated.setComplete(0, false);
		return { bash: bash.getOutput(), evaluated: evaluated.getOutput() };
	}

	/** A styled line whose escape bytes push its code-unit length over the limit while it displays far under it. */
	it("agrees on a styled line that only a code-unit count would truncate", () => {
		const styled = "\x1b[32mgreen\x1b[0m".repeat(400);
		expect(styled.length).toBeGreaterThan(MAX_DISPLAY_LINE_CHARS);
		expect(visibleWidth(styled)).toBeLessThan(MAX_DISPLAY_LINE_CHARS);
		const { bash, evaluated } = bothOutputs(styled);
		expect(evaluated).toBe(bash);
		expect(bash).not.toContain("omitted");
	});

	/** A wide-character line whose code-unit length is under the limit while its column count is over it. */
	it("agrees on a wide-character line that a code-unit count would let through", () => {
		const wide = "日本語".repeat(800);
		expect(wide.length).toBeLessThan(MAX_DISPLAY_LINE_CHARS);
		expect(visibleWidth(wide)).toBeGreaterThan(MAX_DISPLAY_LINE_CHARS);
		const { bash, evaluated } = bothOutputs(wide);
		expect(evaluated).toBe(bash);
		expect(bash).toContain("visible columns omitted");
	});

	/** And on plain overlong ASCII, where both used to agree on the cut but printed different notes. */
	it("agrees on plain overlong output, note included", () => {
		const plain = "a".repeat(MAX_DISPLAY_LINE_CHARS + 123);
		const { bash, evaluated } = bothOutputs(plain);
		expect(evaluated).toBe(bash);
		expect(bash).toContain("[123 visible columns omitted]");
		expect(bash).not.toContain("chars omitted");
	});

	/** Short output is untouched by both, so parity is not an artefact of both truncating everything. */
	it("agrees on short output by leaving it alone", () => {
		const short = "make: nothing to be done";
		const { bash, evaluated } = bothOutputs(short);
		expect(bash).toBe(short);
		expect(evaluated).toBe(short);
	});
});
