/**
 * `profile list --json` says when the size it reports is a lower bound.
 *
 * WHY THIS SUITE EXISTS. The size walk skips what it cannot read, and skipping is correct: one
 * unreadable subdirectory must not make `profile list --json` fail, and a profile is still worth
 * listing. What the walk used to do was skip SILENTLY — a bare `catch { return }` on the `readdir`
 * and a bare `catch {}` on each `stat`.
 *
 * `bytes` is not decoration. It is the number a cleanup script reads to decide what to prune and the
 * number a person reads to decide whether a profile is worth keeping. A walk that omitted an
 * unreadable subtree reported a profile as a fraction of its real size, and nothing in the output
 * distinguished "this profile is small" from "most of it was not counted" (Law 10). Acting on that
 * number means deleting the wrong profile, or keeping a large one believing it is empty.
 *
 * So the walk now returns the paths it could not measure, the JSON row carries `bytesComplete`, and
 * the paths reach the log where the permission bit is findable. Two skips stay silent on purpose,
 * and both are pinned below: a missing root (an empty profile is genuinely zero bytes) and a file
 * deleted between the `readdir` and the `stat` (its bytes are genuinely gone). Reporting those would
 * make `bytesComplete: false` routine, and a flag that is usually false tells the reader nothing.
 */

import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-profile-size-");

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

interface ProfileRow {
	name: string;
	rootDir: string;
	bytes: number;
	bytesComplete: boolean;
}

function makeEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) delete env[key];
	return env;
}

async function runProfile(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "profile", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function listRows(env: Record<string, string | undefined>): Promise<ProfileRow[]> {
	const { stdout, exitCode } = await runProfile(env, ["list", "--json"]);
	expect(exitCode).toBe(0);
	return JSON.parse(stdout) as ProfileRow[];
}

/**
 * Every log entry this run wrote, parsed.
 *
 * The warning does not go to stderr: writing there would corrupt the TUI, so the logger's default
 * transport is the rotating file under the profile's logs directory. Reading it back is the stronger
 * assertion anyway — the fields are structured, so the path can be pinned exactly rather than matched
 * as a substring of console output.
 */
function logEntries(home: string): Array<Record<string, unknown>> {
	// The rotating log lives under the ACTIVE profile (`.veyyon/profiles/default/logs`), not at the
	// config root, so this walks rather than joining a fixed path — a suite that hard-coded the
	// location would go quietly green if the layout moved.
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".log")) found.push(full);
		}
	};
	walk(path.join(home, ".veyyon"));
	return found.flatMap(file =>
		readFileSync(file, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>),
	);
}

/** The row for a profile, asserting it is listed at all rather than returning undefined. */
function row(rows: ProfileRow[], name: string): ProfileRow {
	const found = rows.find(entry => entry.name === name);
	expect(found, `profile "${name}" is missing from the listing`).toBeDefined();
	return found as ProfileRow;
}

describe("profile list --json size accounting", () => {
	it("counts a file's exact bytes and reports the total as complete", async () => {
		// The healthy path, asserted as a difference rather than an absolute: `profile new` seeds
		// a tree whose size is not this suite's business, but the delta from one added file is
		// exactly its length, which is what proves the walk is measuring and not estimating.
		const home = makeTempDir();
		const env = makeEnv(home);
		await runProfile(env, ["new", "measured"]);

		const before = row(await listRows(env), "measured");
		expect(before.bytesComplete).toBe(true);

		const payload = "x".repeat(4096);
		writeFileSync(path.join(before.rootDir, "agent", "padding.bin"), payload);

		const after = row(await listRows(env), "measured");
		expect(after.bytes - before.bytes).toBe(4096);
		expect(after.bytesComplete).toBe(true);
	}, 60_000);

	it("counts bytes in nested directories, so the walk is recursive and not one level deep", async () => {
		const home = makeTempDir();
		const env = makeEnv(home);
		await runProfile(env, ["new", "nested"]);

		const before = row(await listRows(env), "nested");
		const deep = path.join(before.rootDir, "agent", "a", "b", "c");
		mkdirSync(deep, { recursive: true });
		writeFileSync(path.join(deep, "buried.bin"), "y".repeat(1234));

		const after = row(await listRows(env), "nested");
		expect(after.bytes - before.bytes).toBe(1234);
		expect(after.bytesComplete).toBe(true);
	}, 60_000);

	it("marks the total incomplete and names the path when a subdirectory cannot be read", async () => {
		// The regression this suite exists for. A directory with no permissions makes `readdir`
		// fail with EACCES, and every byte beneath it vanishes from the total. Skipped on
		// Windows, where the mode bits do not produce this.
		if (process.platform === "win32") return;
		const home = makeTempDir();
		const env = makeEnv(home);
		await runProfile(env, ["new", "blocked"]);

		const before = row(await listRows(env), "blocked");
		const hidden = path.join(before.rootDir, "agent", "hidden");
		mkdirSync(hidden, { recursive: true });
		writeFileSync(path.join(hidden, "big.bin"), "z".repeat(65_536));
		chmodSync(hidden, 0o000);
		try {
			const blocked = row(await listRows(env), "blocked");

			// The listing still succeeds — that is deliberate — and the flag is what tells the
			// reader the number below it is a floor rather than a measurement.
			expect(blocked.bytesComplete).toBe(false);
			expect(blocked.bytes).toBeLessThan(before.bytes + 65_536);
			const reported = logEntries(home).filter(
				entry => entry.message === "Profile size is incomplete; some paths could not be read",
			);
			expect(reported.length).toBeGreaterThan(0);
			expect(reported[0]?.profile).toBe("blocked");
			expect(reported[0]?.unmeasured).toEqual([hidden]);
			expect(reported[0]?.level).toBe("warn");
		} finally {
			// Restore before the temp tree is left behind, since nothing can enter it otherwise.
			chmodSync(hidden, 0o755);
		}
	}, 60_000);

	it("returns to a complete total once the path is readable again", async () => {
		// The other direction: `bytesComplete` tracks the current walk, so a fixed permission bit
		// is reflected immediately and the previously hidden bytes appear in the total.
		if (process.platform === "win32") return;
		const home = makeTempDir();
		const env = makeEnv(home);
		await runProfile(env, ["new", "recovered"]);

		const baseline = row(await listRows(env), "recovered");
		const hidden = path.join(baseline.rootDir, "agent", "hidden");
		mkdirSync(hidden, { recursive: true });
		writeFileSync(path.join(hidden, "big.bin"), "z".repeat(32_768));
		chmodSync(hidden, 0o000);
		const whileBlocked = row(await listRows(env), "recovered");
		expect(whileBlocked.bytesComplete).toBe(false);

		chmodSync(hidden, 0o755);
		const afterFix = row(await listRows(env), "recovered");
		expect(afterFix.bytesComplete).toBe(true);
		expect(afterFix.bytes - baseline.bytes).toBe(32_768);
	}, 60_000);

	it("stays complete and quiet for a profile whose directory does not exist", async () => {
		// The load-bearing silence. A profile can be listed before anything is written into it,
		// and an absent root is a real answer of zero rather than a measurement failure. If this
		// warned, `bytesComplete: false` would be the normal case and would stop meaning anything.
		const home = makeTempDir();
		const env = makeEnv(home);
		const rows = await listRows(env);

		const base = row(rows, "default");
		expect(base.bytesComplete).toBe(true);
		expect(
			logEntries(home).filter(entry => entry.message === "Profile size is incomplete; some paths could not be read"),
		).toEqual([]);
	}, 60_000);
});
