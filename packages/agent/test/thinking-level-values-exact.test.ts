/**
 * ThinkingLevel enum values are the single source for agent-local selectors.
 * Off disables; Inherit defers; numeric levels match @veyyon/ai Effort.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { Effort } from "@veyyon/ai";

describe("ThinkingLevel values exact", () => {
	it("control plane strings", () => {
		expect(ThinkingLevel.Inherit).toBe("inherit");
		expect(ThinkingLevel.Off).toBe("off");
	});

	it("effort levels match Effort package constants", () => {
		expect(ThinkingLevel.Minimal).toBe(Effort.Minimal);
		expect(ThinkingLevel.Low).toBe(Effort.Low);
		expect(ThinkingLevel.Medium).toBe(Effort.Medium);
		expect(ThinkingLevel.High).toBe(Effort.High);
		expect(ThinkingLevel.XHigh).toBe(Effort.XHigh);
		expect(ThinkingLevel.Max).toBe(Effort.Max);
	});

	it("all keys present", () => {
		expect(Object.keys(ThinkingLevel).sort()).toEqual(
			["High", "Inherit", "Low", "Max", "Medium", "Minimal", "Off", "XHigh"].sort(),
		);
	});
});
