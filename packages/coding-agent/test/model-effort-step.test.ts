import { beforeAll, describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { effortStepItems, renderEffortStep } from "@veyyon/coding-agent/modes/components/settings-selector";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { Container } from "@veyyon/tui";

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

/**
 * The one effort-picker step is shared by every model slot that carries a
 * thinking effort (single-slot compaction/subagent selectors and the role
 * list). These assert the exact stored value, not that a list rendered.
 */
describe("renderEffortStep", () => {
	it("persists the selector with the chosen level as a `:suffix`", () => {
		let persisted: string | undefined;
		const list = renderEffortStep(
			new Container(),
			"anthropic/claude-sonnet-4-5",
			[Effort.Low, Effort.High],
			value => {
				persisted = value;
			},
			() => {},
		);

		list.onSelect?.({ value: "high", label: "high" });

		expect(persisted).toBe("anthropic/claude-sonnet-4-5:high");
	});

	it("persists the bare selector when the (model default thinking) row is chosen", () => {
		let persisted: string | undefined;
		const list = renderEffortStep(
			new Container(),
			"anthropic/claude-sonnet-4-5",
			[Effort.Low, Effort.High],
			value => {
				persisted = value;
			},
			() => {},
		);

		// The first row is always the empty "model default" entry.
		list.onSelect?.({ value: "", label: "(model default thinking)" });

		expect(persisted).toBe("anthropic/claude-sonnet-4-5");
	});

	it("routes Esc to the back callback without persisting", () => {
		let persisted: string | undefined;
		let backCalls = 0;
		const list = renderEffortStep(
			new Container(),
			"anthropic/claude-sonnet-4-5",
			[Effort.Low, Effort.High],
			value => {
				persisted = value;
			},
			() => {
				backCalls += 1;
			},
		);

		list.onCancel?.();

		expect(backCalls).toBe(1);
		expect(persisted).toBeUndefined();
	});

	it("offers the model-default row plus every supported effort, in order", () => {
		const items = effortStepItems([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);

		expect(items.map(item => item.value)).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
		expect(items[0]?.label).toBe("(model default thinking)");
	});
});
