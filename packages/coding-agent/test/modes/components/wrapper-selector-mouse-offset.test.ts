import { beforeAll, describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/pi-ai";
import { QueueModeSelectorComponent } from "@veyyon/pi-coding-agent/modes/components/queue-mode-selector";
import { ThemeSelectorComponent } from "@veyyon/pi-coding-agent/modes/components/theme-selector";
import { ThinkingSelectorComponent } from "@veyyon/pi-coding-agent/modes/components/thinking-selector";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import type { SgrMouseEvent } from "@veyyon/pi-tui";

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

	it("ThinkingSelectorComponent ignores the border row and selects the first level below it", () => {
		let selected: Effort | undefined;
		const levels = [Effort.Low, Effort.High];
		const component = new ThinkingSelectorComponent(
			Effort.Low,
			levels,
			value => {
				selected = value;
			},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(0), 0, 0);
		expect(selected).toBeUndefined();

		component.routeMouse(leftClick(1), 1, 0);
		expect(selected).toBe(Effort.Low);
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
