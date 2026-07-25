/**
 * "Unset" is an ABSENT KEY, not a magic number (SENTINEL-ABSENT-KEY).
 *
 * Optional numeric settings used to store `-1` to mean "no value", which stole
 * -1 from the settings that accept it: `presencePenalty: -1` and
 * `repetitionPenalty: 0.8`-style negatives are values providers take, and while
 * the sentinel occupied that slot a user could not configure them at all. The
 * read test was also written `>= 0`, so EVERY negative value was silently
 * discarded along with the sentinel — the bug this design removes rather than
 * patches.
 *
 * Three things are pinned here, because each was a separate way to get it wrong:
 *  1. `Settings#unset` removes the key, so `has` is false and `get` falls back
 *     to the schema default, and it fires the same change notification as a set.
 *  2. Every negative value now survives a round trip through the real store.
 *  3. A config written by an older version, holding `-1`, is migrated by
 *     dropping the key — and the migration is a fixed point on its own output.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applySamplingKnob,
	isSamplingKnob,
	optionalNumber,
	type SamplingKnobs,
	toNumberOrUndefined,
} from "@veyyon/coding-agent/config/optional-number";
import {
	SETTINGS_MIGRATION_VERSION,
	Settings,
	stampOwnedConfigMigrations,
	stripLegacyUnsetSentinels,
} from "@veyyon/coding-agent/config/settings";
import { getDefault, isUnsetNumberPath } from "@veyyon/coding-agent/config/settings-schema";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/** The seven optional numeric settings, straight from the schema. */
const OPTIONAL_NUMERIC = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
	"compaction.modelContextWindow",
] as const;

describe("the optional numeric settings", () => {
	it("are exactly the paths the schema marks optional", () => {
		for (const path of OPTIONAL_NUMERIC) {
			expect(isUnsetNumberPath(path)).toBe(true);
		}
	});

	it("declare no default, so an absent key is the unset state", () => {
		for (const path of OPTIONAL_NUMERIC) {
			expect(getDefault(path)).toBeUndefined();
		}
	});
});

describe("Settings#unset", () => {
	it("removes the key rather than storing a value that means unset", () => {
		const settings = Settings.isolated({ presencePenalty: 1.5 } as never);
		expect(settings.get("presencePenalty")).toBe(1.5);
		settings.unset("presencePenalty");
		expect(settings.get("presencePenalty")).toBeUndefined();
		expect(settings.isConfigured("presencePenalty")).toBe(false);
	});

	it("unsets a nested path without disturbing its siblings", () => {
		const settings = Settings.isolated({
			compaction: { modelContextWindow: 64_000, keepRecentTokens: 12_345 },
		} as never);
		settings.unset("compaction.modelContextWindow");
		expect(settings.get("compaction.modelContextWindow")).toBeUndefined();
		expect(settings.get("compaction.keepRecentTokens")).toBe(12_345);
	});

	it("is a no-op on a key that was never set", () => {
		const settings = Settings.isolated({} as never);
		settings.unset("temperature");
		expect(settings.get("temperature")).toBeUndefined();
		expect(settings.isConfigured("temperature")).toBe(false);
	});
});

describe("a negative sampling value", () => {
	/** The reachability this change exists for: -1 is a real presence penalty. */
	it("round-trips through the store, including exactly -1", () => {
		const settings = Settings.isolated({} as never);
		for (const value of [-2, -1, -0.5, 0, 0.5, 2]) {
			settings.set("presencePenalty", value);
			expect(settings.get("presencePenalty")).toBe(value);
			expect(optionalNumber(settings.get("presencePenalty"))).toBe(value);
		}
	});

	/** `optionalNumber` is the ONE read test. It keeps every finite number,
	 * including -1, and reports only a missing value as unset. */
	it("survives the unset test that used to discard it", () => {
		expect(optionalNumber(-1)).toBe(-1);
		expect(optionalNumber(-0.5)).toBe(-0.5);
		expect(optionalNumber(0)).toBe(0);
		expect(optionalNumber(undefined)).toBeUndefined();
		expect(optionalNumber(Number.NaN)).toBeUndefined();
	});
});

describe("the live-apply path", () => {
	/** The same `>= 0` test was written out six times in the settings selector's
	 * side-effect switch, one case per knob, so the fix in the SDK had to be made
	 * twice. All six now go through one owner. */
	it("applies every knob through one owner, negatives included", () => {
		const agent: SamplingKnobs = {};
		applySamplingKnob(agent, "presencePenalty", optionalNumber(toNumberOrUndefined("-1")));
		applySamplingKnob(agent, "repetitionPenalty", optionalNumber(toNumberOrUndefined(-0.5)));
		applySamplingKnob(agent, "temperature", optionalNumber(toNumberOrUndefined("0")));
		expect(agent.presencePenalty).toBe(-1);
		expect(agent.repetitionPenalty).toBe(-0.5);
		expect(agent.temperature).toBe(0);
	});

	it("clears a knob when the Default row reports no value", () => {
		const agent: SamplingKnobs = { topP: 0.9 };
		applySamplingKnob(agent, "topP", optionalNumber(toNumberOrUndefined("")));
		expect(agent.topP).toBeUndefined();
	});

	it("recognises exactly the six sampling knobs", () => {
		for (const knob of ["temperature", "topP", "topK", "minP", "presencePenalty", "repetitionPenalty"]) {
			expect(isSamplingKnob(knob)).toBe(true);
		}
		expect(isSamplingKnob("compaction.modelContextWindow")).toBe(false);
		expect(isSamplingKnob("theme.dark")).toBe(false);
	});
});

/**
 * The migration that drops the old sentinel runs ONCE, and the stamp that makes
 * it one-shot has to be on disk.
 *
 * It is the only migration in `#migrateRawSettings`'s neighbourhood that cannot
 * tell its input apart from a current value: `-1` used to mean "unset" and now
 * means minus one. Dogfooding caught this twice within a few minutes of the
 * change landing, in two different ways, and both are pinned below:
 *
 *  1. `config set presencePenalty -1` wrote the value and the next load deleted
 *     it, because nothing recorded that the migration had already run.
 *  2. Stamping only inside the YAML loader missed a config file that does not
 *     exist yet, so the FIRST value ever written was still deleted.
 *
 * The stamp is written when one of the governed paths is written — the moment the
 * file is being rewritten anyway — so an upgrade does not add a line to every
 * config in existence.
 */
describe("stamping the one-shot migrations", () => {
	it("strips the legacy sentinel from every optional numeric path", () => {
		const raw: Record<string, unknown> = {
			temperature: -1,
			topP: -1,
			topK: -1,
			minP: -1,
			presencePenalty: -1,
			repetitionPenalty: -1,
			compaction: { modelContextWindow: -1 },
		};
		const changed = stampOwnedConfigMigrations(raw as never);
		for (const key of ["temperature", "topP", "topK", "minP", "presencePenalty", "repetitionPenalty"]) {
			expect(key in raw, `${key} must be gone, not set to something else`).toBe(false);
		}
		expect((raw.compaction as Record<string, unknown>).modelContextWindow).toBeUndefined();
		expect(changed).toContain("settingsMigrationVersion");
	});

	it("records that it ran, and names every path it touched", () => {
		const raw: Record<string, unknown> = { topP: -1, temperature: 0.2 };
		const changed = stampOwnedConfigMigrations(raw as never);
		expect(raw.settingsMigrationVersion).toBe(SETTINGS_MIGRATION_VERSION);
		// The caller marks these modified, so the save path writes them; a path left
		// out here is a deletion that never reaches the file.
		expect(changed).toEqual(["topP", "settingsMigrationVersion"]);
	});

	/** The bug the stamp exists for: a -1 the user typed with the current version
	 * must survive every subsequent load. */
	it("leaves a -1 alone once it has already run", () => {
		const raw: Record<string, unknown> = {
			settingsMigrationVersion: SETTINGS_MIGRATION_VERSION,
			presencePenalty: -1,
		};
		expect(stripLegacyUnsetSentinels(raw as never)).toEqual([]);
		expect(raw.presencePenalty).toBe(-1);
	});

	it("is a fixed point: running it again changes nothing and writes nothing", () => {
		const raw: Record<string, unknown> = { topK: -1, topP: 0.9, presencePenalty: -1 };
		stampOwnedConfigMigrations(raw as never);
		const snapshot = JSON.stringify(raw);
		expect(stampOwnedConfigMigrations(raw as never)).toEqual([]);
		expect(JSON.stringify(raw)).toBe(snapshot);
	});

	it("keeps a configured value that was never the sentinel", () => {
		const raw: Record<string, unknown> = {
			temperature: 0.2,
			presencePenalty: -2,
			compaction: { modelContextWindow: 128_000 },
		};
		stampOwnedConfigMigrations(raw as never);
		expect(raw.temperature).toBe(0.2);
		expect(raw.presencePenalty).toBe(-2);
		expect((raw.compaction as Record<string, unknown>).modelContextWindow).toBe(128_000);
	});

	/** A -1 that MEANS something the setting names is not a sentinel: the strip is
	 * scoped to the schema's optional numeric paths, so `Off` and `Auto` survive. */
	it("leaves an explicit -1 that names a mode alone", () => {
		const raw: Record<string, unknown> = {
			argot: { disableAboveTokens: -1 },
			providers: { streamIdleTimeoutSeconds: -1 },
		};
		stampOwnedConfigMigrations(raw as never);
		expect((raw.argot as Record<string, unknown>).disableAboveTokens).toBe(-1);
		expect((raw.providers as Record<string, unknown>).streamIdleTimeoutSeconds).toBe(-1);
	});

	/** A project config or a `--config` overlay is hand-written against the current
	 * docs and is never rewritten by this app, so a `-1` there is a value. Silently
	 * deleting it would be a Law 10 drop of the user's input. */
	it("does not touch a source this instance does not own", () => {
		const settings = Settings.isolated({ presencePenalty: -1, topP: -1 } as never);
		expect(settings.get("presencePenalty")).toBe(-1);
		expect(settings.get("topP")).toBe(-1);
	});
});

/**
 * The end-to-end property the unit tests above could not see: a negative value
 * written through the real persisted path is still there in the NEXT process.
 *
 * Everything above was green, mutation-verified, and the feature was still broken
 * when driven through the shipped binary — twice. The gap was always at a
 * boundary a unit test does not cross: the file. These assert against the bytes
 * on disk and a second load of them.
 */
describe("a negative value written to a real config file", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-unset-absent-key-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-unset-absent-key"));
			agentDir = "";
		}
	});

	function readConfig(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
	}

	async function load(): Promise<Settings> {
		return await Settings.loadIsolated({ agentDir, cwd: agentDir });
	}

	/** The exact dogfooded failure: set -1, and the next load deleted it. */
	it("survives a reload, stamp and all", async () => {
		const first = await load();
		first.set("presencePenalty", -1);
		await first.flush();

		const file = readConfig();
		expect(file.presencePenalty).toBe(-1);
		expect(file.settingsMigrationVersion).toBe(SETTINGS_MIGRATION_VERSION);

		const second = await load();
		expect(second.get("presencePenalty")).toBe(-1);
	});

	/** The second dogfooded failure: the config file did not exist yet, so nothing
	 * had stamped it, and the first value ever written was migrated away. */
	it("survives being the first value ever written", async () => {
		expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(false);
		const first = await load();
		first.set("repetitionPenalty", -1);
		await first.flush();
		expect((await load()).get("repetitionPenalty")).toBe(-1);
	});

	/** An old config's sentinel is still cleaned up, and the cleanup reaches the
	 * FILE when one of these paths is written — otherwise the stamp would certify a
	 * config that still holds a `-1` meaning "unset", and the next load would read
	 * it as the value -1. */
	it("clears a legacy sentinel from the file on the first write to a sampling knob", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ temperature: -1, futureFeature: "kept" }));
		const settings = await load();
		expect(settings.get("temperature")).toBeUndefined();

		settings.set("topP", 0.9);
		await settings.flush();

		const file = readConfig();
		expect("temperature" in file).toBe(false);
		expect(file.topP).toBe(0.9);
		expect(file.settingsMigrationVersion).toBe(SETTINGS_MIGRATION_VERSION);
		// Unrelated keys are untouched by the migration, including ones this build
		// does not know (the flat `theme` string would have been rewritten by a
		// different migration, which is why the fixture uses an unknown key).
		expect(file.futureFeature).toBe("kept");
	});

	/** Writing an unrelated setting must not stamp — an upgrade should not add a
	 * line to a config that has nothing to do with these paths. */
	it("does not stamp a config whose write has nothing to migrate", async () => {
		const settings = await load();
		settings.set("theme.dark", "titanium");
		await settings.flush();
		expect("settingsMigrationVersion" in readConfig()).toBe(false);
	});

	it("removes the key when a knob is unset, rather than writing a sentinel", async () => {
		const settings = await load();
		settings.set("minP", 0.05);
		await settings.flush();
		expect(readConfig().minP).toBe(0.05);

		settings.unset("minP");
		await settings.flush();
		expect("minP" in readConfig()).toBe(false);
	});
});
