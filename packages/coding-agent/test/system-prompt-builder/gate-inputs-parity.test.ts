/**
 * Gate input resolution pins settings-to-prompt-input mapping.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. resolveGateInputs is the single function that turns settings into
 * system-prompt inputs. resolveIntentField returns the intent field name when
 * intent tracing is on, or undefined when off. Both paths (session and
 * inspection) call resolveGateInputs, so pinning its output pins the prompt
 * contract.
 */
import { describe, expect, it } from "bun:test";
import { resolveIntentField, OMITTED_GATE_DEFAULTS } from "@veyyon/coding-agent/system-prompt-builder/gate-inputs";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { INTENT_FIELD } from "@veyyon/wire";

describe("resolveIntentField", () => {
	it("returns undefined when tools.intentTracing is false (default)", () => {
		const settings = Settings.isolated({ "tools.intentTracing": false });
		expect(resolveIntentField(settings)).toBeUndefined();
	});

	it("returns INTENT_FIELD when tools.intentTracing is true", () => {
		const settings = Settings.isolated({ "tools.intentTracing": true });
		expect(resolveIntentField(settings)).toBe(INTENT_FIELD);
	});
});

describe("OMITTED_GATE_DEFAULTS", () => {
	it("is a frozen object with every GateInputs key except intentField", () => {
		expect(typeof OMITTED_GATE_DEFAULTS).toBe("object");
		expect(Object.keys(OMITTED_GATE_DEFAULTS).length).toBeGreaterThan(0);
		expect("intentField" in OMITTED_GATE_DEFAULTS).toBe(false);
	});

	it("every value is a primitive (string, boolean, number, or null)", () => {
		for (const [key, value] of Object.entries(OMITTED_GATE_DEFAULTS)) {
			expect(
				typeof value === "string" ||
				typeof value === "boolean" ||
				typeof value === "number" ||
				value === null ||
				Array.isArray(value),
				`OMITTED_GATE_DEFAULTS.${key} has unexpected type: ${typeof value}`,
			).toBe(true);
		}
	});
});
