/**
 * WHY: the autoswarm setup console operated on UTF-16 code units (slice) in
 * `backspace` and `textWindow`, so typing a goal or model list with emojis,
 * CJK characters, or combining marks could split a surrogate pair or exceed
 * the allocated column width. Shift-tab also failed to navigate fields backwards
 * although tab moved forward.
 *
 * The class this closes is text editing and windowing over multi-byte Unicode
 * grapheme clusters in TUI input fields, ensuring surrogate pairs and combining
 * marks are deleted and windowed as single units, and field focus navigation is
 * bidirectional.
 *
 * What it does not catch: terminal-level IME composition events, which are
 * handled by the host terminal.
 */
import { describe, expect, it } from "bun:test";
import { handleSetupKey, renderSetupConsole, SwarmSetupModel } from "@veyyon/coding-agent/autoresearch/setup-console";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";

const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const BACKSPACE = "\x7f";
const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";

describe("a setup console handles multibyte characters and shift-tab", () => {
	it("deletes a multi-byte emoji or combining mark in a single backspace", () => {
		const model = new SwarmSetupModel({
			goal: "optimize 🚀",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: [],
		});
		expect(model.field).toBe("goal");

		// Backspace once should remove the entire 🚀 emoji, not half a surrogate pair
		handleSetupKey(model, BACKSPACE);
		expect(model.goal).toBe("optimize ");

		// Type combining mark e + acute (e\u0301)
		model.typeText("e\u0301");
		expect(model.goal).toBe("optimize e\u0301");
		handleSetupKey(model, BACKSPACE);
		expect(model.goal).toBe("optimize ");

		// Type CJK characters
		model.typeText("优化");
		expect(model.goal).toBe("optimize 优化");
		handleSetupKey(model, BACKSPACE);
		expect(model.goal).toBe("optimize 优");
		handleSetupKey(model, BACKSPACE);
		expect(model.goal).toBe("optimize ");
	});

	it("windows long text with CJK and emojis without exceeding width or splitting surrogate pairs", () => {
		// A long goal with CJK and emojis
		const model = new SwarmSetupModel({
			goal: "目标：优化 tokenizer 速度 🚀⚡🏎️💨",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: [],
		});

		// Render at various narrow and wide widths: the window keeps the end of the
		// value, where the caret is, and never draws past the terminal edge.
		let windowed = 0;
		for (const width of [30, 40, 60, 80]) {
			const lines = renderSetupConsole(model, width, plainTheme);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			const goalLine = lines.find(line => line.includes("Goal")) ?? "";
			expect(goalLine).not.toBe("");
			expect(goalLine).not.toContain("\uFFFD");
			expect(goalLine).toContain("💨");
			if (goalLine.includes("…")) {
				windowed += 1;
				expect(goalLine).not.toContain("目标");
			}
		}
		expect(windowed).toBeGreaterThan(0);
	});

	it("moves field selection backward on shift-tab", () => {
		const model = new SwarmSetupModel({
			goal: "make it faster",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: [],
		});
		expect(model.field).toBe("goal");

		// Tab moves forward: goal -> breadth -> models -> attempts -> certify
		handleSetupKey(model, TAB);
		expect(model.field).toBe("breadth");
		handleSetupKey(model, TAB);
		expect(model.field).toBe("models");

		// Shift-Tab moves backward: models -> breadth -> goal
		handleSetupKey(model, SHIFT_TAB);
		expect(model.field).toBe("breadth");
		handleSetupKey(model, SHIFT_TAB);
		expect(model.field).toBe("goal");

		// Shift-Tab from goal wraps to last field (certify)
		handleSetupKey(model, SHIFT_TAB);
		expect(model.field).toBe("certify");
	});

	it("drops pasted chunks containing ESC", () => {
		const model = new SwarmSetupModel({
			goal: "start",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: [],
		});

		handleSetupKey(model, "paste \x1b with escape");
		// Pasted chunk with ESC should be discarded
		expect(model.goal).toBe("start");
	});
});
