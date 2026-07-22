/**
 * Welcome tip gates — a tip must never advertise behavior the user disabled.
 * Found by the 2026-07-22 logic audit: with `magicKeywords.enabled: false`
 * the hero could still say "type `orchestrate` … watch it glow", promising a
 * glow and an orchestration that would not happen. Tips now carry an optional
 * `[gate:<setting>]` prefix and resolve it against live settings at pick time.
 *
 * Locks:
 *  1. The three magic-keyword tips carry the magicKeywords.enabled gate and
 *     the marker never leaks into display text.
 *  2. filterTipsByGates removes gated tips when the gate is false, keeps them
 *     when true, and never touches ungated tips.
 *  3. Every gate key in tips.txt names a REAL boolean setting in the schema —
 *     a typo'd gate would silently show the lying tip forever.
 *  4. End to end: with magic keywords disabled, no pick can surface a
 *     keyword tip (the whole weighted distribution excludes them).
 */
import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { filterTipsByGates, pickWeightedTip, TIP_ENTRIES } from "@veyyon/coding-agent/modes/components/welcome";

describe("welcome tip gates", () => {
	it("gates every magic-keyword tip on magicKeywords.enabled, marker stripped", () => {
		const keywordTips = TIP_ENTRIES.filter(tip => /ultrathink|orchestrate|workflowz/.test(tip.text));
		expect(keywordTips.length).toBe(3);
		for (const tip of keywordTips) {
			expect(tip.gate).toBe("magicKeywords.enabled");
			expect(tip.text).not.toContain("[gate:");
		}
	});

	it("filters gated tips by the resolved flag and leaves ungated tips alone", () => {
		const tips = [
			{ text: "plain" },
			{ text: "gated-on", gate: "a.enabled" },
			{ text: "gated-off", gate: "b.enabled" },
		];
		const visible = filterTipsByGates(tips, key => key === "a.enabled");
		expect(visible).toEqual(["plain", "gated-on"]);
		expect(filterTipsByGates(tips, () => true)).toEqual(["plain", "gated-on", "gated-off"]);
	});

	it("uses only real boolean settings keys as gates (no typo'd gates)", () => {
		for (const tip of TIP_ENTRIES) {
			if (tip.gate === undefined) continue;
			const schema = SETTINGS_SCHEMA[tip.gate as keyof typeof SETTINGS_SCHEMA] as { type?: string } | undefined;
			expect(schema).toBeDefined();
			expect(schema?.type).toBe("boolean");
		}
	});

	it("excludes keyword tips from every possible pick when the feature is off", () => {
		const visible = filterTipsByGates(TIP_ENTRIES, () => false);
		// Sweep the whole weighted distribution: no random draw can surface a
		// gated tip once its feature is disabled.
		for (let r = 0; r < 1; r += 0.005) {
			expect(pickWeightedTip(visible, r)).not.toMatch(/ultrathink|orchestrate|workflowz/);
		}
	});
});
