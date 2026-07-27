import { describe, expect, it } from "bun:test";
import { UNSET_NUMBER_OPTION_VALUE } from "@veyyon/coding-agent/config/optional-number";
import {
	getDefault,
	getEnumValues,
	getType,
	isUnsetNumberPath,
	type SettingPath,
} from "@veyyon/coding-agent/config/settings-schema";
import { getAllSettingDefs } from "@veyyon/coding-agent/modes/components/settings-defs";

/**
 * HSL-2: every `ui.options[].value` string a user can pick in `/settings` must
 * round-trip through the setter for that setting's type. A number option whose
 * value does not parse to a finite number would silently store `NaN`; an enum
 * option whose value is not a declared enum value would store a value the
 * schema rejects. These guards fail loudly if a new option is added that does
 * not round-trip, instead of shipping a knob that silently ignores the choice.
 *
 * The setter logic lives in `settings-selector.ts #setSettingValue`:
 *  - an optional numeric setting (isUnsetNumberPath) accepts the string
 *    `"default"`, stored as the UNSET_NUMBER sentinel,
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
				const isSentinelDefault = isUnsetNumberPath(def.path) && opt.value === UNSET_NUMBER_OPTION_VALUE;
				if (isSentinelDefault) continue;
				if (!Number.isFinite(Number(opt.value))) {
					broken.push(`${def.path} -> ${JSON.stringify(opt.value)}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("uses the string 'default' (not '-1') for the unset option on every optional numeric setting", () => {
		// The reverse mapping (#getSubmenuCurrentValue) turns a stored -1 into the
		// string "default", so the option that represents the default MUST use
		// value "default" or it will never render as selected.
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (!isUnsetNumberPath(def.path)) continue;
			const hasDefaultOption = def.options.some(o => o.value === UNSET_NUMBER_OPTION_VALUE);
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
 * HSL-1: a numeric knob's default must stay reachable. Once you change a knob you
 * must be able to get back, so a submenu has to carry a row that restores the
 * default, and the default has to be what the schema actually declares.
 *
 * The shape of "default" changed here: an optional numeric setting stores NO
 * value when unset (an absent key, restored by the shared `Default` row) rather
 * than the old `-1` sentinel, which stole a value the provider accepts. Knobs
 * whose `-1` means something they name — `argot.encode.disableAboveTokens` "Off",
 * `providers.stream*TimeoutSeconds` "Auto" — keep it as a real default.
 */
describe("numeric defaults are consistent and reachable (HSL-1)", () => {
	const defs = getAllSettingDefs();
	const submenuDefs = defs.filter((def): def is Extract<typeof def, { type: "submenu" }> => def.type === "submenu");

	it("every optional numeric setting has no stored default at all", () => {
		// The set is schema-derived now, so pin it exactly: an empty sweep would pass
		// vacuously, and a setting silently leaving the set is a knob whose Default
		// row stopped round-tripping.
		const optional = getAllSettingDefs().filter(def => isUnsetNumberPath(def.path));
		expect(optional.map(def => def.path).sort()).toEqual([
			"compaction.modelContextWindow",
			"minP",
			"presencePenalty",
			"repetitionPenalty",
			"temperature",
			"topK",
			"topP",
		]);
		// Unset is an ABSENT key, so the schema default is undefined. A sentinel
		// default would steal a real value: `presencePenalty: -1` is a penalty the
		// provider accepts, and while -1 meant "unset" it could not be configured.
		const broken: string[] = [];
		for (const def of optional) {
			const defaultValue = getDefault(def.path as SettingPath);
			if (defaultValue !== undefined) {
				broken.push(`${def.path} defaults to ${JSON.stringify(defaultValue)}, expected no default`);
			}
		}
		expect(broken).toEqual([]);
	});

	/** A numeric knob must always offer a way back to its default, whether that
	 * default is an absent key (the `Default` row, which unsets) or an explicit
	 * `-1` that means something the setting names (`argot.encode.disableAboveTokens` uses
	 * -1 for "Off", `providers.stream*TimeoutSeconds` for "Auto"). */
	it("every numeric submenu exposes an option that restores its default", () => {
		const broken: string[] = [];
		for (const def of submenuDefs) {
			if (getType(def.path) !== "number") continue;
			const defaultValue = getDefault(def.path);
			const restores = def.options.some(o => {
				if (isUnsetNumberPath(def.path) && o.value === UNSET_NUMBER_OPTION_VALUE) return true;
				if (defaultValue === undefined) return false;
				return Number(o.value) === defaultValue;
			});
			if (!restores)
				broken.push(`${def.path} defaults to ${JSON.stringify(defaultValue)} but no option restores it`);
		}
		expect(broken).toEqual([]);
	});
});
