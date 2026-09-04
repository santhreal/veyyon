/**
 * WHY: the settings schema queries used to close over one composed constant, so a query anywhere
 * always saw every setting. They now answer from a registry that tables register into by import,
 * which admits a state the constant never had: a registry with nothing in it. Answered quietly,
 * `isSettingPath("compaction.enabled")` is `false` before the composition loads, and a validator
 * reports every key a config names as unknown — a wrong answer shaped like a decision. This suite
 * closes that class: a query against an empty registry throws naming the cause, a query for a path
 * no table declared throws naming the path, and one path cannot be declared by two tables.
 *
 * It runs in the kernel, where no application composition is on the module graph, which is the
 * only place the empty state is reachable without unloading modules.
 *
 * What it does not catch: a registry that is non-empty but missing the table a caller needed. That
 * is the same silence one level up, and it is caught where it can be — the composition test in the
 * application pins every domain the schema spreads.
 */

import { describe, expect, it } from "bun:test";
import {
	declareSettings,
	describeSettingTypeMismatch,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	hasUi,
	isSettingPath,
	isUnsetNumberPath,
	retiredBy,
	type SettingPath,
	type SettingsTable,
	settingsSchema,
} from "@veyyon/kernel/settings/schema";

const EMPTY = /No settings are declared/;

/** A table the way a package writes one: declared at module scope, registered when the package loads. */
const EXAMPLE_SETTINGS = {
	"example.flag": {
		type: "boolean",
		default: true,
		ui: { tab: "global", label: "Flag", description: "A flag." },
	},
	"example.mode": { type: "enum", values: ["a", "b"], default: "a", retiredBy: "example.flag" },
	"example.count": {
		type: "number",
		default: 3,
		ui: {
			tab: "global",
			label: "Count",
			description: "A count.",
			options: [{ value: "default", label: "Default" }],
		},
	},
} as const satisfies SettingsTable;

type ExampleSettings = typeof EXAMPLE_SETTINGS;

declare module "@veyyon/kernel/settings/schema" {
	interface DeclaredSettings extends ExampleSettings {}
}

describe("a settings query answers from the registered tables or fails loud", () => {
	it("throws from every query while no table has registered", () => {
		const path: SettingPath = "example.flag";
		expect(() => settingsSchema()).toThrow(EMPTY);
		expect(() => isSettingPath("example.flag")).toThrow(EMPTY);
		expect(() => getDefault(path)).toThrow(EMPTY);
		expect(() => getType(path)).toThrow(EMPTY);
		expect(() => getUi(path)).toThrow(EMPTY);
		expect(() => hasUi(path)).toThrow(EMPTY);
		expect(() => getEnumValues(path)).toThrow(EMPTY);
		expect(() => retiredBy(path)).toThrow(EMPTY);
		expect(() => isUnsetNumberPath(path)).toThrow(EMPTY);
		expect(() => getPathsForTab("global")).toThrow(EMPTY);
		expect(() => describeSettingTypeMismatch("example.flag", true)).toThrow(EMPTY);
	});

	it("answers from a table once it registers, and hands the table back as the same object", () => {
		const table = declareSettings(EXAMPLE_SETTINGS);

		expect(table).toBe(EXAMPLE_SETTINGS);
		expect(settingsSchema()["example.flag"]).toBe(EXAMPLE_SETTINGS["example.flag"]);
		expect(isSettingPath("example.flag")).toBe(true);
		expect(isSettingPath("example.absent")).toBe(false);
		// Typed through the merged declaration: a boolean default, an enum's members.
		const flag: boolean = getDefault("example.flag");
		const mode: "a" | "b" = getDefault("example.mode");
		expect(flag).toBe(true);
		expect(mode).toBe("a");
		expect(getType("example.mode")).toBe("enum");
		expect(getEnumValues("example.mode")).toEqual(["a", "b"]);
		expect(retiredBy("example.mode")).toBe("example.flag");
		expect(retiredBy("example.flag")).toBeUndefined();
		expect(hasUi("example.flag")).toBe(true);
		expect(hasUi("example.mode")).toBe(false);
		expect(getUi("example.flag")?.label).toBe("Flag");
		expect(getPathsForTab("global")).toEqual(["example.flag", "example.count"]);
		expect(isUnsetNumberPath("example.count")).toBe(true);
		expect(isUnsetNumberPath("example.flag")).toBe(false);
		expect(describeSettingTypeMismatch("example.mode", "c")).toBe('example.mode: expected one of a, b, found "c"');
		expect(describeSettingTypeMismatch("example.flag", false)).toBeUndefined();
	});

	it("throws naming the path when a declared registry has no such setting", () => {
		const absent = "example.absent" as SettingPath;
		for (const query of [getDefault, getType, getUi, hasUi, getEnumValues]) {
			expect(() => query(absent)).toThrow('Setting "example.absent" is not declared');
		}
		// The queries that answer "is this a setting" or "what replaced it" answer for an absent
		// path instead of throwing: the caller is asking whether the key is real.
		expect(retiredBy(absent)).toBeUndefined();
		expect(isUnsetNumberPath(absent)).toBe(false);
		expect(describeSettingTypeMismatch("example.absent", 1)).toBeUndefined();
	});

	it("rejects a second table declaring a path the first already declared", () => {
		expect(() =>
			declareSettings({
				"example.other": { type: "string", default: undefined },
				"example.flag": { type: "boolean", default: false },
			}),
		).toThrow('Setting "example.flag" is declared twice');
		// A rejected table registers none of its paths, not the ones before the collision.
		expect(isSettingPath("example.other")).toBe(false);
		expect(getDefault("example.flag")).toBe(true);
	});
});
