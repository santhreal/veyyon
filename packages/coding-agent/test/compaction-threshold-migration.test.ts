import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens, resolveThresholdWithOrigin } from "@veyyon/agent-core/compaction/compaction";
import { AUTO_COMPACTION_THRESHOLD } from "@veyyon/agent-core/compaction/threshold";
import { Settings } from "@veyyon/coding-agent/config/settings";

/**
 * A config written before the threshold collapse keeps its exact trigger point.
 *
 * The unit tests in `packages/agent/test/compaction-threshold-collapse.test.ts`
 * pin the resolver against plain objects. This suite goes through the REAL read
 * path an operator's `config.yml` takes — `Settings.getGroup("compaction")` — so a
 * schema default, a type coercion, or a missing key in that layer cannot quietly
 * change where compaction fires for someone who upgraded.
 *
 * Note what this proves about the two layers together: the load migration
 * (`Settings#migrateRawSettings`) has already rewritten the retired keys into
 * `compaction.threshold` by the time the resolver sees the group, so the resolved
 * origin here is the CURRENT key, never a legacy one. The read-time fold that
 * reports a legacy origin covers the sources migration never rewrites, and is
 * pinned in the resolver's own suite.
 */

const WINDOW = 200_000;

/** The compaction group as the session reads it, from a config-shaped object. */
const group = (config: Record<string, unknown>) =>
	Settings.isolated(config as never).getGroup("compaction") as Parameters<typeof resolveThresholdTokens>[1];

describe("a config written before the collapse", () => {
	it("keeps an absolute token trigger, and says which key it came from", () => {
		const settings = group({ compaction: { thresholdTokens: 150_000, thresholdPercent: -1 } });
		expect(resolveThresholdTokens(WINDOW, settings)).toBe(150_000);
		const resolved = resolveThresholdWithOrigin(WINDOW, settings);
		expect(resolved.origin).toBe("tokens");
		// Migrated on load, so the value now comes from `threshold` itself.
		expect(resolved.legacyKey).toBeUndefined();
	});

	it("keeps a percent trigger, scaled against the live window", () => {
		const settings = group({ compaction: { thresholdPercent: 80 } });
		expect(resolveThresholdTokens(WINDOW, settings)).toBe(160_000);
		expect(resolveThresholdWithOrigin(WINDOW, settings).origin).toBe("percent");
	});

	it("keeps the absolute amount ahead of the percent when both are set", () => {
		// The pre-collapse precedence, through the real settings layer.
		const settings = group({ compaction: { thresholdTokens: 150_000, thresholdPercent: 80 } });
		expect(resolveThresholdTokens(WINDOW, settings)).toBe(150_000);
	});

	it("resolves to auto when both retired keys are the -1 sentinel", () => {
		const settings = group({ compaction: { thresholdTokens: -1, thresholdPercent: -1, reserveTokens: 40_000 } });
		expect(resolveThresholdTokens(WINDOW, settings)).toBe(160_000);
		expect(resolveThresholdWithOrigin(WINDOW, settings).origin).toBe("auto");
	});
});

describe("a config written after the collapse", () => {
	it("wins over both retired keys, and reports no legacy origin", () => {
		const settings = group({
			compaction: { threshold: "70%", thresholdTokens: 150_000, thresholdPercent: 80 },
		});
		expect(resolveThresholdTokens(WINDOW, settings)).toBe(140_000);
		expect(resolveThresholdWithOrigin(WINDOW, settings).legacyKey).toBeUndefined();
	});

	it("reads a bare token amount from the one key", () => {
		expect(resolveThresholdTokens(WINDOW, group({ compaction: { threshold: "170000" } }))).toBe(170_000);
	});

	it("defaults to auto on a config that never mentions compaction", () => {
		const settings = group({});
		expect(settings.threshold).toBe(AUTO_COMPACTION_THRESHOLD);
		expect(resolveThresholdWithOrigin(WINDOW, settings).origin).toBe("auto");
	});
});
