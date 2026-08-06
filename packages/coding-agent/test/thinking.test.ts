import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	clampAutoThinkingEffort,
	concreteThinkingLevel,
	configuredThinkingLevelsForModel,
	getConfiguredThinkingLevelMetadata,
	getThinkingLevelMetadata,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	shouldDisableReasoning,
	thinkingLevelArgHint,
	toReasoningEffort,
} from "@veyyon/coding-agent/thinking";

/**
 * thinking.ts is the single home for parsing every thinking/reasoning selector the
 * user can type (`--thinking`, `model:suffix`, role values, config) and mapping it
 * to the concrete effort sent to a provider. It was exercised only indirectly. A
 * regression here silently changes how much a model actually reasons, or rejects a
 * valid selector. These pin the load-bearing contracts:
 *
 *  - abbreviation parsing (`med` -> medium, `xhi` -> xhigh) with a two-char minimum
 *    so a single ambiguous letter is rejected, and unknown/blank input -> undefined;
 *  - the deliberate strictness split: parseThinkingLevel rejects `auto` (so
 *    model-suffix parsing stays clean), parseConfiguredThinkingLevel accepts it, and
 *    parseCliThinkingLevel additionally rejects `inherit`;
 *  - off/inherit collapsing to "no effort" and off alone requesting disablement;
 *  - the auto-effort clamp flooring at Low and snapping down to the requested level.
 */

describe("parseEffort", () => {
	it("accepts exact effort names", () => {
		expect(parseEffort("minimal")).toBe(Effort.Minimal);
		expect(parseEffort("high")).toBe(Effort.High);
		expect(parseEffort("max")).toBe(Effort.Max);
	});

	it("accepts unambiguous two-char-or-longer abbreviations", () => {
		expect(parseEffort("med")).toBe(Effort.Medium);
		expect(parseEffort("xhi")).toBe(Effort.XHigh);
		expect(parseEffort("lo")).toBe(Effort.Low);
		expect(parseEffort("ma")).toBe(Effort.Max);
	});

	it("rejects a single-character selector as ambiguous", () => {
		expect(parseEffort("m")).toBeUndefined();
		expect(parseEffort("l")).toBeUndefined();
	});

	it("returns undefined for an unknown value or nothing", () => {
		expect(parseEffort("zz")).toBeUndefined();
		expect(parseEffort("bogus")).toBeUndefined();
		expect(parseEffort("")).toBeUndefined();
		expect(parseEffort(null)).toBeUndefined();
		expect(parseEffort(undefined)).toBeUndefined();
	});
});

describe("parseThinkingLevel", () => {
	it("accepts every concrete level including off and inherit", () => {
		expect(parseThinkingLevel("off")).toBe(ThinkingLevel.Off);
		expect(parseThinkingLevel("inherit")).toBe(ThinkingLevel.Inherit);
		expect(parseThinkingLevel("in")).toBe(ThinkingLevel.Inherit);
		expect(parseThinkingLevel("high")).toBe(ThinkingLevel.High);
	});

	it("rejects the auto sentinel so model-suffix parsing stays strict", () => {
		expect(parseThinkingLevel("auto")).toBeUndefined();
	});
});

describe("parseConfiguredThinkingLevel", () => {
	it("accepts auto in addition to every concrete level", () => {
		expect(parseConfiguredThinkingLevel("auto")).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel("high")).toBe(ThinkingLevel.High);
		expect(parseConfiguredThinkingLevel("inherit")).toBe(ThinkingLevel.Inherit);
	});

	it("returns undefined for an unknown value", () => {
		expect(parseConfiguredThinkingLevel("nope")).toBeUndefined();
	});
});

describe("parseCliThinkingLevel", () => {
	it("accepts off, auto, and concrete efforts", () => {
		expect(parseCliThinkingLevel("off")).toBe(ThinkingLevel.Off);
		expect(parseCliThinkingLevel("auto")).toBe(AUTO_THINKING);
		expect(parseCliThinkingLevel("medium")).toBe(ThinkingLevel.Medium);
	});

	it("rejects inherit, which would resolve back to the provider default", () => {
		expect(parseCliThinkingLevel("inherit")).toBeUndefined();
	});

	/** CLI help must use the same special-first order as interactive variant controls. */
	it("lists the CLI levels in display order: off, auto, then native efforts", () => {
		expect(CLI_THINKING_LEVELS).toEqual(["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("toReasoningEffort and shouldDisableReasoning", () => {
	it("collapses off, inherit, and undefined to no effort", () => {
		expect(toReasoningEffort(ThinkingLevel.Off)).toBeUndefined();
		expect(toReasoningEffort(ThinkingLevel.Inherit)).toBeUndefined();
		expect(toReasoningEffort(undefined)).toBeUndefined();
	});

	it("passes a concrete level through as its effort", () => {
		expect(toReasoningEffort(ThinkingLevel.High)).toBe(Effort.High);
		expect(toReasoningEffort(ThinkingLevel.Minimal)).toBe(Effort.Minimal);
	});

	it("requests disablement only for an explicit off", () => {
		expect(shouldDisableReasoning(ThinkingLevel.Off)).toBe(true);
		expect(shouldDisableReasoning(ThinkingLevel.High)).toBe(false);
		expect(shouldDisableReasoning(undefined)).toBe(false);
	});
});

describe("concreteThinkingLevel", () => {
	it("maps the auto sentinel to undefined and passes concrete levels through", () => {
		expect(concreteThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(concreteThinkingLevel(ThinkingLevel.High)).toBe(ThinkingLevel.High);
		expect(concreteThinkingLevel(undefined)).toBeUndefined();
	});
});

describe("clampAutoThinkingEffort (no model -> full effort range)", () => {
	it("floors a below-Low request at Low", () => {
		expect(clampAutoThinkingEffort(undefined, Effort.Minimal)).toBe(Effort.Low);
	});

	it("returns the request itself when it is within the Low..Max pool", () => {
		expect(clampAutoThinkingEffort(undefined, Effort.Low)).toBe(Effort.Low);
		expect(clampAutoThinkingEffort(undefined, Effort.Medium)).toBe(Effort.Medium);
		expect(clampAutoThinkingEffort(undefined, Effort.High)).toBe(Effort.High);
		expect(clampAutoThinkingEffort(undefined, Effort.XHigh)).toBe(Effort.XHigh);
		expect(clampAutoThinkingEffort(undefined, Effort.Max)).toBe(Effort.Max);
	});
});

/**
 * getThinkingLevelMetadata / getConfiguredThinkingLevelMetadata supply the display metadata (value,
 * label, description) the UI shows for each thinking selector. They were untested. The contracts pinned
 * here are the ones a picker or `--help` listing depends on:
 *   - each concrete level's metadata carries its own value and full variant name;
 *   - the configured variant returns the identical metadata for a concrete level (it delegates), and a
 *     distinct "auto" entry (value/label "auto") for the AUTO_THINKING sentinel, so the auto option is
 *     never rendered as a blank or as one of the concrete levels.
 */
describe("thinking level metadata", () => {
	/** Variant labels must round-trip directly into selector suffixes without abbreviations. */
	it("returns the value and label for a concrete level", () => {
		expect(getThinkingLevelMetadata(ThinkingLevel.Off)).toEqual({
			value: ThinkingLevel.Off,
			label: "off",
			description: "No reasoning",
		});
		expect(getThinkingLevelMetadata(ThinkingLevel.Minimal)).toEqual({
			value: ThinkingLevel.Minimal,
			label: "minimal",
			description: "Very brief reasoning (~1k tokens)",
		});
		expect(getThinkingLevelMetadata(ThinkingLevel.High).label).toBe("high");
	});

	it("delegates to the concrete metadata for a configured concrete level", () => {
		expect(getConfiguredThinkingLevelMetadata(ThinkingLevel.High)).toEqual(
			getThinkingLevelMetadata(ThinkingLevel.High),
		);
	});

	it("returns a distinct auto entry for the AUTO_THINKING sentinel", () => {
		expect(getConfiguredThinkingLevelMetadata(AUTO_THINKING)).toEqual({
			value: AUTO_THINKING,
			label: "auto",
			description: "Auto-detect per prompt (low–xhigh)",
		});
	});
});

/**
 * configuredThinkingLevelsForModel is the ONE owner of the choices every
 * effort surface offers (/thinking, the selectors, the cycle key, the ACP
 * hint). The scale is per-row, never the fixed ladder: a row offers exactly
 * its declared efforts, and off/auto only when the row can actually route
 * them. Pinned here per mechanism:
 *  - param row: off + auto + the declared ladder;
 *  - budget-mode row: same shape, the mode does not widen the set;
 *  - routing row without an off sibling: no off, no auto (both would silently
 *    send the default wire id), levels only;
 *  - routing row with an off sibling: off and auto return;
 *  - requiresEffort row: off drops, auto stays;
 *  - id-baked / no-surface row and non-reasoning row: no choices at all.
 */
describe("configuredThinkingLevelsForModel", () => {
	function modelWith(thinking: ConstructorParameters<typeof buildModel>[0]["thinking"], reasoning = true) {
		return buildModel({
			id: "fixture-model",
			name: "fixture-model",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://fixture.invalid/v1",
			reasoning,
			thinking,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
	}

	it("offers off, auto, and the declared ladder on a param row", () => {
		const model = modelWith({ mode: "effort", efforts: [Effort.High, Effort.Max] });
		expect(configuredThinkingLevelsForModel(model)).toEqual([
			ThinkingLevel.Off,
			AUTO_THINKING,
			Effort.High,
			Effort.Max,
		]);
	});

	it("offers the same shape on a budget-mode row", () => {
		const model = modelWith({ mode: "budget", efforts: [Effort.Low, Effort.High] });
		expect(configuredThinkingLevelsForModel(model)).toEqual([
			ThinkingLevel.Off,
			AUTO_THINKING,
			Effort.Low,
			Effort.High,
		]);
	});

	it("refuses off and auto on a routed row with no off sibling", () => {
		const model = modelWith({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.XHigh],
			effortRouting: { low: "m-low", high: "m-high", xhigh: "m-xhigh" },
		});
		expect(configuredThinkingLevelsForModel(model)).toEqual([Effort.Low, Effort.High, Effort.XHigh]);
	});

	it("restores off and auto when the routed row has an off sibling", () => {
		const model = modelWith({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
			effortRouting: { off: "m-none", low: "m-low", high: "m-high" },
		});
		expect(configuredThinkingLevelsForModel(model)).toEqual([
			ThinkingLevel.Off,
			AUTO_THINKING,
			Effort.Low,
			Effort.High,
		]);
	});

	it("drops off but keeps auto on a requiresEffort row", () => {
		const model = modelWith({ mode: "effort", efforts: [Effort.Low, Effort.High], requiresEffort: true });
		expect(configuredThinkingLevelsForModel(model)).toEqual([AUTO_THINKING, Effort.Low, Effort.High]);
	});

	it("offers nothing on a reasoning row with no control surface", () => {
		// cursor-agent fabricates no ladder (its transport has no effort field),
		// so a cursor row with no explicit routed surface has no choices; a
		// non-reasoning row never does.
		const cursorRow = buildModel({
			id: "gpt-5.1-codex-max-high",
			name: "gpt-5.1-codex-max-high",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		expect(configuredThinkingLevelsForModel(cursorRow)).toEqual([]);
		expect(configuredThinkingLevelsForModel(modelWith(undefined, false))).toEqual([]);
	});
});

describe("thinkingLevelArgHint", () => {
	it("lists exactly the row's accepted choices", () => {
		const model = buildModel({
			id: "glm-5.2",
			name: "glm-5.2",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: true,
			reasoningOptions: { efforts: [Effort.High, Effort.Max] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		expect(thinkingLevelArgHint(model)).toBe("[off|auto|high|max]");
	});

	it("is undefined when the model exposes no effort control", () => {
		const model = buildModel({
			id: "kimi-k2-thinking",
			name: "kimi-k2-thinking",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: true,
			reasoningOptions: { noEffortControl: true },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		expect(thinkingLevelArgHint(model)).toBeUndefined();
		expect(thinkingLevelArgHint(undefined)).toBeUndefined();
	});
});
