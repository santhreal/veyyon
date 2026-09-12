/**
 * Group-membership indexes must not cache resolved values or share result objects.
 * The schema sweep covers every declared prefix and dotted suffix. Separate stores
 * and a runtime update cover stale values. Persistence and migrations have their own suites.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type GroupPrefix, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
const prefixes = [...new Set(paths.map(path => path.split(".")[0]!))];

describe("settings groups read current values", () => {
	it.each(prefixes)("returns independent flat results for the %s prefix", prefix => {
		const settings = Settings.isolated();
		const members = paths.filter(path => path.startsWith(`${prefix}.`));
		const expected = Object.fromEntries(members.map(path => [path.slice(prefix.length + 1), settings.get(path)]));
		// Sweep all schema prefixes, including prefixes outside the typed convenience API.
		const first = settings.getGroup(prefix as GroupPrefix) as Record<string, unknown>;
		expect(first).toEqual(expected);
		for (const key of Object.keys(first)) first[key] = Symbol("changed result");
		first.unregistered = true;
		expect(settings.getGroup(prefix as GroupPrefix)).toEqual(expected);
	});

	it("reads each store and runtime update after group membership has been reused", async () => {
		const first = Settings.isolated({ "compaction.enabled": true });
		const second = Settings.isolated({ "compaction.enabled": false, "compaction.threshold": "70%" });
		expect(first.getGroup("compaction")).toMatchObject({ enabled: true, threshold: "auto" });
		expect(second.getGroup("compaction")).toMatchObject({ enabled: false, threshold: "70%" });
		await first.set("compaction.threshold", "60%");
		expect(first.getGroup("compaction")).toMatchObject({ enabled: true, threshold: "60%" });
		await second.set("compaction.threshold", "60%");
		expect(second.getGroup("compaction")).toMatchObject({ enabled: false, threshold: "70%" });
	});
});
