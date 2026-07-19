import { describe, expect, it } from "bun:test";
import { getDefault, getEnumValues, getType, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { getAllSettingDefs } from "@veyyon/coding-agent/modes/components/settings-defs";
import { COMPACTION_DEFAULT_SENTINEL_PATHS } from "@veyyon/coding-agent/modes/components/settings-selector";

/**
 * HSL-2: every `ui.options[].value` string a user can pick in `/settings` must
 * round-trip through the setter for that setting's type. A number option whose
 * value does not parse to a finite number would silently store `NaN`; an enum
 * option whose value is not a declared enum value would store a value the
 * schema rejects. These guards fail loudly if a new option is added that does
 * not round-trip, instead of shipping a knob that silently ignores the choice.
 *
 * The setter logic lives in `settings-selector.ts #setSettingValue`:
 *  - sentinel paths accept the string `"default"` (mapped to -1),
 *  - number settings otherwise do `settings.set(path, Number(value))`,
 *  - enum settings store the value string as-is.
 */
describe("settings UI option values round-trip through their setter (HSL-2)", () => {
	const defs = getAllSettingDefs();

	// A submenu def can back a number, an enum, or a string setting; recover the
	// underlying schema type to know which round-trip rule applies.
	const submenuDefs = defs.filter((def): def is Extract<typeof def, { type: "submenu" }> => def.type === "submenu");

	it("has submenu settings to check (guards against an empty, vacuously-passing sweep)", () => {
		expect(submenuDefs.length).toBeGreaterThan(10);
	});

	it("every numeric option value parses to a finite number (or the documented default sentinel)", () => {
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (getType(def.path) !== "number") continue;
			for (const opt of def.options) {
				const isSentinelDefault =
					COMPACTION_DEFAULT_SENTINEL_PATHS.has(def.path) &&
					(opt.value === "default" || opt.value === "-1" || opt.value === "");
				if (isSentinelDefault) continue;
				if (!Number.isFinite(Number(opt.value))) {
					broken.push(`${def.path} -> ${JSON.stringify(opt.value)}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("uses the string 'default' (not '-1') for the sentinel option on sentinel-path number settings", () => {
		// The reverse mapping (#getSubmenuCurrentValue) turns a stored -1 into the
		// string "default", so the option that represents the default MUST use
		// value "default" or it will never render as selected.
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (!COMPACTION_DEFAULT_SENTINEL_PATHS.has(def.path)) continue;
			const hasDefaultOption = def.options.some(o => o.value === "default");
			// Every sentinel-path knob defaults to -1, so it must expose a "default" option.
			if (!hasDefaultOption) broken.push(def.path);
			// And it must not try to represent that default with a literal "-1" value,
			// which would forward-parse fine but never highlight as the current value.
			if (def.options.some(o => o.value === "-1")) broken.push(`${def.path} (uses "-1" instead of "default")`);
		}
		expect(broken).toEqual([]);
	});

	it("every enum-backed submenu option value is a value the schema declares", () => {
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (getType(def.path) !== "enum") continue;
			const enumValues = getEnumValues(def.path) ?? [];
			// A runtime-injected enum (e.g. thinking levels, themes) legitimately
			// carries values outside the static enum; those render with empty static
			// options, so any listed option must match a declared value.
			if (enumValues.length === 0) continue;
			for (const opt of def.options) {
				if (!enumValues.includes(opt.value)) {
					broken.push(`${def.path} -> ${JSON.stringify(opt.value)} (declared: ${enumValues.join(", ")})`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("plain enum settings (no options) expose at least one declared value", () => {
		const broken: string[] = [];
		for (const def of defs) {
			if (def.type !== "enum") continue;
			if ((def.values ?? []).length === 0) broken.push(def.path);
		}
		expect(broken).toEqual([]);
	});
});

/**
 * HSL-1: numeric sentinel defaults must stay reachable and consistent. A knob
 * that defaults to the `-1` "inherit/default" sentinel must (a) actually declare
 * `-1` as its schema default and (b) expose a UI option that restores that
 * sentinel, or the user can never get back to the default once they change it.
 * A mismatch here silently changes behavior (the stored default and the
 * "Default" option disagree, or the default is unreachable).
 */
describe("numeric sentinel defaults are consistent and reachable (HSL-1)", () => {
	const defs = getAllSettingDefs();
	const submenuDefs = defs.filter((def): def is Extract<typeof def, { type: "submenu" }> => def.type === "submenu");

	it("every compaction sentinel-path setting defaults to -1", () => {
		const broken: string[] = [];
		for (const path of COMPACTION_DEFAULT_SENTINEL_PATHS) {
			const defaultValue = getDefault(path as SettingPath);
			if (defaultValue !== -1) broken.push(`${path} defaults to ${JSON.stringify(defaultValue)}, expected -1`);
		}
		expect(broken).toEqual([]);
	});

	it("every numeric submenu whose default is the -1 sentinel exposes an option that restores it", () => {
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (getType(def.path) !== "number") continue;
			if (getDefault(def.path) !== -1) continue;
			// The option must map back to -1: either the "default" sentinel string
			// on a sentinel path, or a literal "-1"/"" value that Number()-parses to -1.
			const restores = def.options.some(o => {
				if (
					COMPACTION_DEFAULT_SENTINEL_PATHS.has(def.path) &&
					(o.value === "default" || o.value === "" || o.value === "-1")
				) {
					return true;
				}
				return Number(o.value) === -1;
			});
			if (!restores) broken.push(`${def.path} defaults to -1 but no option restores it`);
		}
		expect(broken).toEqual([]);
	});
});
