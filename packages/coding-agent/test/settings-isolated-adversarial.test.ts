import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./helpers/settings-test-state";

/**
 * Settings.isolated override isolation: two instances do not share mutated
 * values; schema defaults reappear when overrides omit a path.
 */

describe("Settings.isolated adversarial", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("override is visible via get", () => {
		const s = Settings.isolated({ "compaction.enabled": false } as never);
		expect(s.get("compaction.enabled")).toBe(false);
	});

	it("two isolated instances do not share overrides", () => {
		const a = Settings.isolated({ "compaction.enabled": false } as never);
		const b = Settings.isolated({ "compaction.enabled": true } as never);
		expect(a.get("compaction.enabled")).toBe(false);
		expect(b.get("compaction.enabled")).toBe(true);
	});

	it("omitted override falls back to schema default for compaction.enabled", () => {
		const plain = Settings.isolated({});
		const overridden = Settings.isolated({ "compaction.enabled": false } as never);
		// Default is true for compaction.enabled in product schema.
		expect(plain.get("compaction.enabled")).toBe(true);
		expect(overridden.get("compaction.enabled")).toBe(false);
	});

	it("unknown path get returns undefined without throwing", () => {
		const s = Settings.isolated({});
		expect(s.get("this.path.does.not.exist" as never)).toBeUndefined();
	});

	it("boolean false is distinct from missing (not coerced to default)", () => {
		const s = Settings.isolated({ "lsp.formatOnWrite": false } as never);
		expect(s.get("lsp.formatOnWrite")).toBe(false);
	});
});
