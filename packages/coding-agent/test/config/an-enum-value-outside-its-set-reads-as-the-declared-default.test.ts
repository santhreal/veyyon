/**
 * WHY: `config set` rejects an enum value outside the setting's `values`, but a value written into
 * `config.yml` by hand reached every consumer verbatim, and each consumer compared it against its own
 * literals and took whichever branch its `else` happened to be. The defect class is any enum setting
 * whose read returns a value the schema does not declare. The store's read path now answers such a
 * value with the declared default and reports it once per path.
 *
 * The suite sweeps every `type: "enum"` setting in `SETTINGS_SCHEMA` at run time, so a new enum joins
 * with no edit here. It loads each variant from a real `config.yml` through `Settings.init`: an
 * unknown string, a non-scalar and `null` read as the default; a non-default member reads back
 * unchanged; an unquoted YAML scalar whose string form is a member reads as that member. It asserts
 * one warning per path across a rebuild of the merged view, which drops every cached read.
 *
 * Not caught: a global-scoped enum, whose value the store reads through its binding from
 * `~/.veyyon/config.yml` rather than the profile file. None exists, and the last cell pins that set
 * empty so the first one turns this suite red until the sweep covers it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GLOBAL_SETTING_BINDINGS } from "@veyyon/coding-agent/config/settings-domains/global";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import type { SettingPath } from "@veyyon/kernel/settings/schema";
import { getProjectAgentDir, logger, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

interface EnumSetting {
	path: SettingPath;
	values: readonly string[];
	default: string;
}

const ENUMS: EnumSetting[] = Object.entries(
	SETTINGS_SCHEMA as Record<string, { type: string; values?: readonly string[]; default: unknown }>,
)
	.filter(([, def]) => def.type === "enum")
	.map(([settingPath, def]) => ({
		path: settingPath as SettingPath,
		values: def.values ?? [],
		default: def.default as string,
	}));

const INVALID_ENUM_WARNING = "Settings: enum value is not one of its declared values; using the default";

/** A nested config tree holding `pick(setting)` at every enum path. */
function configWith(pick: (setting: EnumSetting) => unknown): Record<string, unknown> {
	const tree: Record<string, unknown> = {};
	for (const setting of ENUMS) {
		const segments = setting.path.split(".");
		let node = tree;
		for (const segment of segments.slice(0, -1)) {
			node[segment] ??= {};
			node = node[segment] as Record<string, unknown>;
		}
		node[segments.at(-1)!] = pick(setting);
	}
	return tree;
}

describe("an enum value outside its set reads as the declared default", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let warnings: { message: string; context: Record<string, unknown> | undefined }[];

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-enum-read-validation-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			warnings.push({ message, context });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	function readAll(settings: Settings): Record<string, unknown> {
		return Object.fromEntries(ENUMS.map(setting => [setting.path, settings.get(setting.path)]));
	}

	it("sweeps the enum settings the schema declares", () => {
		expect(ENUMS.map(setting => setting.path)).toContain("edit.afterEdit");
		for (const setting of ENUMS) expect(setting.values, setting.path).toContain(setting.default);
	});

	/**
	 * `migratedAtLoad` is the paths whose load migration rewrites the value before the read path
	 * sees it, pinned by exact equality: `compaction.strategy` maps any unknown strategy name to
	 * `summary`, so that string never reaches the read path and is not reported there.
	 */
	it.each<[string, unknown, string[]]>([
		["an unknown string", "not-a-declared-member", ["compaction.strategy"]],
		["an object", { nested: true }, []],
		["null", null, []],
	])("%s reads as the default, reported once per path across a rebuild", async (_name, invalid, migratedAtLoad) => {
		const settings = await loadWith(configWith(() => invalid));
		const defaults = Object.fromEntries(ENUMS.map(setting => [setting.path, setting.default]));
		expect(readAll(settings)).toEqual(defaults);
		settings.rebuildMerged();
		expect(readAll(settings)).toEqual(defaults);

		const reported = warnings.filter(warning => warning.message === INVALID_ENUM_WARNING);
		expect(reported.map(warning => warning.context?.reason).sort()).toEqual(
			ENUMS.filter(setting => !migratedAtLoad.includes(setting.path))
				.map(
					setting =>
						`${setting.path}: expected one of ${setting.values.join(", ")}, found ${JSON.stringify(invalid)}`,
				)
				.sort(),
		);
	});

	it("a declared member other than the default reads back unchanged, with nothing reported", async () => {
		const member = (setting: EnumSetting) =>
			setting.values.find(value => value !== setting.default) ?? setting.default;
		const settings = await loadWith(configWith(member));
		expect(readAll(settings)).toEqual(Object.fromEntries(ENUMS.map(setting => [setting.path, member(setting)])));
		expect(warnings.filter(warning => warning.message === INVALID_ENUM_WARNING)).toEqual([]);
	});

	it("an unquoted scalar whose string form is a member reads as that member", async () => {
		const numeric = ENUMS.flatMap(setting =>
			setting.values.filter(value => String(Number(value)) === value).map(value => ({ setting, value })),
		);
		expect(numeric.length, "anti-vacuity: some enum declares a numeric member").toBeGreaterThan(0);
		for (const { setting, value } of numeric) {
			const settings = await loadWith(configWith(other => (other === setting ? Number(value) : other.default)));
			expect(settings.get(setting.path), setting.path).toBe(value);
		}
		expect(warnings.filter(warning => warning.message === INVALID_ENUM_WARNING)).toEqual([]);
	});

	it("no enum setting is global-scoped, so the profile-file sweep reaches every one", () => {
		expect(ENUMS.filter(setting => setting.path in GLOBAL_SETTING_BINDINGS).map(setting => setting.path)).toEqual([]);
	});
});
