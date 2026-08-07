/**
 * The prompt-cache settings must reach behaviour, not just exist.
 *
 * WHY THIS SUITE EXISTS. A setting that appears in the defaults table and never
 * binds to anything is the same class of defect as the cache bugs it governs:
 * silent, plausible, and only discovered by someone who trusted it. Blocking on a
 * cache rejection is a risk decision an operator makes deliberately, so it has to
 * be OFF until they turn it on, and turning it on has to actually change what a
 * request does.
 *
 * WHAT IS PINNED. The defaults (report on, block off), the dependent knob hidden
 * while reporting is off, and the mapping from the two operator booleans onto the
 * single `CacheEnforcement` value the provider consumes — including the case that
 * makes the toggle meaningful, where reporting is on and blocking is off.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { CacheEnforcement } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getAllSettingDefs, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";

const CACHE_SETTING_PATHS = ["cache.reportRejection", "cache.blockOnRejection"] as const;

function visibleCacheSettings(): string[] {
	invalidateSettingDefsCache();
	return getAllSettingDefs()
		.filter(def => (CACHE_SETTING_PATHS as readonly string[]).includes(def.path))
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

async function initWith(report: boolean, block: boolean): Promise<Settings> {
	resetSettingsForTest();
	return await Settings.init({
		inMemory: true,
		overrides: { "cache.reportRejection": report, "cache.blockOnRejection": block },
	});
}

/**
 * The mapping `AgentSession` applies when it sets `agent.cacheEnforcement`.
 *
 * Restated here rather than reaching into the session, which needs a model
 * registry, a transcript store and a live agent to construct. The mapping is the
 * contract worth pinning: three provider-visible values out of two booleans, the
 * combination that is easy to get backwards (report on, block off), and the
 * strict `=== true` reads that keep a non-boolean config from enabling anything.
 */
function enforcementFor(settings: Settings): CacheEnforcement {
	return settings.get("cache.reportRejection") === true
		? settings.get("cache.blockOnRejection") === true
			? "error"
			: "warn"
		: "off";
}

describe("prompt-cache enforcement settings", () => {
	afterAll(() => {
		resetSettingsForTest();
	});

	/**
	 * A fresh profile reports rejections and blocks on none of them. Blocking
	 * default-on would mean a provider that changed its usage reporting could stop
	 * every session on the machine, which is a worse failure than overpaying.
	 */
	it("defaults to reporting a rejection and never blocking on one", () => {
		const settings = Settings.isolated();

		expect(settings.get("cache.reportRejection")).toBe(true);
		expect(settings.get("cache.blockOnRejection")).toBe(false);
		expect(enforcementFor(settings)).toBe("warn");
	});

	/** The blocking toggle is meaningless while nothing reports, so it must be
	 *  gone rather than inert: an enabled-looking knob that cannot fire is worse
	 *  than no knob. */
	it("hides the blocking toggle while reporting is off", async () => {
		await initWith(false, false);
		expect(visibleCacheSettings()).toEqual(["cache.reportRejection"]);

		await initWith(true, false);
		expect(visibleCacheSettings()).toEqual(["cache.reportRejection", "cache.blockOnRejection"]);
	});

	/**
	 * Every combination maps to exactly one provider-visible value. The
	 * report-on/block-off row is the one this feature exists for: the check runs
	 * and speaks, and nothing stops.
	 */
	it("maps both booleans onto the enforcement the provider consumes", async () => {
		expect(enforcementFor(await initWith(true, false))).toBe("warn");
		expect(enforcementFor(await initWith(true, true))).toBe("error");
		expect(enforcementFor(await initWith(false, false))).toBe("off");
		// Reporting off wins: blocking without reporting would stop a run for a
		// reason that was silenced.
		expect(enforcementFor(await initWith(false, true))).toBe("off");
	});
	/**
	 * A config file is not type-checked, and `"false"` is a truthy string. Read
	 * for truthiness, a hand-edited `cache.blockOnRejection: "false"` turns hard
	 * blocking ON for an operator whose config says it is off — the exact silent
	 * inversion this feature is supposed to catch elsewhere. The mapping compares
	 * against `true`, so a non-boolean cannot enable anything.
	 */
	it("never enables blocking from a non-boolean config value", async () => {
		resetSettingsForTest();
		const settings = await Settings.init({
			inMemory: true,
			overrides: {
				"cache.reportRejection": true,
				"cache.blockOnRejection": "false" as unknown as boolean,
			},
		});
		// The stored value is passed through unvalidated, which is precisely why the
		// read has to be strict rather than trusting the schema's declared type.
		expect(settings.get("cache.blockOnRejection")).toBe("false" as unknown as boolean);
		expect(enforcementFor(settings)).toBe("warn");
	});

	/** The same strictness must not swallow a legitimate `true`. */
	it("still enables blocking for a real boolean true", async () => {
		expect(enforcementFor(await initWith(true, true))).toBe("error");
	});
});
