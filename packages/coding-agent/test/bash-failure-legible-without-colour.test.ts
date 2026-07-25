/**
 * A failed shell command must be legible with every colour stripped.
 *
 * The bash renderer sets `showHeader: false`, because a "Bash" title above the
 * `$ command` line only repeats it. That also suppressed the FAILURE marker: the
 * block still passed `state: "error"`, but state only reaches the border TINT, so
 * the sole difference between a command that failed and one that succeeded was the
 * colour of the frame. Strip the colour — a monochrome terminal, a colour-blind
 * reader, a transcript pasted into an issue — and a failing run was byte-identical
 * to a clean one. The inline TUI paints no backgrounds either (UI-1), so there was
 * no second channel to fall back on.
 *
 * Every assertion here runs on the rendered lines with SGR sequences removed,
 * which is the whole point: if these tests can tell the two apart, so can a reader
 * whose terminal shows no colour.
 *
 * The second case is the one no unit test covered: bash reports a non-zero exit
 * through `details.exitCode`, but aborts, timeouts, and spawn failures propagate as
 * THROWN errors, and the framework turns those into a result that is flagged
 * `isError` with no bash details at all. The exit chip is keyed on a numeric exit
 * code, so that class of failure previously rendered no marker of any kind.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

const WIDTH = 76;

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme();
});

/** Render a completed bash block and strip all styling. */
function render(opts: { details?: unknown; isError: boolean; width?: number }): string {
	const component = new ToolExecutionComponent("bash", { command: "grep zzz missing.txt" }, {}, undefined, uiStub);
	component.updateResult(
		{ content: [{ type: "text", text: "no matches" }], details: opts.details, isError: opts.isError } as never,
		false,
	);
	return component
		.render(opts.width ?? WIDTH)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
}

describe("a command that exited non-zero", () => {
	it("differs from a clean run with all styling stripped", () => {
		const failed = render({ details: { exitCode: 1 }, isError: true });
		const clean = render({ details: { exitCode: 0 }, isError: false });

		expect(failed).not.toBe(clean);
	});

	it("marks the frame with an error glyph and the word", () => {
		const failed = render({ details: { exitCode: 1 }, isError: true });

		expect(failed).toContain("✗ failed");
	});

	it("still reports the exit code", () => {
		expect(render({ details: { exitCode: 1 }, isError: true })).toContain("Exit: 1");
	});

	/** The signal is the difference between "the command said no" and "something
	 * killed it", and it belongs beside the code rather than only in the output. */
	it("names the signal beside the code when one killed the command", () => {
		const failed = render({ details: { exitCode: 137, signal: 9 }, isError: true });

		expect(failed).toContain("Exit: 137");
		expect(failed).toMatch(/Exit: 137 \(\w+/);
	});
});

describe("a failure that carries no exit code", () => {
	/** Aborts, timeouts, and spawn failures throw, and the resulting error result
	 * has no bash details. The exit chip is keyed on a numeric exit code, so this
	 * class of failure used to render with NO marker at all. */
	it("is still marked as failed", () => {
		expect(render({ details: undefined, isError: true })).toContain("✗ failed");
	});

	it("is marked when details exist but hold no exit code", () => {
		expect(render({ details: { timeoutSeconds: 30 }, isError: true })).toContain("✗ failed");
	});

	it("differs from a clean run with all styling stripped", () => {
		expect(render({ details: undefined, isError: true })).not.toBe(render({ details: undefined, isError: false }));
	});

	/** No exit code means no exit chip: inventing one, or printing "Exit:
	 * undefined", would be worse than the missing marker this fixes. */
	it("claims no exit code it does not have", () => {
		const failed = render({ details: undefined, isError: true });

		expect(failed).not.toContain("Exit:");
		expect(failed).not.toContain("undefined");
	});
});

describe("a clean run", () => {
	/** The marker must cost a passing command nothing — not a row, not a word.
	 * `showHeader: false` exists so the frame does not repeat the `$` line. */
	it("carries no failure marker and no title", () => {
		const clean = render({ details: { exitCode: 0 }, isError: false });

		expect(clean).not.toContain("failed");
		expect(clean).not.toContain("✗");
		expect(clean).not.toContain("Bash");
	});

	it("still shows the command and its output", () => {
		const clean = render({ details: { exitCode: 0 }, isError: false });

		expect(clean).toContain("$ grep zzz missing.txt");
		expect(clean).toContain("no matches");
	});
});

describe("the marker across widths", () => {
	/** The header shares the top border with the frame's fill, so a narrow width
	 * is where a label gets truncated away. The outcome must survive it. */
	it("survives at 80, 120, and 200 columns", () => {
		for (const width of [80, 120, 200]) {
			expect(render({ details: { exitCode: 2 }, isError: true, width }), `width ${width}`).toContain("✗ failed");
		}
	});
});
