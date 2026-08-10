/**
 * A feature that ships off does not show its dependent knobs.
 *
 * WHY THIS SUITE EXISTS. The rule is written down (AGENTS.md: "An experimental
 * feature that is off hides its dependent knobs completely"), the mechanism
 * exists (`ui.condition` naming a predicate in `CONDITIONS`), and four features
 * did not use it. `lsp.enabled`, `browser.enabled`, `github.enabled` and
 * `secrets.enabled` all default to false, and between them 13 knobs rendered on
 * a fresh install: lazy language-server startup and three diagnostics rules for
 * a session with no server, headless and cmux and a screenshot directory for a
 * Chromium nothing launches, a view cache with two TTLs for an unavailable tool,
 * and a secret lifetime and audit log with no vault behind them. Each one reads
 * as a feature that is on and broken rather than a feature that is off.
 *
 * WHY IT IS DERIVED AND NOT A LIST. Every existing settings suite names paths
 * one at a time, which is why 13 knobs nobody thought to name stayed visible.
 * The masters and their dependents are enumerated from `SETTINGS_SCHEMA` at run
 * time, so a new off-by-default feature with an unconditioned knob is red on
 * arrival rather than the fourteenth instance of the same omission.
 *
 * WHY BOTH STATES. A condition that always answers false hides the knob forever,
 * which passes an off-state check and is its own defect: the operator turns the
 * feature on and the knobs never appear. So the off state and the on state are
 * both asserted, and the visibility question is resolved through the SAME
 * `pathToSettingDef` path the settings screen uses, which means an unresolved
 * condition name (the failure mode that left `providers.unexpectedStopModel`
 * rendering unconditionally) reads as visible here and fails the off state.
 *
 * WHAT IT DOES NOT CATCH. Nothing about layout: a knob whose condition is right
 * can still sit under a heading that reads badly, and this suite cannot see
 * that. It also does not judge whether a feature SHOULD ship off; it only holds
 * the ones that do to hiding their own knobs.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	getDefault,
	getType,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@veyyon/coding-agent/config/settings-schema";
import { getSettingDef } from "@veyyon/coding-agent/modes/components/settings-defs";

/** Every boolean setting that ships off, whether or not it is a feature master. */
function optionalBooleans(): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
		key => getType(key) === "boolean" && getDefault(key) === false,
	);
}

/**
 * A feature master: `<prefix>.enabled`, boolean, off by default, with a row of its
 * own so the operator can turn it on.
 */
function offByDefaultMasters(): SettingPath[] {
	return optionalBooleans()
		.filter(key => key.endsWith(".enabled") && getUi(key) !== undefined)
		.sort();
}

/** The visible knobs that live under a master and are not the master itself. */
function dependentsOf(master: SettingPath): SettingPath[] {
	const prefix = `${master.slice(0, -".enabled".length)}.`;
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[])
		.filter(key => key !== master && key.startsWith(prefix) && getUi(key) !== undefined)
		.sort();
}

function gatedKnobs(): { master: SettingPath; dependent: SettingPath }[] {
	return offByDefaultMasters().flatMap(master => dependentsOf(master).map(dependent => ({ master, dependent })));
}

/**
 * Whether the settings screen would render the row right now.
 *
 * Resolved through the adapter rather than by reading `ui.condition`, because the
 * name is only half the mechanism: an unknown name resolves to no predicate and
 * the row renders unconditionally.
 */
function isVisible(key: SettingPath): boolean {
	const def = getSettingDef(key);
	if (!def) return false;
	return def.condition === undefined || def.condition() === true;
}

const touched = new Set<SettingPath>();

function setEveryOptionalBoolean(value: boolean): void {
	for (const key of optionalBooleans()) {
		Settings.instance.override(key, value);
		touched.add(key);
	}
}

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-off-feature-"));
	await Settings.init({ cwd: dir, agentDir: dir });
});

afterAll(() => {
	for (const key of touched) Settings.instance.clearOverride(key);
});

describe("a feature that ships off hides its knobs", () => {
	/**
	 * NON-VACUITY. Every assertion below walks a derived set, and an empty set
	 * satisfies all of them. These are the numbers as measured, as floors.
	 */
	it("finds the masters and the knobs that hang off them", () => {
		expect(offByDefaultMasters().length).toBeGreaterThanOrEqual(19);
		expect(gatedKnobs().length).toBeGreaterThanOrEqual(25);
		expect(offByDefaultMasters()).toEqual(
			expect.arrayContaining(["lsp.enabled", "browser.enabled", "github.enabled", "secrets.enabled"]),
		);
	});

	/**
	 * THE DECLARATION. A knob under an off-by-default master names a predicate.
	 * Structural, so it fails at the moment a knob is added rather than when
	 * someone opens the screen and wonders what the row is for.
	 */
	it("declares a condition on every knob under an off-by-default master", () => {
		const unconditioned = gatedKnobs()
			.filter(({ dependent }) => getUi(dependent)?.condition === undefined)
			.map(({ master, dependent }) => `${dependent} (under ${master})`);

		expect(
			unconditioned,
			"each of these renders while its feature is off; add a ui.condition naming a predicate in CONDITIONS (settings-defs.ts)",
		).toEqual([]);
	});

	/**
	 * THE OFF STATE. With every optional feature off, which is what a fresh
	 * install is, not one of those knobs is on the screen.
	 */
	it("shows no dependent knob while every optional feature is off", () => {
		setEveryOptionalBoolean(false);
		expect(Settings.instance.get("lsp.enabled")).toBe(false);

		const stillVisible = gatedKnobs()
			.filter(({ dependent }) => isVisible(dependent))
			.map(({ master, dependent }) => `${dependent} (under ${master})`);

		expect(stillVisible, "these are visible while the feature they belong to is off").toEqual([]);
	});

	/**
	 * THE ON STATE. And with every optional feature on, every knob is back, and so
	 * is every master. This is what stops the off state from being satisfied by a
	 * predicate that answers false forever, or by a condition name that resolves to
	 * nothing and was never wired.
	 */
	it("shows every knob and every master once its feature is on", () => {
		setEveryOptionalBoolean(true);
		expect(Settings.instance.get("lsp.enabled")).toBe(true);

		const stillHidden = [
			...gatedKnobs().map(({ master, dependent }) => ({ key: dependent, under: master })),
			...offByDefaultMasters().map(master => ({ key: master, under: "its own feature" })),
		]
			.filter(({ key }) => !isVisible(key))
			.map(({ key, under }) => `${key} (under ${under})`);

		expect(stillHidden, "these stay hidden with their feature on, so their condition can never be satisfied").toEqual(
			[],
		);
	});

	/**
	 * AND AN UNCONDITIONED MASTER IS ALWAYS REACHABLE. Hiding a master behind its
	 * own feature is the one arrangement that cannot be recovered from: the screen
	 * offers no way to turn on the thing that would reveal the switch.
	 *
	 * A master that declares a condition is exempt, because it is a dependent as
	 * well as a master and its own governing feature is off. `dev.autoqaPush.enabled`
	 * is the live case: the upload switch sits under Auto QA, and there is nothing to
	 * upload until Auto QA runs. The on-state case above is what keeps that exemption
	 * honest, since a conditioned master still has to come back.
	 */
	it("keeps every unconditioned master visible while its own feature is off", () => {
		setEveryOptionalBoolean(false);

		const unreachable = offByDefaultMasters()
			.filter(master => getUi(master)?.condition === undefined)
			.filter(master => !isVisible(master));

		expect(unreachable, "these masters hide while off, so nothing on the screen can turn them on").toEqual([]);
	});
});
