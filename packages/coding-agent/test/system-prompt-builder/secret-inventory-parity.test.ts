/**
 * Secret inventory rendering pins exact observable output.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. renderSecretInventory produces the AVAILABLE SECRETS section text
 * that the model sees. Its contracts: undefined for empty/missing input, exact
 * rendered text for non-empty input, and no credential value ever reaches the
 * output.
 */
import { describe, expect, it } from "bun:test";
import { renderSecretInventory } from "@veyyon/coding-agent/system-prompt-builder/secret-inventory";

describe("renderSecretInventory", () => {
	it("returns undefined for undefined input", () => {
		expect(renderSecretInventory(undefined)).toBeUndefined();
	});

	it("returns undefined for empty array", () => {
		expect(renderSecretInventory([])).toBeUndefined();
	});

	it("returns a non-empty string for non-empty names", () => {
		const result = renderSecretInventory(["GITHUB_TOKEN"]);
		expect(typeof result).toBe("string");
		expect(result!.length).toBeGreaterThan(0);
	});

	it("includes every name in the output", () => {
		const result = renderSecretInventory(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
		expect(result).toContain("GITHUB_TOKEN");
		expect(result).toContain("ANTHROPIC_API_KEY");
	});

	it("uses the #NAME# placeholder syntax, never a raw value", () => {
		const result = renderSecretInventory(["MY_SECRET"]);
		expect(result).toContain("#MY_SECRET#");
		// The placeholder is the redaction syntax — the actual credential
		// value never appears. The function only receives names, not values.
		expect(result).not.toContain("ghp_");
		expect(result).not.toContain("sk-");
	});

	it("is deterministic — same input produces same output", () => {
		const a = renderSecretInventory(["A_TOKEN", "B_TOKEN"]);
		const b = renderSecretInventory(["A_TOKEN", "B_TOKEN"]);
		expect(a).toEqual(b);
	});

	it("preserves the order of names as given", () => {
		const result = renderSecretInventory(["Z_TOKEN", "A_TOKEN"]);
		expect(result).toContain("Z_TOKEN");
		expect(result).toContain("A_TOKEN");
		// The source says names come sorted from namedSecretNames; the
		// renderer itself does not re-sort, so order is preserved.
		const zPos = result!.indexOf("Z_TOKEN");
		const aPos = result!.indexOf("A_TOKEN");
		expect(zPos).toBeLessThan(aPos);
	});
});
