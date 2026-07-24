/**
 * `tui.paintGround` is defined in the settings schema (coding-agent) but
 * consumed by resolvePaintGround (pi-tui). The two packages share no type at
 * the schema boundary — the schema lists string literals — so a value added
 * to one side without the other would ship a knob the runtime silently treats
 * as unknown. Lock the contract from both directions.
 */
import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { type PaintGroundSetting, resolvePaintGround } from "@veyyon/tui";

const definition = SETTINGS_SCHEMA["tui.paintGround"];

describe("tui.paintGround schema ↔ runtime contract", () => {
	it("is an enum over exactly the runtime's PaintGroundSetting values, defaulting to auto", () => {
		expect(definition).toBeDefined();
		if (definition?.type !== "enum") throw new Error(`expected enum, got ${definition?.type}`);
		expect([...definition.values]).toEqual(["auto", "always", "never"]);
		expect(definition.default).toBe("auto");
	});

	it("every schema value resolves to a real paint decision, not an unknown-value fallthrough", () => {
		if (definition?.type !== "enum") throw new Error("tui.paintGround must be an enum");
		for (const value of definition.values) {
			const setting = value as PaintGroundSetting;
			// always/never are unconditional; auto depends on the seam check.
			expect(resolvePaintGround(setting, "#000000", "#000000")).toBe(value !== "never");
			expect(resolvePaintGround(setting, "#000000", "#ffffff")).toBe(value === "always");
			// auto without a reported terminal background inherits (paints only on "always").
			expect(resolvePaintGround(setting, "#000000", undefined)).toBe(value === "always");
		}
	});
});
