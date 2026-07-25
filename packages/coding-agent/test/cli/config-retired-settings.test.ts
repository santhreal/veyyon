import { describe, expect, it } from "bun:test";
import { retiredBy, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";

/**
 * A superseded setting stops advertising itself as a choice.
 *
 * When a key is replaced, it has to stay in the schema — an existing config keeps
 * working and the migration reads it — but leaving it in `config list` next to the
 * key that replaced it recreates exactly the confusion the supersession was meant
 * to end: two keys on one axis, both looking settable. `retiredBy` is the single
 * answer to "is this still something to choose?", so the CLI listing and the
 * settings UI cannot disagree about it.
 */

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

describe("the retired-setting marker", () => {
	it("names the replacement for every key that has been superseded", () => {
		const retired = paths.filter(path => retiredBy(path) !== undefined);
		expect(retired.sort()).toEqual([
			"compaction.thresholdPercent",
			"compaction.thresholdTokens",
			"defaultThinkingLevel",
		]);
	});

	it("points every retired key at a key that actually exists", () => {
		// A pointer to a typo'd or deleted key sends the reader nowhere.
		for (const path of paths) {
			const replacement = retiredBy(path);
			if (!replacement) continue;
			expect(paths, `${path} points at ${replacement}`).toContain(replacement as SettingPath);
		}
	});

	it("never marks a key as replaced by itself", () => {
		for (const path of paths) {
			expect(retiredBy(path)).not.toBe(path);
		}
	});

	it("leaves the replacements themselves current", () => {
		// If the replacement were also retired the reader would follow a chain, or a
		// cycle. One hop, always.
		expect(retiredBy("compaction.threshold" as SettingPath)).toBeUndefined();
		expect(retiredBy("defaultEffort" as SettingPath)).toBeUndefined();
	});

	it("answers for a synthetic id instead of throwing", () => {
		// The settings UI asks about ids that are not schema paths (the default-model
		// row); a throw there would take down the whole panel.
		expect(retiredBy("defaultModel" as SettingPath)).toBeUndefined();
	});

	it("keeps retired keys out of the UI as well as the CLI listing", () => {
		// Two surfaces, one marker: a retired key with a `ui` block would still show
		// up as a settings row.
		for (const path of paths) {
			if (!retiredBy(path)) continue;
			expect((SETTINGS_SCHEMA[path] as { ui?: unknown }).ui, `${path} must have no ui block`).toBeUndefined();
		}
	});
});
