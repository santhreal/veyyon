import { beforeAll, describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { QueueModeSelectorComponent } from "@veyyon/coding-agent/modes/components/queue-mode-selector";
import { ThemeSelectorComponent } from "@veyyon/coding-agent/modes/components/theme-selector";
import { ThinkingSelectorComponent } from "@veyyon/coding-agent/modes/components/thinking-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";
import type { SgrMouseEvent } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

function leftClick(line: number): SgrMouseEvent {
	return { button: 0, col: 0, row: line, release: false, wheel: null, motion: false, leftClick: true };
}

/**
 * Every wrapper mounts a single-line top DynamicBorder before its SelectList,
 * so routed component-local lines are offset by one. These guard the
 * off-by-one that would let a top-border click select the first row. Each case
 * asserts line 0 (border) is inert and line 1 (first list row) confirms.
 */
describe("inline-picker wrapper routeMouse offset", () => {
	it("ThemeSelectorComponent ignores the border row and selects the first theme below it", () => {
		let selected: string | undefined;
		const component = new ThemeSelectorComponent(
			"alpha",
			["alpha", "beta"],
			value => {
				selected = value;
			},
			() => {},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(0), 0, 0);
		expect(selected).toBeUndefined();

		component.routeMouse(leftClick(1), 1, 0);
		expect(selected).toBe("alpha");
	});

	/** Thinking's new Default row must preserve the same one-line border offset as native variants. */
	it("ThinkingSelectorComponent ignores the border row and selects Default below it", () => {
		let selected: ConfiguredThinkingLevel | undefined = Effort.High;
		let selections = 0;
		const model = buildModel({
			id: "two-tier",
			name: "Two tier",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		});
		const component = new ThinkingSelectorComponent(
			Effort.Low,
			model,
			value => {
				selected = value;
				selections += 1;
			},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(0), 0, 0);
		expect(selections).toBe(0);
		expect(selected).toBe(Effort.High);

		component.routeMouse(leftClick(1), 1, 0);
		expect(selections).toBe(1);
		expect(selected).toBeUndefined();
	});

	it("QueueModeSelectorComponent ignores the border row and selects the first mode below it", () => {
		let selected: "all" | "one-at-a-time" | undefined;
		const component = new QueueModeSelectorComponent(
			"all",
			value => {
				selected = value;
			},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(0), 0, 0);
		expect(selected).toBeUndefined();

		// First SelectList row is "one-at-a-time" regardless of the preselected mode.
		component.routeMouse(leftClick(1), 1, 0);
		expect(selected).toBe("one-at-a-time");
	});
});
