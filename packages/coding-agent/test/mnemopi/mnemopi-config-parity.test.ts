/**
 * Mnemopi config, bank scope, and token truncation contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The mnemopi subsystem defines how memory banks are scoped and how
 * text is truncated for token limits. These contracts pin the config shape,
 * bank scope derivation for each scoping mode, and the truncation algorithm.
 */
import { describe, expect, it } from "bun:test";
import {
	truncateApproxTokens,
	computeMnemopiBankScope,
	loadMnemopiConfig,
	type MnemopiScoping,
} from "@veyyon/coding-agent/mnemopi/config";
import { MNEMOPI_MEMORY_EDIT_OPERATIONS } from "@veyyon/coding-agent/mnemopi/verbs";
import { Settings } from "@veyyon/coding-agent/config/settings";

describe("mnemopi verbs", () => {
	it("MNEMOPI_MEMORY_EDIT_OPERATIONS is pinned exactly", () => {
		expect([...MNEMOPI_MEMORY_EDIT_OPERATIONS]).toEqual(["update", "forget", "invalidate"]);
	});
});

describe("truncateApproxTokens", () => {
	it("returns text unchanged when under limit", () => {
		expect(truncateApproxTokens("hello", 10)).toBe("hello");
	});

	it("returns text unchanged when exactly at limit", () => {
		// 4 chars * 4 = 16 chars max, text is 16 chars
		const text = "a".repeat(16);
		expect(truncateApproxTokens(text, 4)).toBe(text);
	});

	it("truncates with ellipsis when over limit", () => {
		const text = "a".repeat(20);
		const result = truncateApproxTokens(text, 4);
		expect(result.endsWith("…")).toBe(true);
		expect(result.length).toBeLessThan(text.length);
	});

	it("handles zero token limit", () => {
		expect(truncateApproxTokens("hello", 0)).toBe("…");
	});

	it("handles negative token limit", () => {
		expect(truncateApproxTokens("hello", -1)).toBe("…");
	});

	it("handles empty string", () => {
		expect(truncateApproxTokens("", 10)).toBe("");
	});

	it("trims trailing whitespace before ellipsis", () => {
		const text = "hello world   ";
		const result = truncateApproxTokens(text, 2);
		expect(result.endsWith("…")).toBe(true);
		expect(result.endsWith("   …")).toBe(false);
	});
});

describe("computeMnemopiBankScope", () => {
	it("global scoping returns global bank for all fields", () => {
		const scope = computeMnemopiBankScope(undefined, "/tmp/project", "global");
		expect(scope.bank).toBe(scope.globalBank);
		expect(scope.retainBank).toBe(scope.globalBank);
		expect(scope.recallBanks).toEqual([scope.globalBank]);
	});

	it("per-project scoping returns project bank", () => {
		const scope = computeMnemopiBankScope(undefined, "/tmp/project", "per-project");
		expect(scope.bank).not.toBe(scope.globalBank);
		expect(scope.recallBanks).toContain(scope.bank);
	});

	it("per-project-tagged scoping returns project bank with both banks in recall", () => {
		const scope = computeMnemopiBankScope(undefined, "/tmp/project", "per-project-tagged");
		expect(scope.bank).not.toBe(scope.globalBank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain(scope.globalBank);
	});
});

describe("loadMnemopiConfig", () => {
	it("returns a config object with required fields", () => {
		const settings = Settings.isolated();
		const config = loadMnemopiConfig(settings, "/tmp/agent");
		expect(typeof config).toBe("object");
		expect(config).not.toBeNull();
		expect(typeof config.bank).toBe("string");
		expect(typeof config.autoRecall).toBe("boolean");
		expect(typeof config.autoRetain).toBe("boolean");
		expect(typeof config.recallLimit).toBe("number");
	});
});
