/**
 * WHY: "my settings are gone after the update" has three separate mechanisms,
 * and fixing one of them is not fixing the symptom.
 *
 * The first, a save built on a read that failed, is pinned next door in
 * `a-save-never-empties-a-config-it-could-not-read.test.ts`. The two below are
 * the ones that survive that fix:
 *
 *  1. An INTERRUPTED write. `config.yml` is the file the operator's whole setup
 *     lives in, and an update is exactly when a process gets killed mid-save. A
 *     writer that truncates the target and streams into it leaves a prefix on
 *     disk, and a truncated YAML document usually still PARSES: the loader sees
 *     a valid mapping that is simply missing most of its keys, reports nothing,
 *     and every absent setting silently takes its default. Nothing fires, so
 *     nothing is recovered. The only defence is that the target is never opened
 *     for writing at all: the bytes are staged in a sibling temp file and the
 *     finished file is renamed over the target in one step.
 *
 *  2. An OLDER build walking a NEWER build's migration stamp backwards. The
 *     stamp records that a one-shot migration has run, and a one-shot migration
 *     is one that cannot tell its input apart from a value the user meant (the
 *     `-1` incident that put the stamp there). An installed binary beside a
 *     source checkout, or a downgrade after a bad release, is enough: the older
 *     build rewrites the stamp down to the version it knows, and the next run of
 *     the newer build re-runs a migration whose whole contract is that it runs
 *     once, on values written since.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { resetSettingsForTest, SETTINGS_MIGRATION_VERSION, Settings } from "../../src/config/settings";

/**
 * A config with the shapes that make a partial write dangerous: a comment the
 * writer must carry, several nested blocks, and a long tail. A prefix of this
 * file is still valid YAML, which is the point.
 */
const CONFIG = `# the operator wrote this comment
theme:
  dark: dracula
  light: solarized
tools:
  approvalMode: manual
display:
  showTokenUsage: true
compaction:
  threshold: 85%
  reserveTokens: 8000
futureFeature: from-a-newer-build
`;

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function agentDirWithConfig(config = CONFIG): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-config-crash-"));
	await fs.writeFile(path.join(dir, "config.yml"), config, "utf8");
	return dir;
}

interface Interruption {
	/** True once a rename whose destination was the config file was attempted. */
	swapAttempted: boolean;
	/** The config file's bytes read at that instant, mid-write. */
	targetDuringWrite: string | undefined;
}

/**
 * Kill the save at the last possible moment: the new bytes are fully written and
 * flushed somewhere on disk, and the swap onto `config.yml` is the next syscall.
 *
 * That instant is the whole question. If the writer stages into a temp file, the
 * target still holds the old bytes here and the crash costs nothing. If it writes
 * in place, the target is already the new content (or a prefix of it) and there is
 * nothing left to lose.
 *
 * Only renames that land on the config file are failed. The file lock this save
 * takes is itself built out of directory renames, so failing them all would abort
 * the save before it ever reached the write and prove nothing.
 */
function interruptTheSwap(configPath: string): Interruption {
	const realRename = fs.rename.bind(fs);
	const state: Interruption = { swapAttempted: false, targetDuringWrite: undefined };
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) !== configPath) return realRename(from, to);
		state.swapAttempted = true;
		try {
			state.targetDuringWrite = await fs.readFile(configPath, "utf8");
		} catch {
			state.targetDuringWrite = undefined;
		}
		throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
	});
	return state;
}

describe("a config save killed mid-write", () => {
	/**
	 * The contract: an update that dies between "bytes written" and "file
	 * replaced" costs the operator nothing. Byte identity, not key-by-key
	 * equality, because a partial write that happens to keep every key and lose
	 * a comment is still a partial write.
	 */
	it("leaves the operator's file byte-identical", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		const interruption = interruptTheSwap(configPath);
		settings.set("topP", 0.9);
		await settings.flush();

		// Without this the case is vacuous: a save that never ran also leaves the
		// file untouched. The swap has to have been reached and refused.
		expect(interruption.swapAttempted).toBe(true);
		expect(await fs.readFile(configPath, "utf8")).toBe(CONFIG);
	});

	/**
	 * The nastiest shape of the defect, asserted where it would actually be
	 * observable: at the instant the write is furthest along, the target must
	 * still be the old file. A truncated-but-parseable document read from here
	 * is what the loader would silently accept as "the operator configured
	 * almost nothing".
	 */
	it("never exposes a half-written document at the config path", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		const interruption = interruptTheSwap(configPath);
		settings.set("topP", 0.9);
		await settings.flush();

		expect(interruption.swapAttempted).toBe(true);
		expect(interruption.targetDuringWrite).toBe(CONFIG);
	});

	/** A crashed write must not leave debris that a later run treats as config. */
	it("cleans up the bytes it staged", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		interruptTheSwap(configPath);
		settings.set("topP", 0.9);
		await settings.flush();

		// Anything the atomic writer staged and did not swap in.
		expect((await fs.readdir(dir)).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	});

	/** The change is queued, not dropped, so the retry after the fault lands it
	 * without the operator touching anything. */
	it("keeps the pending change and writes it once the swap works again", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		interruptTheSwap(configPath);
		settings.set("topP", 0.9);
		await settings.flush();
		expect(await fs.readFile(configPath, "utf8")).toBe(CONFIG);

		vi.restoreAllMocks();
		await settings.flush();

		const recovered = await fs.readFile(configPath, "utf8");
		expect(recovered).toContain("topP: 0.9");
		expect(recovered).toContain("# the operator wrote this comment");
		expect(recovered).toContain("dark: dracula");
		expect(recovered).toContain("futureFeature: from-a-newer-build");
	});
});

describe("a config stamped by a newer build", () => {
	const NEWER = SETTINGS_MIGRATION_VERSION + 5;

	/**
	 * `presencePenalty: -1` is the value the one-shot migration deletes, and the
	 * stamp is the only thing that says it is a value rather than the old "unset"
	 * sentinel. An older build that lowers the stamp arms that deletion for the
	 * next run of the newer build.
	 */
	const FROM_THE_FUTURE = `settingsMigrationVersion: ${NEWER}
presencePenalty: -1
theme:
  dark: dracula
`;

	it("does not lower the stamp when an older build writes a setting", async () => {
		const dir = await agentDirWithConfig(FROM_THE_FUTURE);
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		settings.set("topP", 0.9);
		await settings.flush();

		const parsed = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
		expect(parsed.settingsMigrationVersion).toBe(NEWER);
	});

	it("leaves the value that stamp certifies alone", async () => {
		const dir = await agentDirWithConfig(FROM_THE_FUTURE);
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		settings.set("presencePenalty", -1);
		await settings.flush();

		const parsed = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
		expect(parsed.presencePenalty).toBe(-1);
		expect(parsed.settingsMigrationVersion).toBe(NEWER);
	});

	/** The stamp still has to go IN when it is genuinely missing, or the fix is
	 * just "never stamp anything". */
	it("still stamps a config that has never been migrated", async () => {
		const dir = await agentDirWithConfig("theme:\n  dark: dracula\n");
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		settings.set("presencePenalty", -1);
		await settings.flush();

		const parsed = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
		expect(parsed.settingsMigrationVersion).toBe(SETTINGS_MIGRATION_VERSION);
		expect(parsed.presencePenalty).toBe(-1);
	});
});
