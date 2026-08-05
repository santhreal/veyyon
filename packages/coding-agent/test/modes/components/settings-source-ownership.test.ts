/**
 * A settings row must describe the layer that owns its effective value.
 *
 * Before source provenance was tracked, /settings rendered every resolved value as
 * a profile control. Activating a --config or runtime-shadowed row then wrote an
 * invisible lower-precedence profile value and fired onChange even though the
 * effective setting never changed.
 *
 * The project layer that used to be a third shadowing source is gone: a
 * repository's `<cwd>/.veyyon/config.yml` produces no source and no shadow, and
 * two cases here pin that inversion (reintroducing the layer turns them red).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as YAML from "yaml";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../helpers/tracked-temp-dir";

const SETTING_PATH = "contextPromotion.enabled" as const;
const SETTING_LABEL = "Auto-Promote Context";
const makeTempDir = useTrackedTempDirs("veyyon-settings-source-");

interface Fixture {
	agentDir: string;
	cwd: string;
}

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function makeFixture(): Fixture {
	const root = makeTempDir();
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	return { agentDir, cwd };
}

function writeSetting(filePath: string, enabled: boolean): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, YAML.stringify({ contextPromotion: { enabled } }));
}

function writeProfile(fixture: Fixture, enabled: boolean): void {
	writeSetting(path.join(fixture.agentDir, "config.yml"), enabled);
}

function writeProject(fixture: Fixture, enabled: boolean): void {
	writeSetting(path.join(fixture.cwd, ".veyyon", "config.yml"), enabled);
}

function readProfileValue(fixture: Fixture): boolean {
	const profile = YAML.parse(fs.readFileSync(path.join(fixture.agentDir, "config.yml"), "utf8")) as {
		contextPromotion: { enabled: boolean };
	};
	return profile.contextPromotion.enabled;
}

function createSelector(cwd: string, changes: Array<[string, unknown]>): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd,
		},
		{
			onChange: (settingPath, value) => changes.push([settingPath, value]),
			onCancel: () => {},
		},
	);
	component.openTab("context");
	expect(component.selectSetting(SETTING_PATH)).toBe(true);
	return component;
}

function leftClick(frame: readonly string[], needle: string): string {
	const visible = frame.map(stripVTControlCharacters);
	const row = visible.findIndex(line => line.includes(needle));
	const col = row >= 0 ? visible[row]!.indexOf(needle) : -1;
	expect(row).toBeGreaterThanOrEqual(0);
	expect(col).toBeGreaterThanOrEqual(0);
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

describe("Settings source provenance", () => {
	/** An absent value is owned by the schema, not by an empty profile file produced during startup. */
	it("reports the exact default source and effective default", async () => {
		const fixture = makeFixture();
		const loaded = await Settings.loadIsolated(fixture);

		expect(loaded.getSource(SETTING_PATH)).toBe("default");
		expect(loaded.get(SETTING_PATH)).toBe(false);
	});

	/** A value persisted in the profile config is the only normal /settings-owned layer. */
	it("reports the exact profile source and effective profile value", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, true);
		const loaded = await Settings.loadIsolated(fixture);

		expect(loaded.getSource(SETTING_PATH)).toBe("profile");
		expect(loaded.get(SETTING_PATH)).toBe(true);
	});

	/**
	 * A repository's `<cwd>/.veyyon/config.yml` used to shadow the profile at a
	 * "project" source. That layer is gone: the file must produce NO source and
	 * NO value, so the profile's ownership and value stand untouched.
	 */
	it("ignores a repository config file: the profile source and value stand", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, true);
		writeProject(fixture, false);
		const loaded = await Settings.loadIsolated(fixture);

		expect(loaded.getSource(SETTING_PATH)).toBe("profile");
		expect(loaded.get(SETTING_PATH)).toBe(true);
	});

	/** The same file with no profile beneath it must leave the DEFAULT in charge. */
	it("ignores a repository config file with nothing beneath it: the default stands", async () => {
		const fixture = makeFixture();
		writeProject(fixture, true);
		const loaded = await Settings.loadIsolated(fixture);

		expect(loaded.getSource(SETTING_PATH)).toBe("default");
		expect(loaded.get(SETTING_PATH)).toBe(false);
	});

	/** An explicit --config overlay is distinguishable from automatic project discovery. */
	it("reports the exact config-file source and effective overlay value", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, false);
		writeProject(fixture, false);
		const overlay = path.join(fixture.cwd, "command-config.yml");
		writeSetting(overlay, true);
		const loaded = await Settings.loadIsolated({ ...fixture, configFiles: [overlay] });

		expect(loaded.getSource(SETTING_PATH)).toBe("config-file");
		expect(loaded.get(SETTING_PATH)).toBe(true);
	});

	/** Runtime overrides are the final layer and must retain provenance when they equal a lower value. */
	it("reports the exact runtime source and effective override value", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, true);
		const loaded = await Settings.loadIsolated({ ...fixture, overrides: { [SETTING_PATH]: true } });

		expect(loaded.getSource(SETTING_PATH)).toBe("runtime");
		expect(loaded.get(SETTING_PATH)).toBe(true);
	});
});

describe("Settings selector source ownership", () => {
	/**
	 * A repository config file must produce NO shadow. This row used to render
	 * "project config · false" and refuse Enter; with the project layer gone the
	 * same file is invisible, so the row keeps the profile's value, stays an	 * editable profile toggle, and Enter writes the profile exactly as though the
	 * repository file did not exist. Reintroducing the project layer turns this
	 * red: the render would show the repository's `true` instead of `false`.
	 */
	it("ignores a repository config file: the row stays a profile toggle", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, false);
		writeProject(fixture, true);
		await Settings.init(fixture);
		geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
		const changes: Array<[string, unknown]> = [];
		const component = createSelector(fixture.cwd, changes);

		const rendered = component.render(120).map(stripVTControlCharacters).join("\n");
		expect(rendered).toMatch(/Auto-Promote Context\s+‹ false ›/);
		expect(rendered).not.toContain("project config");
		expect(rendered).not.toContain("read-only");
		component.handleInput("\n");
		await Settings.instance.flush();

		expect(Settings.instance.getSource(SETTING_PATH)).toBe("profile");
		expect(Settings.instance.get(SETTING_PATH)).toBe(true);
		expect(readProfileValue(fixture)).toBe(true);
		expect(changes).toEqual([[SETTING_PATH, true]]);
	});

	/** A mouse activation must obey the same runtime-ownership guard as keyboard activation. */
	it("names a runtime-shadowed boolean and refuses click without a lower-layer change", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, true);
		await Settings.init({ ...fixture, overrides: { [SETTING_PATH]: true } });
		geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
		const changes: Array<[string, unknown]> = [];
		const component = createSelector(fixture.cwd, changes);

		component.handleInput("\x1b[C");
		const frame = component.render(120);
		const rendered = frame.map(stripVTControlCharacters).join("\n");
		expect(rendered).toMatch(/Auto-Promote Context\s+runtime override · true/);
		expect(rendered).toContain("Effective value comes from runtime override; this");
		expect(rendered).toContain("profile control is read-only.");
		component.handleInput(leftClick(frame, SETTING_LABEL));
		await Settings.instance.flush();

		expect(Settings.instance.getSource(SETTING_PATH)).toBe("runtime");
		expect(Settings.instance.get(SETTING_PATH)).toBe(true);
		expect(readProfileValue(fixture)).toBe(true);
		expect(changes).toEqual([]);
	});

	/** Profile ownership is the positive control: the same row remains a real editable toggle. */
	it("keeps a profile-owned boolean editable", async () => {
		const fixture = makeFixture();
		writeProfile(fixture, false);
		await Settings.init(fixture);
		geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
		const changes: Array<[string, unknown]> = [];
		const component = createSelector(fixture.cwd, changes);

		const rendered = component.render(120).map(stripVTControlCharacters).join("\n");
		expect(rendered).not.toContain("this profile control is read-only");
		component.handleInput("\n");
		await Settings.instance.flush();

		expect(Settings.instance.getSource(SETTING_PATH)).toBe("profile");
		expect(Settings.instance.get(SETTING_PATH)).toBe(true);
		expect(readProfileValue(fixture)).toBe(true);
		expect(changes).toEqual([[SETTING_PATH, true]]);
	});
});
