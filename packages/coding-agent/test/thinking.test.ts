import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Effort } from "@veyyon/ai";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	clampAutoThinkingEffort,
	concreteThinkingLevel,
	getConfiguredThinkingLevelMetadata,
	getThinkingLevelMetadata,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	shouldDisableReasoning,
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

	it("lists the CLI levels in display order: off, efforts, auto", () => {
		expect(CLI_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
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
 *   - each concrete level's metadata carries its own value and the SHORT label the UI shows (min/off/
 *     high are not the same as the enum value in every case: Minimal -> "min");
 *   - the configured variant returns the identical metadata for a concrete level (it delegates), and a
 *     distinct "auto" entry (value/label "auto") for the AUTO_THINKING sentinel, so the auto option is
 *     never rendered as a blank or as one of the concrete levels.
 */
describe("thinking level metadata", () => {
	it("returns the value and short label for a concrete level", () => {
		expect(getThinkingLevelMetadata(ThinkingLevel.Off)).toEqual({
			value: ThinkingLevel.Off,
			label: "off",
			description: "No reasoning",
		});
		expect(getThinkingLevelMetadata(ThinkingLevel.Minimal)).toEqual({
			value: ThinkingLevel.Minimal,
			label: "min",
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
