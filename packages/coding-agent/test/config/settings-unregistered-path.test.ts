/**
 * Regression: reading an unregistered dotted setting path must never crash.
 *
 * Found by dogfooding — startup threw `TypeError: undefined is not an object
 * (evaluating 'segments')` because `harness/model-profile.ts` reads
 * `settings.get("harness.profiles")`, a path not in SETTINGS_SCHEMA, so
 * `SETTING_PATH_SEGMENTS[path]` was `undefined` and `getByPath` iterated it.
 *
 * A config read must be total: unknown paths resolve to `undefined` (and
 * `isConfigured` to `false`) instead of throwing, so a new subsystem reading a
 * not-yet-registered key cannot take the whole TUI down at launch.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/pi-coding-agent/config/settings";

describe("Settings read on an unregistered dotted path", () => {
	it("returns undefined instead of throwing for a dotted path not in the schema", async () => {
		const settings = await Settings.init({ inMemory: true });
		// deliberately untyped: this path is not in the schema union
		// (harness.profiles, the original repro, has since been registered)
		const read = () => (settings.get as (p: string) => unknown)("harness.unregisteredExample");
		expect(read).not.toThrow();
		expect(read()).toBeUndefined();
	});

	it("returns undefined for an arbitrary unknown nested path", async () => {
		const settings = await Settings.init({ inMemory: true });
		const read = () => (settings.get as (p: string) => unknown)("totally.unknown.deeply.nested.key");
		expect(read).not.toThrow();
		expect(read()).toBeUndefined();
	});

	it("reports isConfigured=false for an unregistered path without throwing", async () => {
		const settings = await Settings.init({ inMemory: true });
		const check = () => (settings.isConfigured as (p: string) => boolean)("harness.unregisteredExample");
		expect(check).not.toThrow();
		expect(check()).toBe(false);
	});
});
