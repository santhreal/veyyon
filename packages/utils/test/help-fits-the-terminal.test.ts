/**
 * Help is laid out for the terminal in front of the user, not for an infinite one.
 *
 * WHY THIS SUITE EXISTS. `veyyon --help` emitted 204 lines of which 85 ran past 80 columns, with a
 * 221-character worst case. Every one of those was re-broken by the terminal at whatever point it
 * reached the edge, with no indent, so a wrapped description ran back to column 0 and read as the
 * next flag. This is the single most-read surface in the product and it was unreadable at the
 * default width.
 *
 * THE CAUSE WAS THE ALIGNMENT RULE, which is what makes it worth pinning rather than just fixing.
 * The gutter was the width of the longest entry, so one flag that spelled out an enum
 * (`--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>`, 58 characters) decided the column
 * for all seventy-odd others and left each of them about fifteen usable columns. A single outlier
 * silently set the layout for everything around it, and nothing measured the result. The
 * `outlier` rows below are the real regression guard: a suite that only checked the maximum line
 * width would pass on a layout where every description was crushed into the right margin.
 *
 * The rows also pin two smaller bugs found while fixing it, both of which produce output that looks
 * broken rather than merely narrow: a wrapped line keeping the space it broke on (invisible trailing
 * bytes, and every continuation indented one column too far), and a name exactly as wide as the
 * gutter padding to zero, which printed `ANTHROPIC_CUSTOM_HEADERSExtra headers ...` as one token.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { renderHelpParagraph, renderHelpTable } from "../src/cli";

/**
 * Pretend the terminal is `columns` wide for one test.
 *
 * `process.stdout.columns` is a property rather than a method, so it cannot be `spyOn`'d. The
 * descriptor is captured and restored in `afterEach` so this cannot leak into another file: a
 * width left behind here would change help layout in any later suite that renders it.
 *
 * `COLUMNS` is cleared alongside it, and restored the same way. The layout consults the environment
 * when stdout reports no width, so a `COLUMNS` inherited from whatever terminal launched `bun test`
 * would silently supply the width the piped-fallback test is trying to prove is ABSENT, and that
 * test would pass or fail according to the runner's window size. Tests that want the environment
 * consulted set it explicitly through `exportedColumns`.
 */
let restoreColumns: (() => void) | undefined;
function terminalWidth(columns: number | undefined): void {
	const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const originalEnv = process.env.COLUMNS;
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true, writable: true });
	delete process.env.COLUMNS;
	restoreColumns = () => {
		if (original) Object.defineProperty(process.stdout, "columns", original);
		else Reflect.deleteProperty(process.stdout, "columns");
		if (originalEnv === undefined) delete process.env.COLUMNS;
		else process.env.COLUMNS = originalEnv;
	};
}

/** Set the exported `COLUMNS` for one test. Only meaningful after `terminalWidth(undefined)`. */
function exportedColumns(value: string): void {
	process.env.COLUMNS = value;
}

afterEach(() => {
	restoreColumns?.();
	restoreColumns = undefined;
});

/** One very long name beside short ones: the shape that broke the layout. */
const OUTLIER_ROWS: ReadonlyArray<readonly [string, string]> = [
	["--model", "Model to use, by fuzzy match against the catalog"],
	["--smol", "Fast model for lightweight work"],
	["--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>", "Override the approval mode for this session"],
	["--no-pty", "Disable PTY-based interactive bash execution"],
];

/** Column at which a line's description starts, or undefined when the line is a bare name. */
function descriptionColumn(line: string): number | undefined {
	const match = /^(\s*\S+)(\s+)\S/.exec(line);
	if (!match) return undefined;
	return (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
}

describe("a rendered help table", () => {
	for (const width of [60, 80, 100]) {
		/**
		 * The headline contract. Anything past the terminal edge is re-wrapped by the terminal with
		 * no indent, which is what made a wrapped description read as a new flag.
		 */
		it(`never exceeds the terminal width at ${width} columns`, () => {
			terminalWidth(width);

			const lines = renderHelpTable(OUTLIER_ROWS);

			expect(lines.length).toBeGreaterThan(0);
			const longest = Math.max(...lines.map(line => line.length));
			expect(longest).toBeLessThanOrEqual(width);
		});
	}

	/**
	 * THE REGRESSION ITSELF. One 58-character entry must not set the column for the short ones. A
	 * maximum-width check cannot see this: the old layout also "fit" once the terminal had wrapped
	 * it, and it was still unusable. So this asserts the short entries keep a real description
	 * column, and that the outlier took its own line rather than dragging everyone right.
	 */
	it("does not let one long entry set the column for the short ones", () => {
		terminalWidth(80);

		const lines = renderHelpTable(OUTLIER_ROWS);

		const shortEntry = lines.find(line => line.includes("--model"));
		expect(shortEntry).toBeDefined();
		const column = descriptionColumn(shortEntry ?? "");
		expect(column).toBeDefined();
		// The old layout put this at 62 of 80. A third of the width is the cap.
		expect(column ?? 0).toBeLessThanOrEqual(Math.floor(80 / 3));
		// Which leaves a description column worth reading, rather than fifteen columns.
		expect(80 - (column ?? 0)).toBeGreaterThanOrEqual(50);

		// The outlier is alone on its line, its description beneath it.
		const outlierIndex = lines.findIndex(line => line.includes("--approval-mode"));
		expect(outlierIndex).toBeGreaterThanOrEqual(0);
		expect(lines[outlierIndex]?.trimEnd()).toBe("  --approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>");
		expect(lines[outlierIndex + 1]).toContain("Override the approval mode");
	});

	/**
	 * The cap is a parameter because the right answer depends on what the left column IS.
	 *
	 * A third suits flag names, which are short beside their prose. It does not suit `veyyon config
	 * list`, whose left column is a dotted setting path routinely past thirty characters: at a third
	 * every such key pushed its value onto a second line even when the value was `true`, growing that
	 * listing from 470 lines to 714 without making one of them easier to read. This pins that a
	 * caller can widen the column, and that widening actually moves it, so the knob cannot quietly
	 * become inert.
	 */
	it("lets a caller widen the gutter when its left column is inherently long", () => {
		terminalWidth(80);
		const rows = [["settings.statusLine.sessionAccent", "true"]] as const;

		const atAThird = renderHelpTable(rows);
		const atAHalf = renderHelpTable(rows, { maxGutterFraction: 1 / 2 });

		// The key is 33 characters plus indent, so a third of 80 cannot hold it and the value is
		// exiled to its own line. Half can, and the pair fits on one.
		expect(atAThird).toHaveLength(2);
		expect(atAHalf).toHaveLength(1);
		expect(atAHalf[0]).toContain("true");
		// Widening must not be a licence to overflow.
		for (const line of atAHalf) expect(line.length).toBeLessThanOrEqual(80);
	});

	/**
	 * A continuation that returns to column 0 reads as the next entry, which is exactly how the
	 * unwrapped output misled: the terminal's own wrap has no indent.
	 */
	it("indents a wrapped description under the description, not under the name", () => {
		terminalWidth(60);

		const lines = renderHelpTable([["--flag", "one two three four five six seven eight nine ten eleven twelve"]]);

		expect(lines.length).toBeGreaterThan(1);
		const column = descriptionColumn(lines[0] ?? "") ?? 0;
		for (const line of lines.slice(1)) {
			expect(line.startsWith(" ".repeat(column))).toBe(true);
			expect(line[column]).not.toBe(" ");
		}
	});

	/**
	 * A name exactly as wide as the gutter padded to zero and butted against its description:
	 * `ANTHROPIC_CUSTOM_HEADERSExtra headers ...`. Reproduced here by sizing a name to the cap.
	 */
	it("always separates a name from its description, even at exactly the gutter width", () => {
		terminalWidth(80);
		const atGutter = "X".repeat(Math.floor(80 / 3) - 2);

		const lines = renderHelpTable([
			[atGutter, "a description that must not touch the name"],
			["SHORT", "another description"],
		]);

		for (const line of lines) {
			// A run-on is a name character immediately followed by a non-name, non-space character.
			// The pattern must exclude `X` itself, or it matches the name's own repeated letters.
			expect(line).not.toMatch(/X[^X\s]/);
		}
		const joined = lines.join("\n");
		expect(joined).toContain(atGutter);
		expect(joined).toContain("a description that must not touch the name");
	});

	/**
	 * Trailing bytes are invisible in a terminal and visible in every diff, snapshot, and pipe.
	 * They came from wrapping without trimming, which also mis-indented every continuation line.
	 */
	it("emits no trailing whitespace", () => {
		terminalWidth(60);

		const lines = [
			...renderHelpTable(OUTLIER_ROWS),
			...renderHelpParagraph("a sentence long enough that it certainly has to wrap at sixty columns wide"),
		];

		for (const line of lines) expect(line).toBe(line.trimEnd());
	});

	/** An unknown width is the piped case, which must still produce a bounded, readable layout. */
	it("falls back to a readable width when the terminal reports none", () => {
		terminalWidth(undefined);

		const lines = renderHelpTable(OUTLIER_ROWS);

		expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(80);
	});

	/**
	 * A very wide window should not produce lines too long to track back to their flag, and a very
	 * narrow one should not collapse the description column to nothing.
	 */
	it("clamps an extreme terminal at both ends", () => {
		terminalWidth(400);
		const wide = renderHelpTable(OUTLIER_ROWS);
		expect(Math.max(...wide.map(line => line.length))).toBeLessThanOrEqual(100);
		restoreColumns?.();

		terminalWidth(20);
		const narrow = renderHelpTable(OUTLIER_ROWS);
		// Still wraps rather than emitting one enormous line.
		expect(Math.max(...narrow.map(line => line.length))).toBeLessThanOrEqual(60);
	});

	/**
	 * Piping help into a pager is the normal way to read a long one, and that is exactly when stdout
	 * stops reporting a width. Laying out for 80 inside a 60-column pane put 113 lines past the edge,
	 * which is the original wrapping bug arriving by a second route, so the exported width is
	 * consulted before falling back.
	 */
	it("uses the exported COLUMNS when stdout reports no width", () => {
		terminalWidth(undefined);
		exportedColumns("60");

		const lines = renderHelpTable(OUTLIER_ROWS);

		expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(60);
	});

	/** A nonsense width is no evidence of width, so it takes the conventional fallback, not the floor. */
	it("ignores an unparseable COLUMNS rather than clamping it", () => {
		terminalWidth(undefined);
		exportedColumns("wide-ish");

		const lines = renderHelpTable(OUTLIER_ROWS);
		const longest = Math.max(...lines.map(line => line.length));

		expect(longest).toBeLessThanOrEqual(80);
		// Not squeezed to the 60 floor: an invalid value means "unknown", not "narrow".
		expect(longest).toBeGreaterThan(60);
	});

	/**
	 * THE OVERFLOW CONTRACT, and the reason it is a contract rather than a bug.
	 *
	 * Three help lines still run past a 60-column terminal: `--approval-mode=<plan|ask|auto-edit|...>`
	 * and a session path. Each is ONE token with nowhere to break, and force-breaking them (`hard`
	 * wrapping) would split a flag spelling or a path mid-word, so the reader could no longer
	 * copy-paste either. Letting the terminal wrap those once is the better trade.
	 *
	 * What must never happen is overflowing a line we COULD have broken. That is the actual defect,
	 * and it is what this asserts: every over-width line is a single unbreakable token. A future
	 * change that stops wrapping ordinary prose fails here even though the raw line count would look
	 * similar to today's.
	 */
	it("only ever overflows on a token with nowhere to break", () => {
		terminalWidth(60);

		const lines = [
			...renderHelpTable([
				["--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>", "how tool calls are approved"],
				["--short", "an ordinary description with plenty of spaces in it to break on"],
			]),
			...renderHelpParagraph("ordinary prose that is quite long and has many spaces available for breaking"),
		];

		for (const line of lines) {
			if (line.length <= 60) continue;
			// Over-width is tolerated only when the content is one word: no interior space to use.
			expect(line.trim().split(/\s+/)).toHaveLength(1);
		}
	});
});

describe("a rendered help paragraph", () => {
	/** Prose interleaved into a table read as a variable with an absurdly long name. */
	it("wraps prose to the terminal and indents every line alike", () => {
		terminalWidth(60);

		const lines = renderHelpParagraph(
			"Without --profile or a profile env var, the global config decides which profile launches.",
		);

		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(line.startsWith("  ")).toBe(true);
			expect(line.length).toBeLessThanOrEqual(60);
			expect(line).toBe(line.trimEnd());
		}
		// The prose survives the wrap intact, word for word.
		expect(lines.map(line => line.trim()).join(" ")).toBe(
			"Without --profile or a profile env var, the global config decides which profile launches.",
		);
	});
});
