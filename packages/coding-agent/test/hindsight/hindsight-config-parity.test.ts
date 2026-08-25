/**
 * Hindsight config, bank scope, and retain queue contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The hindsight subsystem defines how memory banks are scoped and
 * how retain queues batch. These contracts pin the config shape, the bank
 * scope derivation, and the retain queue constants.
 */
import { describe, expect, it } from "bun:test";
import {
	loadHindsightConfig,
	isHindsightConfigured,
	type HindsightConfig,
	type HindsightScoping,
} from "@veyyon/coding-agent/hindsight/config";
import {
	computeBankScope,
	deriveBankId,
	PROJECT_TAG_PREFIX,
	type BankScope,
} from "@veyyon/coding-agent/hindsight/bank";
import {
	HINDSIGHT_RETAIN_BATCH_SIZE,
	MEMORY_RETAIN_MAX_ITEM_BYTES,
	MEMORY_RETAIN_MAX_ITEMS,
	MEMORY_RETAIN_MAX_BYTES,
	HindsightRetainQueue,
} from "@veyyon/coding-agent/hindsight/state";
import { Settings } from "@veyyon/coding-agent/config/settings";

/** A valid HindsightConfig with selective overrides, built from the real loader. */
function baseConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return { ...loadHindsightConfig(Settings.isolated(), {}), ...overrides };
}

describe("hindsight config", () => {
	it("loadHindsightConfig returns a config object", () => {
		const settings = Settings.isolated();
		const config = loadHindsightConfig(settings, {});
		expect(typeof config).toBe("object");
		expect(config).not.toBeNull();
	});

	it("default config has null API token", () => {
		const settings = Settings.isolated();
		const config = loadHindsightConfig(settings, {});
		expect(config.hindsightApiToken).toBeNull();
	});

	it("isHindsightConfigured returns false for null API URL", () => {
		const config = baseConfig({ hindsightApiUrl: null });
		expect(isHindsightConfigured(config)).toBe(false);
	});

	it("isHindsightConfigured returns true when API URL is set", () => {
		const config = loadHindsightConfig(Settings.isolated(), {
			HINDSIGHT_API_URL: "https://example.com",
			HINDSIGHT_API_TOKEN: "test-token",
		});
		expect(isHindsightConfigured(config)).toBe(true);
	});
});

describe("hindsight bank scope", () => {
	it("PROJECT_TAG_PREFIX is 'project:'", () => {
		expect(PROJECT_TAG_PREFIX).toBe("project:");
	});

	it("computeBankScope returns a BankScope object", () => {
		const config = baseConfig({ bankIdPrefix: "veyyon", scoping: "global" });
		const scope = computeBankScope(config, "/tmp");
		expect(typeof scope).toBe("object");
		expect(scope).not.toBeNull();
	});

	it("deriveBankId returns a string", () => {
		const config = baseConfig({ bankIdPrefix: "veyyon", scoping: "global" });
		const id = deriveBankId(config, "/tmp");
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("deriveBankId prefixes the explicit bankId", () => {
		const config = baseConfig({ bankId: "my-explicit-bank", bankIdPrefix: "veyyon", scoping: "global" });
		expect(deriveBankId(config, "/tmp")).toBe("veyyon-my-explicit-bank");
	});
});

describe("hindsight retain queue constants", () => {
	it("HINDSIGHT_RETAIN_BATCH_SIZE is 16", () => {
		expect(HINDSIGHT_RETAIN_BATCH_SIZE).toBe(16);
	});

	it("MEMORY_RETAIN_MAX_ITEM_BYTES is 64KiB", () => {
		expect(MEMORY_RETAIN_MAX_ITEM_BYTES).toBe(64 * 1024);
	});

	it("MEMORY_RETAIN_MAX_ITEMS is 64", () => {
		expect(MEMORY_RETAIN_MAX_ITEMS).toBe(64);
	});

	it("MEMORY_RETAIN_MAX_BYTES is 256KiB", () => {
		expect(MEMORY_RETAIN_MAX_BYTES).toBe(256 * 1024);
	});

	it("HindsightRetainQueue is a constructor", () => {
		expect(typeof HindsightRetainQueue).toBe("function");
	});
});
