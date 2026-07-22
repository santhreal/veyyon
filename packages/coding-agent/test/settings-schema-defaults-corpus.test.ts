import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GLOBAL_SETTING_BINDINGS } from "@veyyon/coding-agent/config/settings-domains/global";
import {
	getDefault,
	getEnumValues,
	getType,
	type SettingPath,
	SETTINGS_SCHEMA,
} from "@veyyon/coding-agent/config/settings-schema";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/**
 * Table-driven contract over every SETTINGS_SCHEMA path:
 * - profile-scoped paths on Settings.isolated({}) match schema defaults
 * - global-scoped paths route through GLOBAL_SETTING_BINDINGS (one owner)
 * - every enum path has a non-empty values list and the default is a member
 * - every path has a known type tag
 *
 * When a new setting is added to a settings-domains/* file, this suite fails
 * until the default is loadable through Settings.isolated (schema composition
 * and runtime get() stay in lockstep).
 */

const ALL_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

const KNOWN_TYPES = new Set(["boolean", "number", "string", "enum", "object", "array", "record"]);

function isGlobalScoped(path: SettingPath): boolean {
	const def = SETTINGS_SCHEMA[path] as { ui?: { scope?: string } };
	return def.ui?.scope === "global";
}

function valuesEqual(path: SettingPath, actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	const type = getType(path);
	if (type === "array" || type === "object" || type === "record") {
		return JSON.stringify(actual) === JSON.stringify(expected);
	}
	return false;
}

describe("settings schema defaults corpus", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("enumerates a substantial schema (guards empty composition)", () => {
		// Schema must stay large; a bad domain import that drops half the map
		// would otherwise leave defaults looking "fine" on a tiny remainder.
		expect(ALL_PATHS.length).toBeGreaterThan(80);
	});

	it("every path has a documented type tag", () => {
		const broken: string[] = [];
		for (const path of ALL_PATHS) {
			const t = getType(path);
			if (!KNOWN_TYPES.has(t)) {
				broken.push(`${path}: ${String(t)}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("every enum path has values and a default that is a member", () => {
		const broken: string[] = [];
		for (const path of ALL_PATHS) {
			if (getType(path) !== "enum") continue;
			const values = getEnumValues(path) ?? [];
			if (values.length === 0) {
				broken.push(`${path}: empty enum values`);
				continue;
			}
			const def = getDefault(path);
			if (!values.includes(def as string)) {
				broken.push(`${path}: default ${JSON.stringify(def)} not in [${values.join(", ")}]`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("every global-scoped path has a GLOBAL_SETTING_BINDINGS entry", () => {
		const broken: string[] = [];
		for (const path of ALL_PATHS) {
			if (!isGlobalScoped(path)) continue;
			if (!(path in GLOBAL_SETTING_BINDINGS)) {
				broken.push(path);
			}
		}
		expect(broken).toEqual([]);
	});

	it("Settings.isolated({}) matches schema defaults for non-global paths", () => {
		const settings = Settings.isolated({});
		const broken: string[] = [];
		for (const path of ALL_PATHS) {
			if (isGlobalScoped(path)) continue;
			const expected = getDefault(path);
			const actual = settings.get(path);
			if (!valuesEqual(path, actual, expected)) {
				broken.push(`${path}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("global-scoped paths on isolated settings match their binding readers", () => {
		// Global keys intentionally ignore inMemory: they always read the
		// machine-wide config so the UI and CLI share one owner.
		const settings = Settings.isolated({});
		const broken: string[] = [];
		for (const path of ALL_PATHS) {
			if (!isGlobalScoped(path)) continue;
			const binding = GLOBAL_SETTING_BINDINGS[path];
			const expected = binding.read();
			const actual = settings.get(path);
			if (!valuesEqual(path, actual, expected)) {
				broken.push(`${path}: got ${JSON.stringify(actual)} want binding ${JSON.stringify(expected)}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("Settings.isolated override beats the schema default for a boolean sample", () => {
		// Representative override: if isolated() ignores overrides, every
		// settings e2e that seeds config is lying.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			...("autoResume" in SETTINGS_SCHEMA ? { autoResume: true } : {}),
		});
		expect(settings.get("compaction.enabled")).toBe(false);
		expect(getDefault("compaction.enabled")).toBe(true);
		if ("autoResume" in SETTINGS_SCHEMA) {
			expect(settings.get("autoResume" as SettingPath)).toBe(true);
			expect(getDefault("autoResume" as SettingPath)).toBe(false);
		}
	});

	it("path list is stable under dual read (no hidden lazy registration)", () => {
		const second = Object.keys(SETTINGS_SCHEMA);
		expect(second).toEqual(ALL_PATHS as unknown as string[]);
	});
});
