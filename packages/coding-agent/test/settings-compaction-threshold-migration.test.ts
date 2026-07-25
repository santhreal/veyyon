import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";

/**
 * The retired compaction-threshold keys leave the config file on load.
 *
 * Folding them in at read time keeps an old config working, but it leaves both
 * spellings on disk with a precedence nobody can see, which is the confusion this
 * whole change is about. The load migration rewrites them into `compaction.threshold`
 * once, so the file itself says where compaction fires. It must be a fixed point:
 * `#migrateRawSettings` runs on EVERY read of the file, so a migration that changed
 * its own output would drift the trigger a little further on each read.
 */

/** The compaction group after the load migration has run over `config`. */
const migrated = (config: Record<string, unknown>) => Settings.isolated(config as never).getGroup("compaction");

describe("migrating the retired threshold keys", () => {
	it("rewrites an absolute amount as a bare token count and drops the old key", () => {
		const compaction = migrated({ compaction: { thresholdTokens: 150_000 } });
		expect(compaction.threshold).toBe("150000");
		expect(compaction.thresholdTokens).toBe(-1);
	});

	it("rewrites a percent with its unit and drops the old key", () => {
		const compaction = migrated({ compaction: { thresholdPercent: 80 } });
		expect(compaction.threshold).toBe("80%");
		expect(compaction.thresholdPercent).toBe(-1);
	});

	it("keeps the pre-collapse precedence when both keys are present", () => {
		// The absolute amount won before the collapse; a percent winning here would
		// silently move the trigger of every config that set both.
		expect(migrated({ compaction: { thresholdTokens: 150_000, thresholdPercent: 80 } }).threshold).toBe("150000");
	});

	it("leaves an already-migrated config alone", () => {
		const compaction = migrated({ compaction: { threshold: "70%", thresholdTokens: 150_000 } });
		expect(compaction.threshold).toBe("70%");
		expect(compaction.thresholdTokens).toBe(-1);
	});

	it("treats the -1 sentinels as nothing to migrate, leaving the default", () => {
		expect(migrated({ compaction: { thresholdTokens: -1, thresholdPercent: -1 } }).threshold).toBe("auto");
	});

	it("is a fixed point: migrating its own output changes nothing", () => {
		// The function runs on every read of the file, so this is a correctness
		// requirement, not a nicety.
		const once = migrated({ compaction: { thresholdPercent: 80 } });
		const twice = migrated({ compaction: { threshold: once.threshold } });
		expect(twice.threshold).toBe(once.threshold);
	});

	it("does nothing to a config that never mentioned compaction", () => {
		expect(migrated({}).threshold).toBe("auto");
	});
});
