import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import {
	effortStepItems,
	formatSelectorSummary,
	renderEffortStep,
} from "@veyyon/coding-agent/modes/components/effort-picker";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { Container } from "@veyyon/tui";

const twoTierModel = buildModel({
	id: "two-tier",
	name: "Two tier",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
});

const mandatoryTwoTierModel: Model = {
	...twoTierModel,
	id: "mandatory-two-tier",
	thinking: { ...twoTierModel.thinking!, requiresEffort: true },
};

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

/**
 * The one effort-picker step is shared by every model slot that carries a
 * thinking effort. These tests assert the stored selectors and the exact
 * model-specific variant list rather than merely proving that a list rendered.
 */
describe("renderEffortStep", () => {
	/** A named model variant must survive as the selector suffix every resolver consumes. */
	it("persists the selector with the chosen level as a `:suffix`", () => {
		let persisted: string | undefined;
		const list = renderEffortStep(
			new Container(),
			"test/two-tier",
			twoTierModel,
			value => {
				persisted = value;
			},
			() => {},
		);

		list.onSelect?.({ value: "high", label: "high" });

		expect(persisted).toBe("test/two-tier:high");
	});

	/** The explicit base row must remove a stale effort suffix instead of inventing a default level. */
	it("persists the bare selector when Model default is chosen", () => {
		let persisted: string | undefined;
		const list = renderEffortStep(
			new Container(),
			"test/two-tier",
			twoTierModel,
			value => {
				persisted = value;
			},
			() => {},
		);

		list.onSelect?.({ value: "", label: "Model default" });

		expect(persisted).toBe("test/two-tier");
	});

	/** Cancelling the second step must not overwrite the model chain or role being edited. */
	it("routes Esc to the back callback without persisting", () => {
		let persisted: string | undefined;
		let backCalls = 0;
		const list = renderEffortStep(
			new Container(),
			"test/two-tier",
			twoTierModel,
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

	/** A narrow provider ladder must not display unsupported medium, xhigh, or max variants. */
	it("offers only the selected model's valid variants", () => {
		const items = effortStepItems(twoTierModel);

		expect(items.map(item => item.value)).toEqual(["", "off", "auto", "low", "high"]);
		expect(items[0]?.label).toBe("Model default");
		expect(items.find(item => item.value === "auto")?.description).toBe("Choose per prompt from low, high");
	});

	/** Reasoning-required models must not offer an Off choice that the provider will reject or ignore. */
	it("omits Off when the model requires reasoning", () => {
		expect(effortStepItems(mandatoryTwoTierModel).map(item => item.value)).toEqual(["", "auto", "low", "high"]);
	});
});

describe("formatSelectorSummary", () => {
	/** Settings rows must render a suffix as a readable effort without changing its value. */
	it("renders an effort suffix as a readable ` · level`", () => {
		expect(formatSelectorSummary("anthropic/claude-sonnet-4-5:high")).toBe(
			"anthropic/claude-sonnet-4-5 · high",
		);
	});

	/** A suffix-free model selector must remain byte-for-byte recognizable. */
	it("leaves a bare selector unchanged", () => {
		expect(formatSelectorSummary("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
	});

	/** Config whitespace must not leak into the settings summary. */
	it("trims surrounding whitespace", () => {
		expect(formatSelectorSummary("  openai/gpt-x:low  ")).toBe("openai/gpt-x · low");
	});

	/** A provider model ID ending in an unrelated colon token must not be misread as an effort. */
	it("leaves a model id that legitimately ends in a non-level colon token intact", () => {
		expect(formatSelectorSummary("openrouter/some-model:max")).toBe("openrouter/some-model:max");
	});
});
