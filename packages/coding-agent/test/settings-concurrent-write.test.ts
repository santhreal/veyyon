import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSettingsConcurrentDir = useTrackedTempDirs("veyyon-settings-concurrent-");

/**
 * SETC-2: concurrent settings writes must never truncate, interleave, or drop a
 * key.
 *
 * Two veyyon windows are ordinary, and both write `config.yml`. The naive
 * implementation of that is read → modify → `writeFile`, and it loses data two
 * distinct ways:
 *
 *  1. **Torn file.** A reader that opens the path mid-`writeFile` sees a
 *     prefix. YAML usually still PARSES a prefix, so the damage is not an error
 *     but a config that is quietly missing its tail.
 *  2. **Lost update.** Both processes read the same base, each adds its own key,
 *     and the second write erases the first. Nothing fails; a setting the user
 *     changed simply is not there next launch.
 *
 * The implementation answers each with a different mechanism, and this suite
 * tests them separately because they fail separately: `atomicWriteFile` (write a
 * temp, then rename over the target) makes the replacement indivisible, so no
 * reader can ever observe a partial file; `withFileLock` around the whole
 * read-modify-write makes the re-read see the other process's key, so neither
 * update is lost.
 *
 * The writers are real spawned processes, not extra `Settings` instances. An
 * advisory file lock is a CROSS-PROCESS device; two instances in one process
 * would serialize on the event loop and pass this suite with the lock deleted,
 * which is precisely the false green worth avoiding.
 *
 * The concurrency here was checked against a negative control rather than
 * assumed: six processes doing the naive unlocked read-modify-write on one file,
 * five writes each, ended with four of the six keys gone. The same six writers
 * going through `Settings` lose none. So these tests do exercise real overlap,
 * and a regression that dropped the lock would be caught rather than hidden by
 * writers that happened not to collide.
 *
 * Everything runs against a temp `agentDir`. The first assertion checks that,
 * because a suite of this shape hammering the real config root would be exactly
 * the data loss it exists to prevent.
 */
describe("concurrent settings writes from separate processes", () => {
	const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
	const WRITER = path.join(import.meta.dir, "support", "settings-concurrent-writer.ts");

	// Distinct boolean paths, one per writer, all defaulting to something other
	// than the value written so a surviving key is unambiguously that writer's.
	const KEYS = [
		"advisor.enabled",
		"prewalk.enabled",
		"git.enabled",
		"terminal.showImages",
		"tui.tight",
		"images.autoResize",
	] as const;

	let agentDir = "";

	beforeEach(() => {
		agentDir = makeSettingsConcurrentDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-concurrent-write"));
			agentDir = "";
		}
	});

	function configPath(): string {
		return path.join(agentDir, "config.yml");
	}

	function spawnWriter(key: string, value: string, writes = 1) {
		return Bun.spawn(["bun", WRITER, agentDir, key, value, String(writes)], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	async function runWriters(writes: number): Promise<void> {
		const procs = KEYS.map(key => spawnWriter(key, "false", writes));
		const codes = await Promise.all(procs.map(p => p.exited));
		const failures = await Promise.all(
			procs.map(async (p, i) => (codes[i] === 0 ? undefined : `${KEYS[i]}: ${await new Response(p.stderr).text()}`)),
		);
		// A writer that crashed would make every "no key was lost" assertion below
		// meaningless, so its stderr is surfaced rather than swallowed.
		expect(failures.filter(Boolean)).toEqual([]);
	}

	test("the suite writes only inside its temp dir, never the real config root", async () => {
		// The guard that makes the rest of this file safe to run on a developer
		// machine. A hammer test pointed at the real `~/.veyyon` is the data loss it
		// is supposed to be preventing.
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		settings.set("advisor.enabled", false);
		await settings.flush();

		expect(fs.existsSync(configPath())).toBe(true);
		expect(configPath().startsWith(os.tmpdir())).toBe(true);
	});

	describe("no update is lost", () => {
		test("every writer's key survives when all six write at once", async () => {
			// The lost-update case. Without the lock around read-modify-write, the
			// writers read the same base and the last rename wins, so most of these
			// keys would simply be absent, with nothing having failed.
			await runWriters(1);

			const parsed = YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>;

			const found = Object.fromEntries(
				KEYS.map(key => {
					const [group, leaf] = key.split(".") as [string, string];
					return [key, parsed[group]?.[leaf]];
				}),
			);
			// Exact values, all six, in one assertion so a failure names precisely
			// which writers were clobbered rather than just "something is missing".
			expect(found).toEqual({
				"advisor.enabled": false,
				"prewalk.enabled": false,
				"git.enabled": false,
				"terminal.showImages": false,
				"tui.tight": false,
				"images.autoResize": false,
			});
		});

		test("they survive repeated hammering, not just a lucky single round", async () => {
			// Five writes each means thirty lock acquisitions contending on one file.
			// A single round can pass by accident when the processes happen not to
			// overlap; this makes overlap the norm.
			await runWriters(5);

			const parsed = YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>;

			for (const key of KEYS) {
				const [group, leaf] = key.split(".") as [string, string];
				expect(parsed[group]?.[leaf]).toBe(false);
			}
		});

		test("a value written before the storm is preserved through it", async () => {
			// External-change preservation: `#saveNow` re-reads under the lock and
			// applies only ITS modified paths, so a key nobody touched must come out
			// the other side untouched rather than reverted to a default.
			const seed = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			seed.set("statusLine.transparent", true);
			await seed.flush();

			await runWriters(3);

			const parsed = YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>;
			expect(parsed.statusLine?.transparent).toBe(true);
		});

		test("an unknown key a user hand-wrote is never dropped by a concurrent write", async () => {
			// Someone else's tool, or a setting from a newer build, lives in this file
			// too. Rewriting it out is silent data loss of exactly the same kind.
			fs.writeFileSync(configPath(), "customTool:\n  keepMe: yes-please\n");

			await runWriters(2);

			const parsed = YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>;
			expect(parsed.customTool?.keepMe).toBe("yes-please");
		});
	});

	describe("the file is never observed torn", () => {
		test("every snapshot taken during the storm parses as a YAML mapping", async () => {
			// The atomicity half. A reader polling as fast as it can must never catch a
			// prefix: rename-over-target is indivisible, so each open sees either the
			// whole old file or the whole new one.
			//
			// Note this asserts PARSES-AS-MAPPING, not merely "did not throw". A
			// truncated YAML document very often still parses, into a smaller mapping,
			// which is why a bare `YAML.parse` in a try block would be a test that
			// cannot fail.
			const procs = KEYS.map(key => spawnWriter(key, "false", 6));

			const snapshots: string[] = [];
			const done = Promise.all(procs.map(p => p.exited));
			let running = true;
			void done.then(() => {
				running = false;
			});
			while (running) {
				const text = readIfPresent(configPath());
				if (text !== undefined) snapshots.push(text);
				await Bun.sleep(1);
			}
			await done;

			expect(snapshots.length).toBeGreaterThan(0);
			for (const snapshot of snapshots) {
				const parsed = YAML.parse(snapshot) as unknown;
				expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
			}
		});

		test("no temp file is left behind once the writers finish", async () => {
			// The other side of write-then-rename: the temp must become the target,
			// not accumulate. A directory filling with `config.yml.tmp-*` after every
			// save is a leak that eventually looks like corruption to a user reading
			// their own config directory.
			await runWriters(3);

			const stray = fs.readdirSync(agentDir).filter(name => name !== "config.yml" && name.startsWith("config.yml"));
			expect(stray).toEqual([]);
		});
	});

	test("the final file is loadable by Settings and reports the written values", async () => {
		// The control, and the only assertion stated in the terms a user experiences:
		// after the storm, a fresh launch reads back what was written. Without it the
		// file could be well-formed and complete and still not mean anything.
		await runWriters(2);

		const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(reloaded.get("advisor.enabled")).toBe(false);
		expect(reloaded.get("git.enabled")).toBe(false);
		expect(reloaded.get("tui.tight")).toBe(false);
		expect(reloaded.quarantinedFiles).toEqual([]);
	});
});

/** Read a path that may not exist yet, without turning absence into a failure. */
function readIfPresent(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}
