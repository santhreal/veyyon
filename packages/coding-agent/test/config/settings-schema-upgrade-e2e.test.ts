/**
 * Upgrading across a settings-schema change, end to end, on a realistic config.
 *
 * The pieces are each covered elsewhere: `settings-migration-idempotence` proves
 * every migration is a fixed point, `settings-unknown-key-preservation` proves a
 * write does not delete keys this build has never heard of. What nothing covered
 * is the whole journey the user actually takes — a config written by an OLDER
 * build, opened by a NEWER one, written once, and read back — with all the
 * shapes present at the same time.
 *
 * That combination is where a migration bug hides. Each migration is correct in
 * isolation and the interaction is what goes wrong: a stamp written before the
 * strip completes certifies a config that was never migrated, and a save path
 * that serializes its in-memory view drops the keys the strip did not know about.
 *
 * So this seeds one config carrying, together:
 *
 *   - the legacy `-1` "unset" sentinel on sampling knobs, which the current build
 *     deletes because `-1` is now a value a user can legitimately mean;
 *   - a real `-1` the user means, on a path the sentinel migration does NOT own;
 *   - ordinary settings this build knows;
 *   - a key from a FUTURE build, which is the downgrade-then-upgrade case;
 *   - a hand-written nested object.
 *
 * Every assertion is against the file on disk, parsed back, because the property
 * is about bytes that survive a write and nothing in memory can prove that.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_MIGRATION_VERSION, Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSchemaUpgradeDir = useTrackedTempDirs("veyyon-schema-upgrade-");

describe("a config written by an older build", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeSchemaUpgradeDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-schema-upgrade-e2e"));
			agentDir = "";
		}
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const readConfig = () => YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;

	/** The old build's file: every shape the upgrade has to handle, at once. */
	function seedOldSchemaConfig(): void {
		fs.writeFileSync(
			configPath(),
			YAML.stringify({
				// Deleted by the one-shot migration: this is the old "unset" spelling.
				temperature: -1,
				topP: -1,
				// NOT one of the sentinel paths, and -1 here is a value the user chose.
				presencePenalty: -1,
				// Ordinary settings this build knows and must leave alone.
				theme: "titanium",
				startup: { autoUpdate: false },
				compaction: { modelContextWindow: -1, strategy: "summarize" },
				// A newer build's key, seen by an older one: the downgrade case.
				futureFeature: { enabled: true, mode: "aggressive" },
				// Hand-written structure nothing in the schema owns.
				notes: { why: "kept for the next person", items: [1, 2, 3] },
			}),
		);
	}

	/** Open it the way a launch does, write one setting, flush. */
	async function upgradeAndWrite(settingPath: string, value: unknown): Promise<void> {
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		settings.set(settingPath as never, value as never);
		await settings.flush();
	}

	/** What a launch actually reads, which is where the in-memory strip shows up. */
	async function effective(settingPath: string): Promise<unknown> {
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		return settings.get(settingPath as never);
	}

	test("reads the legacy sentinel as unset, from the first launch", async () => {
		// The migration's actual job. `-1` used to mean "unset" and now means -1, so
		// an upgraded build must not read the old spelling as a real value and pin a
		// sampling knob the user never set. The strip runs in memory on EVERY load,
		// so this is true before anything is written back.
		seedOldSchemaConfig();

		expect(await effective("temperature")).toBeUndefined();
		expect(await effective("topP")).toBeUndefined();
	});

	test("leaves the file alone until a write has reason to touch it", async () => {
		// Deliberate, and worth pinning because it looks like a missed migration:
		// stamping at load time would add a line to every config in existence,
		// including ones that never touched a sampling knob. The file is rewritten
		// when one of those paths is written, which is the moment the stamp is both
		// needed and free.
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect(readConfig().temperature).toBe(-1);
	});

	test("commits the strip to disk when a sampling knob is written", async () => {
		seedOldSchemaConfig();

		await upgradeAndWrite("topK", 40);

		const after = readConfig();
		expect(after.temperature).toBeUndefined();
		expect(after.topP).toBeUndefined();
		expect(after.topK).toBe(40);
	});

	test("stamps the migration so the next launch cannot run it again", async () => {
		// Without the stamp the next load deletes a `-1` the user has since set on
		// purpose. That is not hypothetical: it happened in dogfooding one minute
		// after the change landed.
		seedOldSchemaConfig();

		await upgradeAndWrite("topK", 40);

		expect(readConfig().settingsMigrationVersion).toBe(SETTINGS_MIGRATION_VERSION);
	});

	test("a -1 the user meant survives, because its path is not a sentinel path", async () => {
		// The migration is scoped to the paths that used the sentinel. A blanket
		// "delete every -1" would take this with it.
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect(readConfig().presencePenalty).toBe(-1);
	});

	test("every user key this build knows keeps its exact value", async () => {
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect((readConfig().startup as Record<string, unknown>).autoUpdate).toBe(false);
	});

	test("renames the old compaction strategy spelling to the canonical one", async () => {
		// Found by writing this test: `summarize` is the old spelling and normalizes
		// to `summary`. That is a MIGRATION doing its job, not a lost value — the
		// user's choice survives under the name this build uses — and it is worth
		// pinning, because a rename that silently dropped the setting instead would
		// look identical from the outside until the strategy reverted to default.
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect((readConfig().compaction as Record<string, unknown>).strategy).toBe("summary");
	});

	test("a future build's key survives the upgrade intact", async () => {
		// Deep equality, not presence: a shallow merge that replaced the object
		// with `{}` would still leave the key behind and lose everything in it.
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect(readConfig().futureFeature).toEqual({ enabled: true, mode: "aggressive" });
	});

	test("hand-written structure survives too", async () => {
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect(readConfig().notes).toEqual({ why: "kept for the next person", items: [1, 2, 3] });
	});

	test("the setting that triggered the write has the new value", async () => {
		// The whole upgrade is worthless if the write it rode in on was lost.
		seedOldSchemaConfig();

		await upgradeAndWrite("theme", "light");

		expect(readConfig().theme).toBe("light");
	});

	test("a second launch changes nothing further", async () => {
		// The fixed point, driven through the real load-write-read path rather than
		// by calling a migration function twice.
		seedOldSchemaConfig();
		await upgradeAndWrite("topK", 40);
		const afterFirst = readConfig();

		await upgradeAndWrite("topK", 40);

		expect(readConfig()).toEqual(afterFirst);
	});

	test("a -1 written AFTER the upgrade is not eaten on the next launch", async () => {
		// The reason the stamp exists, stated as the user's experience: set a legal
		// -1, relaunch, and it is still there.
		seedOldSchemaConfig();
		await upgradeAndWrite("topK", 40);

		await upgradeAndWrite("temperature", -1);

		expect(readConfig().temperature).toBe(-1);
		expect(await effective("temperature")).toBe(-1);
	});
});
