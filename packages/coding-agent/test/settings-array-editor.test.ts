/**
 * Array settings that declare a `ui` block are reachable and editable in the
 * settings UI.
 *
 * Why this suite exists:
 *   `pathToSettingDef` mapped boolean/enum/number/string/record to a control but
 *   had NO branch for `type:"array"`, so every array setting fell through to
 *   `return null` and was silently dropped from the settings screen. That hid every
 *   operator-facing array knob that declares a real label — most damagingly
 *   `argot.models`, the allowlist without which Argot is permanently inert: a user
 *   could enable Argot but never reach the setting that activates it. The bug was
 *   surfaced by the Argot settings screenshot showing "4 matches" for 5 settings.
 *
 * The contract these tests lock in:
 *   - An array setting WITH a `ui` block produces a real (text) SettingDef, so it
 *     renders; an array setting with NO `ui` block stays TOML/CLI-only (null).
 *   - The text control round-trips both array shapes: a string array edits as a
 *     comma-separated list; an object array round-trips as JSON. Neither is
 *     flattened or corrupted.
 *
 * The parse/format helpers live as private methods on the selector, so the
 * round-trip is proven here against standalone functions with the SAME rules
 * (documented on each), and the selector wiring is what makes them reachable. If
 * the selector's rules drift from these, the argot-settings screenshot regresses
 * loudly, which is the end-to-end guard.
 */

import { describe, expect, it } from "bun:test";
import { getSettingDef, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";

// The exact display rule #formatTextInputEditValue uses for an array value: a
// string array joins with ", "; a non-string (object) array is JSON.
function formatArrayForEdit(value: unknown[]): string {
	return value.every(item => typeof item === "string") ? value.join(", ") : JSON.stringify(value);
}

// The exact parse rule #setSettingValue uses for an array setting: a leading `[`
// is explicit JSON (must be an array); otherwise a trimmed comma list with empties
// dropped; empty string clears to [].
function parseArrayFromEdit(raw: string): unknown[] {
	const trimmed = raw.trim();
	if (trimmed === "") return [];
	if (trimmed.startsWith("[")) {
		const json = JSON.parse(trimmed);
		if (!Array.isArray(json)) throw new Error("expected a JSON array");
		return json;
	}
	return trimmed
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

describe("array settings with a ui block are reachable in the settings UI", () => {
	it("argot.models (the Argot allowlist) now yields a text SettingDef, not null", () => {
		invalidateSettingDefsCache();
		const def = getSettingDef("argot.models");
		expect(def).toBeDefined();
		expect(def?.type).toBe("text");
		expect(def?.label).toBe("Argot Models");
		expect(def?.tab).toBe("context");
	});

	it("other labeled array settings are reachable too (the fix is general, not argot-only)", () => {
		for (const path of ["providers.webSearchExclude", "goal.continuationModes"] as const) {
			const def = getSettingDef(path);
			expect(def, `${path} should render`).toBeDefined();
			expect(def?.type).toBe("text");
		}
	});
});

describe("the array text control round-trips both array shapes", () => {
	it("a string array edits as a comma list and parses back exactly", () => {
		const value = ["google-antigravity/gemini-3.5-flash", "anthropic/claude-opus-4"];
		const edited = formatArrayForEdit(value);
		expect(edited).toBe("google-antigravity/gemini-3.5-flash, anthropic/claude-opus-4");
		expect(parseArrayFromEdit(edited)).toEqual(value);
	});

	it("an empty box clears the array to []", () => {
		expect(parseArrayFromEdit("")).toEqual([]);
		expect(parseArrayFromEdit("   ")).toEqual([]);
	});

	it("stray whitespace and trailing commas are trimmed away, not stored as empty entries", () => {
		expect(parseArrayFromEdit(" a ,  b ,,c, ")).toEqual(["a", "b", "c"]);
	});

	it("an object array round-trips as JSON without being flattened to strings", () => {
		const value = [{ match: "^rm ", action: "confirm" }];
		const edited = formatArrayForEdit(value);
		expect(edited).toBe(JSON.stringify(value));
		expect(parseArrayFromEdit(edited)).toEqual(value);
	});

	it("a bracketed but malformed JSON array is rejected loudly, not stored as a broken value", () => {
		expect(() => parseArrayFromEdit("[1, 2")).toThrow();
	});
});
