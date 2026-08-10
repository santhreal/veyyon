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
 * A feature master: a boolean that ships off, carrying a row of its own so the
 * operator can turn it on.
 *
 * `<prefix>.enabled` is the usual spelling and it is deliberately not what
 * qualifies a key here. `dev.autoqa` gates `dev.autoqaPush.*` with no `.enabled`
 * anywhere in it, and a suite that recognised masters by suffix would hold 11
 * features and quietly skip the twelfth, which is the same shape of gap the whole
 * suite exists to close.
 */
function offByDefaultMasters(): SettingPath[] {
	return optionalBooleans()
		.filter(key => getUi(key) !== undefined)
		.sort();
}

/**
 * The visible knobs that live under a master and are not the master itself.
 *
 * The stem is the master minus a trailing `.enabled`, and a key is under it when
 * the stem is followed by a dot or by a capital, so both `lsp.lazy` under
 * `lsp.enabled` and `dev.autoqaPush.endpoint` under `dev.autoqa` are found.
 */
function dependentsOf(master: SettingPath): SettingPath[] {
	const stem = master.endsWith(".enabled") ? master.slice(0, -".enabled".length) : master;
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[])
		.filter(key => key !== master && getUi(key) !== undefined)
		.filter(key => {
			if (!key.startsWith(stem) || key.length <= stem.length) return false;
			const next = key[stem.length];
			return next === "." || next === next?.toUpperCase();
		})
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

/**
 * The gates that are not booleans, with the value that turns the feature off and
 * the value that turns it on.
 *
 * Three features are chosen rather than switched on: the memory backend is one of
 * four names, and the two session budgets are amounts where zero means unmetered.
 * Their knobs cannot be reached by setting booleans, so a run that only flipped
 * booleans would report them as hidden-forever knobs and be wrong about it. The
 * table is small and named on purpose: a new non-boolean gate turns the on-state
 * case red, and the fix is a row here, which is a decision someone makes rather
 * than a class of gate the suite silently stops covering.
 */
const FEATURE_GATES: { key: SettingPath; off: string | number; on: string | number }[] = [
	{ key: "memory.backend" as SettingPath, off: "off", on: "mnemopi" },
	{ key: "session.cpuLimitCores" as SettingPath, off: 0, on: 1 },
	{ key: "session.writeBudgetGb" as SettingPath, off: 0, on: 1 },
];

/** Put every optional feature, boolean or not, in the same state. */
function turnEveryFeature(on: boolean): void {
	for (const key of optionalBooleans()) {
		Settings.instance.override(key, on);
		touched.add(key);
	}
	for (const gate of FEATURE_GATES) {
		Settings.instance.override(gate.key, on ? gate.on : gate.off);
		touched.add(gate.key);
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
		const pairs = gatedKnobs();
		expect(offByDefaultMasters().length).toBeGreaterThanOrEqual(69);
		expect(new Set(pairs.map(({ master }) => master)).size).toBeGreaterThanOrEqual(12);
		expect(pairs.length).toBeGreaterThanOrEqual(31);
		expect(offByDefaultMasters()).toEqual(
			expect.arrayContaining(["lsp.enabled", "browser.enabled", "github.enabled", "secrets.enabled", "dev.autoqa"]),
		);
		// The one master that carries no `.enabled`, so its knobs are found by stem.
		expect(dependentsOf("dev.autoqa" as SettingPath)).toEqual(
			expect.arrayContaining(["dev.autoqaPush.enabled", "dev.autoqaPush.endpoint"]),
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
		turnEveryFeature(false);
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
		turnEveryFeature(true);
		expect(Settings.instance.get("lsp.enabled")).toBe(true);
		expect(Settings.instance.get("memory.backend")).toBe("mnemopi");

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
		turnEveryFeature(false);

		const unreachable = offByDefaultMasters()
			.filter(master => getUi(master)?.condition === undefined)
			.filter(master => !isVisible(master));

		expect(unreachable, "these masters hide while off, so nothing on the screen can turn them on").toEqual([]);
	});
});
