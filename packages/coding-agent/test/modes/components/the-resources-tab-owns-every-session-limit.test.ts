/**
 * The Resources tab is a real, reachable surface, and every limit on it renders.
 *
 * WHY THIS SUITE EXISTS. The only session limit that shipped was the per-session CPU
 * budget, and it lived under **Shell -> "CPU Limit"**, wedged between the bash options
 * and the Ruby/Julia interpreter paths. Shell is where you look for how a command is
 * run, not for how much of the machine it may take, so the one control that stops a
 * runaway build was in the last place anybody would look for it. Moving it out and
 * giving every consumption limit one tab is only worth anything if the tab actually
 * renders, and there are four separate ways for a settings row to exist in the schema
 * and reach nobody:
 *
 *   1. A tab with no `TAB_METADATA` entry, or metadata naming an icon no symbol preset
 *      declares. `theme.symbol()` is a plain map read, so a missing key yields
 *      `undefined` and the tab label renders with `undefined` glued to it.
 *   2. A group declared in `TAB_GROUPS` with nothing in it (a promised section that is
 *      never drawn), or a setting whose `ui.group` is not declared, which drops the row
 *      out of the rendered layout AND out of the generated settings reference.
 *   3. A NUMERIC row with no `ui.options` ladder. `pathToSettingDef` treats an
 *      optionless number as schema-only, so the row is documented, defaulted, honored
 *      and unreachable. That is exactly how `subagent.idleTtlMs` shipped invisible.
 *   4. A dependent knob with no resolvable `ui.condition`. An unresolved condition name
 *      fails OPEN, so the kill row would sit on screen offering a policy for a budget
 *      of zero.
 *
 * HOW IT STAYS HONEST. Nothing here hardcodes a membership list that could go stale in
 * silence. The tabs come from `SETTING_TABS`, the groups from `TAB_GROUPS`, the rows
 * from `SETTINGS_SCHEMA` and the real UI adapter (`getSettingsForTab`), all enumerated
 * at run time, so a fifth limit added later with no option ladder, a new group with no
 * rows, or a new tab with no icon turns this suite RED until someone records a
 * decision. Visibility uses the selector's own predicate (`settings-selector.ts`:
 * `if (def.condition && !def.condition()) return null`) against a REAL `Settings`
 * instance, not a re-implementation of what the condition ought to say.
 *
 * WHAT IT DOES NOT COVER. Enforcement. Whether a write budget actually refuses a spawn
 * belongs to the budget group (`session/cpu-limit.ts`) and its own suites; this file
 * owns the settings surface, which is the half that decides whether an operator can
 * find and set the limit at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import {
	getDefault,
	getType,
	getUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	type SettingType,
	TAB_GROUPS,
	TAB_METADATA,
} from "@veyyon/coding-agent/config/settings-schema";
import {
	getAllSettingDefs,
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/components/settings-defs";
import { SYMBOL_PRESETS, type SymbolKey } from "@veyyon/coding-agent/modes/theme/symbols";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-resources-tab-");

/** Every path the schema declares, as a typed list, enumerated at run time. */
function schemaPaths(): SettingPath[] {
	return Object.keys(SETTINGS_SCHEMA) as SettingPath[];
}

/** The UI block of a path, or undefined for a schema-only key. */
function ui(pathId: SettingPath): { tab: SettingTab; group?: string } | undefined {
	const block = getUi(pathId);
	return block ? { tab: block.tab, group: block.group } : undefined;
}

/**
 * The paths a user would actually see on `tab`, filtered exactly as
 * `settings-selector.ts` filters them before building rows.
 */
function visiblePaths(tab: SettingTab): string[] {
	return getSettingsForTab(tab)
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	invalidateSettingDefsCache();
});

afterEach(() => {
	resetSettingsForTest();
	invalidateSettingDefsCache();
});

describe("every settings tab is a complete, renderable surface", () => {
	/**
	 * Metadata and a group list for every tab, plus an icon that RESOLVES in every
	 * symbol preset. The icon is asserted per preset rather than through the active
	 * theme alone because the preset is an operator setting: a key present in `nerd`
	 * and missing from `ascii` renders correctly for whoever wrote it and breaks for
	 * everyone on a terminal without the font. Presence is the assertion, not
	 * non-emptiness: the unicode preset ships every tab glyph deliberately empty
	 * (icon-light doctrine), so requiring a glyph there would forbid the shipped design.
	 */
	it("declares metadata, a resolvable icon in every symbol preset, and a group list", () => {
		const problems: string[] = [];
		for (const tab of SETTING_TABS) {
			const meta = TAB_METADATA[tab];
			if (!meta) {
				problems.push(`${tab}: no TAB_METADATA entry`);
				continue;
			}
			if (!meta.label) problems.push(`${tab}: empty label`);
			if (!TAB_GROUPS[tab]) problems.push(`${tab}: no TAB_GROUPS entry`);
			for (const [preset, symbols] of Object.entries(SYMBOL_PRESETS)) {
				if (!Object.hasOwn(symbols, meta.icon)) {
					problems.push(`${tab}: icon "${meta.icon}" is not declared in the ${preset} symbol preset`);
				}
			}
			// The live theme is the last reader; an undefined here is what glues
			// "undefined" onto the tab label in the sidebar.
			if (typeof theme.symbol(meta.icon as SymbolKey) !== "string") {
				problems.push(`${tab}: icon "${meta.icon}" does not resolve through the active theme`);
			}
		}

		expect(problems).toEqual([]);
	});

	/**
	 * A declared group with no rows is a section heading the panel promises and never
	 * draws. Derived from the real adapter output, which includes the synthetic default
	 * model row, so "non-empty" means what the operator sees rather than what the schema
	 * happens to spell.
	 */
	it("fills every group it declares, on every tab", () => {
		const empty: string[] = [];
		for (const tab of SETTING_TABS) {
			const rendered = new Set(getSettingsForTab(tab).map(def => def.group));
			for (const group of TAB_GROUPS[tab]) {
				if (!rendered.has(group)) empty.push(`${tab} -> "${group}"`);
			}
		}

		expect(empty, "each is a declared section with no setting behind it").toEqual([]);
	});

	/** Non-vacuity: the walk above is only meaningful while the adapter returns rows. */
	it("returns rows for every declared tab", () => {
		for (const tab of SETTING_TABS) {
			expect(getSettingsForTab(tab).length, `${tab} renders nothing`).toBeGreaterThan(0);
		}
	});
});

describe("the Resources tab holds every session limit", () => {
	it("sits in the first half of the sidebar, right after Interaction", () => {
		expect(TAB_METADATA.resources).toEqual({ label: "Resources", icon: "tab.resources" });
		const order = [...SETTING_TABS];
		expect(order).toContain("resources");
		expect(order[order.indexOf("interaction") + 1]).toBe("resources");
		expect(order.indexOf("resources")).toBeLessThan(order.length / 2);
	});

	it("declares its groups in consumption order and nothing else", () => {
		expect(TAB_GROUPS.resources).toEqual(["CPU", "Memory", "Disk", "Processes"]);
	});

	/**
	 * Every row ON the tab lands in one of the tab's declared groups. A row with an
	 * undeclared group is dropped from the rendered layout and from the generated
	 * reference page, which is indistinguishable from never having declared it.
	 */
	it("places every one of its settings in a declared group", () => {
		const declared = new Set(TAB_GROUPS.resources);
		const stray: string[] = [];
		for (const pathId of schemaPaths()) {
			const block = ui(pathId);
			if (block?.tab !== "resources") continue;
			if (!block.group || !declared.has(block.group)) stray.push(`${pathId} -> "${block.group ?? "(none)"}"`);
		}

		expect(stray, "each names a group the Resources tab does not declare").toEqual([]);
		// Non-vacuity: the loop above passes trivially if nothing claims the tab.
		expect(schemaPaths().filter(p => ui(p)?.tab === "resources").length).toBeGreaterThan(3);
	});

	/**
	 * The old location is gone from both sides. A leftover row still claiming
	 * shell/"CPU Limit" would render under Shell (its group is undeclared there now, so
	 * it would fall to the end of the tab), and a leftover group with no rows would draw
	 * an empty section, so both halves of the move are asserted.
	 */
	it("leaves nothing behind under Shell", () => {
		expect(TAB_GROUPS.shell).not.toContain("CPU Limit");
		const leftovers = schemaPaths().filter(pathId => {
			const block = ui(pathId);
			return block?.tab === "shell" && block.group === "CPU Limit";
		});
		expect(leftovers).toEqual([]);
	});
});

/**
 * The keys are the compatibility contract. The rows moved FILE and moved TAB, and an
 * operator's `config.yml` knows nothing about either; a renamed key would silently
 * revert a configured cap to "off" with no warning and no migration, which is the
 * worst failure this area has.
 */
describe("the moved CPU rows keep their keys, types and defaults", () => {
	const MOVED: { path: SettingPath; type: SettingType; default: number | boolean; group: string }[] = [
		{ path: "session.cpuLimitCores", type: "number", default: 0, group: "CPU" },
		{ path: "session.cpuLimitKill", type: "boolean", default: false, group: "CPU" },
	];

	it.each(MOVED)("$path is unchanged except for its placement", ({ path: pathId, type, default: value, group }) => {
		expect(getType(pathId)).toBe(type);
		expect(getDefault(pathId)).toBe(value);
		expect(getUi(pathId)).toMatchObject({ tab: "resources", group });
		expect(getSettingsForTab("resources").map(def => def.path)).toContain(pathId);
	});

	it("reads a config file written before the move", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "profile");
		const cwd = path.join(root, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const overlay = path.join(root, "config.yml");
		fs.writeFileSync(overlay, YAML.stringify({ session: { cpuLimitCores: 4, cpuLimitKill: true } }));

		const loaded = await Settings.loadIsolated({ agentDir, cwd, configFiles: [overlay] });

		expect(loaded.get("session.cpuLimitCores")).toBe(4);
		expect(loaded.get("session.cpuLimitKill")).toBe(true);
	});
});

/**
 * The failure mode a missing `ui.options` ladder produces, asserted over every numeric
 * row the tab carries rather than the ones that exist today. `pathToSettingDef` maps an
 * optionless number to a free-text row, and `getSettingsForTab` returns it either way,
 * so "survives the adapter" means it arrives as a SUBMENU with a ladder to pick from:
 * that is what the shipped numeric limits offer, and a text box for "how many cores"
 * with no ladder is the shape `subagent.idleTtlMs` was invisible in.
 */
describe("every numeric limit on the tab survives the UI adapter", () => {
	it("arrives as a submenu with a non-empty option ladder", () => {
		const numeric = schemaPaths().filter(pathId => ui(pathId)?.tab === "resources" && getType(pathId) === "number");
		expect(numeric.length, "no numeric rows to check").toBeGreaterThan(2);

		const rendered = new Map(getSettingsForTab("resources").map(def => [def.path, def]));
		const broken: string[] = [];
		for (const pathId of numeric) {
			const def = rendered.get(pathId);
			if (!def) {
				broken.push(`${pathId}: dropped by getSettingsForTab`);
				continue;
			}
			if (def.type !== "submenu") {
				broken.push(`${pathId}: rendered as "${def.type}", so it declares no option ladder`);
				continue;
			}
			if (def.options.length === 0) broken.push(`${pathId}: empty option ladder`);
		}

		expect(broken, "each numeric row needs an explicit ui.options ladder").toEqual([]);
	});

	/** The ladder has to include the off value, or the limit cannot be lifted from the UI. */
	it("offers the documented off value on each ladder", () => {
		for (const def of getSettingsForTab("resources")) {
			if (def.type !== "submenu" || getType(def.path as SettingPath) !== "number") continue;
			const off = String(getDefault(def.path as SettingPath));
			expect(
				def.options.map(option => option.value),
				`${def.path} cannot be returned to its default from the UI`,
			).toContain(off);
		}
	});
});

/**
 * The kill knob is HIDDEN while the budget is zero, not shown inert. Driven through the
 * real `Settings` singleton the condition reads, in both directions, because asserting
 * only "hidden when off" is satisfied by hiding the row forever.
 */
describe("the write-budget kill row appears only once a budget exists", () => {
	it("is absent at the shipped default and present above zero", () => {
		expect(settings.get("session.writeBudgetGb")).toBe(0);
		expect(visiblePaths("resources")).not.toContain("session.writeBudgetKill");

		settings.set("session.writeBudgetGb", 25);

		expect(visiblePaths("resources")).toContain("session.writeBudgetKill");
		// Hiding must never be implemented by moving the default.
		expect(getDefault("session.writeBudgetKill")).toBe(false);
		expect(settings.get("session.writeBudgetKill")).toBe(false);
	});

	/**
	 * NEGATIVE CONTROL. Every assertion above is about absence, which an empty tab or a
	 * broken `visiblePaths` satisfies perfectly. The budget row itself carries no
	 * condition, so it is the state a dependent is in when its `ui.condition` is deleted:
	 * visible at zero. If it ever stopped rendering, the absence checks would be green
	 * for the wrong reason.
	 */
	it("keeps the budget row itself visible at zero", () => {
		expect(settings.get("session.writeBudgetGb")).toBe(0);
		expect(visiblePaths("resources")).toContain("session.writeBudgetGb");
		expect(visiblePaths("resources").length).toBeGreaterThan(3);
	});

	/**
	 * Every condition-gated row on this tab resolves to a real predicate, derived from
	 * the schema rather than from the two that exist today. An unresolved name fails
	 * OPEN, so this is the direction that shows an operator a control for a limit that
	 * is switched off.
	 */
	it("resolves every condition the tab declares", () => {
		const declared = schemaPaths().filter(pathId => ui(pathId)?.tab === "resources" && getUi(pathId)?.condition);
		expect(declared.length, "no conditioned rows to check").toBeGreaterThan(1);

		const defs = new Map(getAllSettingDefs().map(def => [def.path, def]));
		const unresolved = declared.filter(pathId => typeof defs.get(pathId)?.condition !== "function");

		expect(unresolved, "each declares a condition that resolves to nothing").toEqual([]);
	});
});
