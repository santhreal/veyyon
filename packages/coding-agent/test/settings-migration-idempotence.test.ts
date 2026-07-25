import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ASK_TIMEOUT_SECONDS, Settings } from "@veyyon/coding-agent/config/settings";
import { logger, removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * Schema migrations run on EVERY read, so each one has to be a fixed point.
 *
 * `#migrateRawSettings` is not a one-time upgrade step. It runs whenever the
 * config is loaded, and the save path re-reads and re-migrates before writing.
 * That design is fine, and deliberately so, but it rests on a property nothing
 * checked: applying a migration to its own output must change nothing. A
 * migration that is not a fixed point does not corrupt a setting once, it
 * corrupts it a little more on every launch.
 *
 * The renames and deletions here are all naturally idempotent, because they key
 * off a shape that no longer exists after they run. The value-magnitude ones are
 * the dangerous kind, and the suite exists to make a future one fail here rather
 * than in a user's config.
 *
 * Each case loads the file twice and compares. Loading is the operation the
 * property is about; asserting on a helper in isolation would not prove that the
 * loader actually reaches it.
 */
describe("settings migrations are fixed points", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-settings-migration-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-migration-idempotence"));
			agentDir = "";
		}
	});

	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	/** Load the config and read back one setting path. */
	async function loadValue(settingPath: string): Promise<unknown> {
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		return settings.get(settingPath as never);
	}

	/**
	 * Load, write the migrated result back out, then load again. This is what a
	 * user launching veyyon twice does, and it is the only way a non-idempotent
	 * migration actually causes damage.
	 */
	async function loadTwice(settingPath: string): Promise<{ first: unknown; second: unknown }> {
		const first = await loadValue(settingPath);
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		// Touch an unrelated setting so the save path re-reads, re-migrates, and
		// rewrites the file the way a real session does.
		await settings.set("ask.notify" as never, "on" as never);
		await settings.flush?.();
		const second = await loadValue(settingPath);
		return { first, second };
	}

	/**
	 * The value-magnitude migration, and the reason the suite exists. An old
	 * millisecond value converts once and must then stay put, or every launch
	 * would divide it again until the timeout reached zero.
	 */
	test("converts a millisecond ask.timeout once and leaves it alone after that", async () => {
		writeConfig({ ask: { timeout: 30000 } });

		const { first, second } = await loadTwice("ask.timeout");

		expect(first).toBe(30);
		expect(second).toBe(30);
	});

	/**
	 * A value already in seconds must not be touched at all. This is the case
	 * every current user is in, so a migration that fired here would silently
	 * shorten a timeout that was correct.
	 */
	test("leaves an ask.timeout already in seconds untouched", async () => {
		writeConfig({ ask: { timeout: 120 } });

		const { first, second } = await loadTwice("ask.timeout");

		expect(first).toBe(120);
		expect(second).toBe(120);
	});

	/**
	 * The boundary is exact. A value equal to the threshold is seconds; one above
	 * it is milliseconds. An off-by-one here silently rewrites a setting that sits
	 * right on the line.
	 */
	test("treats the threshold value itself as seconds", async () => {
		writeConfig({ ask: { timeout: MAX_ASK_TIMEOUT_SECONDS } });

		expect(await loadValue("ask.timeout")).toBe(MAX_ASK_TIMEOUT_SECONDS);
	});

	/**
	 * And the first value above it is converted. Without this twin the suite would
	 * pass against a migration that had been removed entirely, which would leave
	 * every millisecond-era config with a wildly long timeout.
	 */
	test("converts the first value above the threshold", async () => {
		writeConfig({ ask: { timeout: MAX_ASK_TIMEOUT_SECONDS + 1 } });

		expect(await loadValue("ask.timeout")).toBe(Math.round((MAX_ASK_TIMEOUT_SECONDS + 1) / 1000));
	});

	/**
	 * A rename must survive a second load. `queueMode` is deleted once it has been
	 * copied across, so the second pass finds nothing to do; if it did, the
	 * renamed key would be overwritten by a stale one on every launch.
	 */
	test("renames queueMode to steeringMode once", async () => {
		writeConfig({ queueMode: "steer" });

		const { first, second } = await loadTwice("steeringMode");

		expect(first).toBe("steer");
		expect(second).toBe("steer");
	});

	/**
	 * A boolean-to-enum migration must not re-fire on the enum it produced, and
	 * the key it lands on moved too: `task.eager` (boolean, then a three-value
	 * enum) is now `subagent.delegation`, whose scale adds `off` at the bottom.
	 * The legacy `true` meant the strongest push, which is `required`.
	 */
	test("maps a boolean task.eager onto subagent.delegation once", async () => {
		writeConfig({ task: { eager: true } });

		const { first, second } = await loadTwice("subagent.delegation");

		expect(first).toBe("required");
		expect(second).toBe("required");
	});

	/**
	 * The middle of that scale keeps its meaning across the move, so an operator
	 * who asked for "preferred" does not get promoted to a first-turn reminder.
	 */
	test("maps the enum form of task.eager onto the matching delegation strength", async () => {
		writeConfig({ task: { eager: "preferred" } });

		const { first, second } = await loadTwice("subagent.delegation");

		expect(first).toBe("preferred");
		expect(second).toBe("preferred");
	});

	/**
	 * A value-remap must not remap its own output. `rcopy` is deliberately absent
	 * from the legacy table, so re-running it is a no-op; a table that mapped a
	 * new name back to another would loop a user's setting forever.
	 */
	test("maps a legacy isolation mode once", async () => {
		writeConfig({ task: { isolation: { mode: "worktree" } } });

		const { first, second } = await loadTwice("subagent.isolation.mode");

		expect(first).toBe("rcopy");
		expect(second).toBe("rcopy");
	});

	/**
	 * The boolean-to-enum isolation migration, which both renames the key and
	 * changes its type. Two shapes changing at once is where a migration is most
	 * likely to be written non-idempotently.
	 */
	test("maps task.isolation.enabled to a mode once", async () => {
		writeConfig({ task: { isolation: { enabled: true } } });

		const { first, second } = await loadTwice("subagent.isolation.mode");

		expect(first).toBe("auto");
		expect(second).toBe("auto");
	});

	/**
	 * A removed edit mode maps forward and stays. `hashline` is not in the removed
	 * set, so the second pass does nothing.
	 */
	test("maps a removed edit mode once", async () => {
		writeConfig({ edit: { mode: "vim" } });

		const { first, second } = await loadTwice("edit.mode");

		expect(first).toBe("hashline");
		expect(second).toBe("hashline");
	});

	/**
	 * A legacy compaction strategy maps forward and stays put.
	 */
	test("maps a legacy compaction strategy once", async () => {
		writeConfig({ compaction: { strategy: "shake-summary" } });

		const { first, second } = await loadTwice("compaction.strategy");

		expect(first).toBe("handoff");
		expect(second).toBe("handoff");
	});

	/**
	 * `off` is the one strategy that carries a second effect: it becomes `handoff`
	 * AND disables compaction. Both halves must survive the second pass, or a user
	 * who had compaction off would find it back on after one relaunch.
	 */
	test("keeps compaction disabled after migrating the off strategy", async () => {
		writeConfig({ compaction: { strategy: "off" } });

		const strategy = await loadTwice("compaction.strategy");
		expect(strategy.first).toBe("handoff");
		expect(strategy.second).toBe("handoff");
		expect(await loadValue("compaction.enabled")).toBe(false);
	});

	/**
	 * A theme given as a bare string becomes a nested object once. The second pass
	 * sees an object, not a string, and leaves it alone.
	 */
	test("nests a bare custom theme string once", async () => {
		writeConfig({ theme: "some-custom-dark-theme" });

		const { first, second } = await loadTwice("theme.dark");

		expect(first).toBe("some-custom-dark-theme");
		expect(second).toBe("some-custom-dark-theme");
	});

	/**
	 * The one case the magnitude guess gets wrong is a user who genuinely wanted a
	 * wait longer than the threshold. Their setting is rewritten to something
	 * three orders of magnitude smaller, and without a word about it they would
	 * only discover it by watching an ask auto-select in two seconds. Reporting it
	 * is the whole difference between a documented trade-off and a silent one.
	 */
	test("says so when it rewrites a value the user may have meant as seconds", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			writeConfig({ ask: { timeout: 2000 } });

			await loadValue("ask.timeout");

			const reported = warnSpy.mock.calls.find(([message]) => String(message).includes("ask.timeout"));
			expect(reported).toBeDefined();
			// Both values, so the user can tell what they set from what they got.
			expect(String(reported?.[0])).toContain("2000");
			expect(String(reported?.[0])).toContain("2 seconds");
		} finally {
			warnSpy.mockRestore();
		}
	});

	/**
	 * And it stays quiet for the value it does not touch, or every launch of every
	 * ordinary config would print a warning about a setting that is correct.
	 */
	test("says nothing when the value is already in seconds", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			writeConfig({ ask: { timeout: 120 } });

			await loadValue("ask.timeout");

			expect(warnSpy.mock.calls.filter(([message]) => String(message).includes("ask.timeout"))).toHaveLength(0);
		} finally {
			warnSpy.mockRestore();
		}
	});

	/**
	 * A key veyyon has never heard of must come through every migration and every
	 * save untouched. It is how a config written by a newer build survives a
	 * downgrade, and a migration that rebuilt the object instead of editing it
	 * would drop it silently.
	 */
	test("carries an unknown key through migration and save", async () => {
		writeConfig({ queueMode: "steer", somethingFromTheFuture: { nested: [1, 2, 3] } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		await settings.set("ask.notify" as never, "off" as never);
		await settings.flush?.();

		const onDisk = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		expect(onDisk.somethingFromTheFuture).toEqual({ nested: [1, 2, 3] });
	});
});
