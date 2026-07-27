/**
 * The user's config after a REAL binary swap, not after a Settings round trip.
 *
 * `settings-rich-config-survives-a-write` proves the loader and writer keep a rich file
 * intact. That is a different claim from the one a user makes when they say an update ate
 * their config: an update replaces the executable, sweeps old backups, and regenerates
 * completion scripts, all in the same directory tree the config lives under, and none of
 * that goes through Settings at all. A swap that touched the config, or that left the file
 * with the temp's mode, or that replaced a dotfiles symlink with a regular file, would
 * pass every existing suite.
 *
 * So this drives the real exported update steps — `replaceBinaryForUpdate`,
 * `sweepStaleBackups`, `verifyBinaryUsable` — against real files on a real filesystem, with
 * the shared rich config sitting beside them, and then reads the config back BYTE FOR BYTE.
 * Real installed binaries are stand-in scripts that answer the three things
 * `verifyBinaryUsable` asks (`--version`, `grep --help`, `grep <pattern> <dir>`), because
 * what is under test is what the swap does to the directory, not what veyyon does when it
 * starts.
 *
 * The composition matters as much as the parts: the last test swaps the binary and THEN
 * runs a real Settings write against the config the swap left behind, which is the actual
 * sequence a user lives through (update, restart, change a setting).
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate, sweepStaleBackups, verifyBinaryUsable } from "@veyyon/coding-agent/cli/update-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as YAML from "yaml";
import { RICH_CONFIG, RICH_CONFIG_SECRET } from "./helpers/rich-config-fixture";

const NEW_VERSION = "9.9.9";
const OLD_VERSION = "9.9.8";

/**
 * A stand-in veyyon that answers exactly what the update verifies.
 *
 * `--version` must print `veyyon/X.Y.Z` (the swap parses that shape), and the search probe
 * requires a `grep` that really finds the file it is pointed at: a script that echoed
 * `probe.txt` would satisfy the probe even if the update stopped pointing it anywhere,
 * which is the failure the probe exists to catch.
 */
function standInBinary(version: string): string {
	return `#!/bin/sh
set -u
case "\${1:-}" in
	--version) echo "veyyon/${version}"; exit 0 ;;
	grep)
		[ "\${2:-}" = "--help" ] && { echo "usage: veyyon grep <pattern> <path>"; exit 0; }
		exec grep -rl -- "$2" "$3" ;;
	*) echo "unknown command: \${1:-}" >&2; exit 2 ;;
esac
`;
}

const tempRoots: string[] = [];

beforeAll(async () => {
	// Nothing here reads the developer's settings, and an in-memory Settings keeps the
	// isolated loads below from touching a real config root.
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

interface Staged {
	root: string;
	binaryPath: string;
	tempPath: string;
	backupPath: string;
	agentDir: string;
	configPath: string;
	/** The bytes of the config as staged, for a byte-for-byte comparison afterwards. */
	configBefore: string;
	configSha: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** An install directory with a binary to replace, and an agent dir holding the rich config. */
async function stage(options: { symlinkedConfig?: boolean; mode?: number } = {}): Promise<Staged> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-swap-config-"));
	tempRoots.push(root);
	const binDir = path.join(root, "bin");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(binDir, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });

	const binaryPath = path.join(binDir, "vey");
	await fs.writeFile(binaryPath, standInBinary(OLD_VERSION), { mode: 0o755 });
	const tempPath = `${binaryPath}.new`;
	await fs.writeFile(tempPath, standInBinary(NEW_VERSION), { mode: 0o755 });

	const configPath = path.join(agentDir, "config.yml");
	const target = options.symlinkedConfig ? path.join(agentDir, "dotfiles-config.yml") : configPath;
	await fs.writeFile(target, RICH_CONFIG, { mode: options.mode ?? 0o600 });
	if (options.symlinkedConfig) await fs.symlink(target, configPath);

	return {
		root,
		binaryPath,
		tempPath,
		backupPath: `${binaryPath}.${Date.now()}.${process.pid}.bak`,
		agentDir,
		configPath,
		configBefore: RICH_CONFIG,
		configSha: sha256(RICH_CONFIG),
	};
}

/** The swap exactly as `updateViaBinaryAt` performs it, minus the download. */
async function swap(staged: Staged): Promise<void> {
	const verified = await replaceBinaryForUpdate({
		targetPath: staged.binaryPath,
		tempPath: staged.tempPath,
		backupPath: staged.backupPath,
		expectedVersion: NEW_VERSION,
		verifyInstalledVersion: version => verifyBinaryUsable(staged.binaryPath, version),
	});
	expect(verified.ok, `the swap must verify: ${verified.reason ?? verified.actual ?? "no reason given"}`).toBe(true);
	await sweepStaleBackups(staged.binaryPath);
}

/**
 * Wait for a settings write to actually reach disk.
 *
 * `flush()`, not a fixed sleep: Settings batches saves behind a timer, and a guessed interval is a race that
 * only loses under load. The sibling corpus suite (`settings-rich-config-survives-a-write.test.ts`) failed
 * exactly that way in full-suite runs while passing alone, so both use the real drain.
 */
async function settle(settings: Settings): Promise<void> {
	await settings.flush();
}

describe("a real binary swap and the config beside it", () => {
	it("installs the new binary and leaves it runnable", async () => {
		// The control: if the swap did not happen, everything below is vacuous.
		const staged = await stage();
		await swap(staged);

		expect(await fs.readFile(staged.binaryPath, "utf8")).toBe(standInBinary(NEW_VERSION));
		const verified = await verifyBinaryUsable(staged.binaryPath, NEW_VERSION);
		expect(verified.ok).toBe(true);
		expect(verified.actual).toBe(NEW_VERSION);
	});

	it("leaves the config byte-for-byte identical", async () => {
		// Not "the values are still there" — the BYTES. A re-serialization that
		// preserved every value while re-quoting the secret or dropping the comment
		// would pass a value-level check and still break a working MCP server.
		const staged = await stage();
		await swap(staged);

		const after = await fs.readFile(staged.configPath, "utf8");
		expect(sha256(after)).toBe(staged.configSha);
		expect(after).toBe(staged.configBefore);
	});

	it("keeps the config's 0600 mode", async () => {
		// The file holds credentials. Nothing in the swap should touch it at all, so
		// the mode is the cheapest evidence that nothing rewrote it in passing.
		const staged = await stage();
		await swap(staged);

		const stats = await fs.stat(staged.configPath);
		expect(stats.mode & 0o777).toBe(0o600);
	});

	it("keeps the credential in the MCP block exactly as written", async () => {
		const staged = await stage();
		await swap(staged);

		const after = await fs.readFile(staged.configPath, "utf8");
		expect(after).toContain(`API_TOKEN: ${RICH_CONFIG_SECRET}`);
		const parsed = YAML.parse(after) as Record<string, Record<string, Record<string, unknown>>>;
		expect(parsed.mcpServers?.["paid-api"]?.env).toEqual({ API_TOKEN: RICH_CONFIG_SECRET });
	});

	it("leaves a symlinked config a symlink, pointing where it did", async () => {
		// A dotfiles manager points config.yml into a synced repo. Replacing the LINK
		// unhooks the user's setup, and their next sync overwrites what veyyon wrote.
		const staged = await stage({ symlinkedConfig: true });
		const linkTarget = await fs.readlink(staged.configPath);
		await swap(staged);

		const stats = await fs.lstat(staged.configPath);
		expect(stats.isSymbolicLink()).toBe(true);
		expect(await fs.readlink(staged.configPath)).toBe(linkTarget);
		expect(await fs.readFile(linkTarget, "utf8")).toBe(staged.configBefore);
	});

	it("adds nothing to the directory holding the config", async () => {
		// The swap's temp and backup live beside the BINARY. One landing beside the
		// config would mean a stray file in the user's config tree after every update.
		const staged = await stage();
		await swap(staged);

		expect((await fs.readdir(staged.agentDir)).sort()).toEqual(["config.yml"]);
	});

	it("leaves no temp or backup beside the binary either", async () => {
		// `sweepStaleBackups` runs after every swap for exactly this reason: each
		// backup is a full copy of the binary.
		const staged = await stage();
		await swap(staged);

		expect((await fs.readdir(path.dirname(staged.binaryPath))).sort()).toEqual(["vey"]);
	});
});

describe("the sequence a user actually lives through", () => {
	it("survives swap, then restart, then a setting change", async () => {
		// Update, restart, change one setting. Each half is covered elsewhere; the
		// composition is what a user reports as "the update ate my config", and a
		// migration that runs on first load after an update is the thing most likely
		// to do it.
		const staged = await stage();
		await swap(staged);

		const settings = await Settings.loadIsolated({ agentDir: staged.agentDir });
		await settings.set("topP", 0.9);
		await settle(settings);

		const after = await fs.readFile(staged.configPath, "utf8");
		const parsed = YAML.parse(after) as Record<string, unknown>;
		// The write it was asked for landed...
		expect(parsed.topP).toBe(0.9);
		// ...and everything the user had is still there, including the newer build's
		// keys and the credential.
		expect(parsed.temperature).toBe(0.7);
		expect(parsed.topK).toBe(40);
		expect(parsed.compaction).toMatchObject({ threshold: "85%", reserveTokens: 8000 });
		expect(parsed.futureFeature).toBe("from-a-newer-build");
		expect(parsed.futureBlock).toEqual({ nested: "alsoKept" });
		expect(after).toContain(`API_TOKEN: ${RICH_CONFIG_SECRET}`);
		expect(after).toContain("# A comment a user wrote");
		// The only keys added are the one asked for and the migration marker the
		// writer stamps; naming them is the point, since a silent third key would be
		// a change to the user's file nobody asked for.
		const addedKeys = Object.keys(parsed).filter(key => !RICH_CONFIG.includes(`${key}:`));
		expect(addedKeys.sort()).toEqual(["settingsMigrationVersion", "topP"]);
		const stats = await fs.stat(staged.configPath);
		expect(stats.mode & 0o777).toBe(0o600);
	});

	it("survives a rolled-back swap too", async () => {
		// Verification failure rolls the previous binary back. The config must be
		// untouched by the failed attempt AND by the rollback, or a bad release costs
		// the user their settings on top of the update they did not get.
		const staged = await stage();
		await expect(
			replaceBinaryForUpdate({
				targetPath: staged.binaryPath,
				tempPath: staged.tempPath,
				backupPath: staged.backupPath,
				expectedVersion: "1.2.3",
				verifyInstalledVersion: () => verifyBinaryUsable(staged.binaryPath, "1.2.3"),
			}),
		).rejects.toThrow();

		expect(await fs.readFile(staged.binaryPath, "utf8")).toBe(standInBinary(OLD_VERSION));
		const after = await fs.readFile(staged.configPath, "utf8");
		expect(sha256(after)).toBe(staged.configSha);
		expect((await fs.readdir(staged.agentDir)).sort()).toEqual(["config.yml"]);
	});
});
