/**
 * A setting that could not be written has to reach the user, not just the log.
 *
 * `#saveNow` used to swallow a write failure into `logger.warn("Settings: save failed")` and
 * re-queue the paths for retry. That is fine for a lost race with a concurrent writer, and
 * silently wrong for everything else: the in-memory value HAS changed, so the UI reports the
 * setting as changed, and the file on disk does not, so the setting reverts on the next
 * launch with nothing ever having told the user. On a read-only home, a full disk, or a
 * config path that became a directory, the retry never succeeds and the failure is invisible
 * for the whole session (Law 10).
 *
 * The failure is now counted, reported once the retries are spent, and cleared by the next
 * save that works. These tests drive real writes against real unwritable paths — a directory
 * standing where `config.yml` should be, and a config directory with the write bit off —
 * because a mocked filesystem cannot reproduce either, and they assert the REASON text and
 * the attempt count, not merely that something was reported.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, type SettingsSaveFailure } from "@veyyon/coding-agent/config/settings";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		// A read-only agent dir has to be made writable again or the rm fails.
		await fs.chmod(dir, 0o755).catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-save-failure-"));
	tempDirs.push(dir);
	return dir;
}

/** A settings instance whose config path cannot be written, and the failures it reports. */
async function unwritable(kind: "directory-in-the-way" | "read-only-parent"): Promise<{
	settings: Settings;
	agentDir: string;
	configPath: string;
	reported: SettingsSaveFailure[];
}> {
	const agentDir = await makeAgentDir();
	const configPath = path.join(agentDir, "config.yml");
	if (kind === "directory-in-the-way") {
		// A directory where the file belongs: every write fails, and this is a real shape
		// people hit (a stray `mkdir -p ~/.veyyon/.../config.yml` in a script).
		await fs.mkdir(configPath, { recursive: true });
	}
	// Loaded BEFORE the directory is sealed: `Settings` opens `agent.db` in the same
	// directory, so a read-only dir would fail the load rather than the save, and the test
	// would be about a different failure.
	const settings = await Settings.loadIsolated({ agentDir });
	if (kind === "read-only-parent") await fs.chmod(agentDir, 0o500);
	const reported: SettingsSaveFailure[] = [];
	settings.onSaveFailure(failure => reported.push(failure));
	return { settings, agentDir, configPath, reported };
}

/** Force a save attempt and wait for it to settle, tolerating the failure. */
async function attemptSave(settings: Settings, value: number): Promise<void> {
	settings.set("topP", value);
	await settings.flush().catch(() => {});
}

describe("a config path that cannot be written", () => {
	it("stays quiet for the first attempts, because one failure is a normal race", async () => {
		// Saves are debounced and retried. Reporting the first failure would fire on an
		// ordinary lost race with another process, which self-heals.
		const { settings } = await unwritable("directory-in-the-way");

		await attemptSave(settings, 0.1);
		expect(settings.saveFailure).toBeUndefined();
		await attemptSave(settings, 0.2);
		expect(settings.saveFailure).toBeUndefined();
	});

	it("reports the path, the reason and the attempt count once the retries are spent", async () => {
		const { settings, configPath, reported } = await unwritable("directory-in-the-way");

		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);

		const failure = settings.saveFailure;
		expect(failure?.path).toBe(configPath);
		expect(failure?.attempts).toBe(3);
		// The reason is the operator's only clue about WHY, so it has to be the real
		// filesystem/runtime error for a directory standing in for a file, not a generic
		// "save failed".
		expect(failure?.reason).toMatch(/EISDIR|is a directory|Directories cannot be read like files/i);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toEqual(failure as SettingsSaveFailure);
	});

	it("reports a read-only config directory too, not just a blocked file path", async () => {
		// The likeliest real cause: a home directory or profile dir that is not writable.
		const { settings, reported } = await unwritable("read-only-parent");

		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);

		expect(reported).toHaveLength(1);
		expect(reported[0]?.reason).toMatch(/EACCES|EPERM|permission denied/i);
	});

	it("reports once, not on every retry for the rest of the session", async () => {
		// A filesystem that stays broken keeps failing. Firing the notice each time would
		// bury the transcript in duplicates of the same problem.
		const { settings, reported } = await unwritable("directory-in-the-way");

		for (const value of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) await attemptSave(settings, value);

		expect(reported).toHaveLength(1);
		// The counter keeps rising, so the message's "after N attempts" stays honest.
		expect(settings.saveFailure?.attempts).toBeGreaterThanOrEqual(6);
	});

	it("keeps the value in memory, which is exactly why the report is needed", async () => {
		// The UI reads the in-memory value and shows the change as applied. That is the
		// whole hazard: without a report the user's only signal is the setting reverting
		// on their next launch.
		const { settings, configPath } = await unwritable("directory-in-the-way");

		for (const value of [0.25, 0.25, 0.25]) await attemptSave(settings, value);

		expect(settings.get("topP")).toBe(0.25);
		// Nothing was written: the path is still the directory that blocked the write.
		expect((await fs.stat(configPath)).isDirectory()).toBe(true);
	});

	it("does not report anything for a save that lands", async () => {
		// The negative twin. A suite that only tested the failure path would pass with a
		// notification that fires on every successful save.
		const agentDir = await makeAgentDir();
		const settings = await Settings.loadIsolated({ agentDir });
		const reported: SettingsSaveFailure[] = [];
		settings.onSaveFailure(failure => reported.push(failure));

		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);

		expect(reported).toEqual([]);
		expect(settings.saveFailure).toBeUndefined();
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toContain("topP: 0.3");
	});

	it("clears the failure as soon as a save succeeds", async () => {
		// The report is about the CURRENT state. A path that becomes writable again (a
		// remount, a chmod, the stray directory removed) must stop being reported, or the
		// notice outlives the problem.
		const { settings, agentDir, configPath } = await unwritable("directory-in-the-way");
		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);
		expect(settings.saveFailure).toBeDefined();

		await fs.rmdir(configPath);
		await attemptSave(settings, 0.4);

		expect(settings.saveFailure).toBeUndefined();
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toContain("topP: 0.4");
	});

	it("counts a fresh run of failures from zero after a success", async () => {
		// The counter is consecutive failures, not a lifetime total, so the "after N
		// attempts" in the message describes the problem the user has now.
		const { settings, configPath } = await unwritable("directory-in-the-way");
		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);
		await fs.rmdir(configPath);
		await attemptSave(settings, 0.4);

		await fs.rm(path.join(configPath));
		await fs.mkdir(configPath, { recursive: true });
		await attemptSave(settings, 0.5);

		expect(settings.saveFailure).toBeUndefined();
	});
});

describe("the listener contract", () => {
	it("stops calling a listener that unsubscribed", async () => {
		const { settings } = await unwritable("directory-in-the-way");
		const seen: SettingsSaveFailure[] = [];
		const unsubscribe = settings.onSaveFailure(failure => seen.push(failure));
		unsubscribe();

		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);

		expect(seen).toEqual([]);
		// The failure is still recorded: unsubscribing silences a listener, not the state.
		expect(settings.saveFailure).toBeDefined();
	});

	it("keeps reporting to the other listeners when one throws", async () => {
		// A UI surface that blows up must not swallow the report for everyone else, since
		// the point of this path is that the user hears about it.
		const { settings } = await unwritable("directory-in-the-way");
		const seen: string[] = [];
		settings.onSaveFailure(() => {
			throw new Error("this listener is broken");
		});
		settings.onSaveFailure(failure => seen.push(failure.path));

		for (const value of [0.1, 0.2, 0.3]) await attemptSave(settings, value);

		expect(seen).toHaveLength(1);
	});
});
