/**
 * Startup update-notice contracts:
 *
 * - Startup never prints release notes. It prints at most one line naming the
 *   version that landed; `/changelog` opens the notes on the web.
 * - The notice fires exactly once per upgrade, driven by the marker the
 *   previous run wrote.
 * - A fresh install and a downgrade both record the version silently.
 * - The last-seen marker is a plain file in the agent dir.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";
import {
	type ChangelogEntry,
	compareVersions,
	decideUpdateNotice,
	parseChangelog,
	parseChangelogVersion,
	readLastChangelogVersion,
	writeLastChangelogVersion,
} from "../../src/utils/changelog";

const CURRENT_VERSION = "2.0.0";
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const hasPtyHarness =
	process.platform === "linux" &&
	(await Bun.file("/usr/bin/script").exists()) &&
	(await Bun.file("/usr/bin/timeout").exists());
const PTY_STARTUP_OUTPUT_CEILING = 512 * 1024;

async function withTempAgentDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-changelog-marker-"));
	try {
		const result = await callback(agentDir);
		return result;
	} finally {
		await removeWithRetries(agentDir);
	}
}

describe("decideUpdateNotice", () => {
	test("announces the running version when the marker is an older release", () => {
		const decision = decideUpdateNotice("1.9.0", "2.0.0");

		expect(decision.installedVersion).toBe("2.0.0");
		expect(decision.persistCurrentVersion).toBe(true);
	});

	test("says nothing on an ordinary restart", () => {
		const decision = decideUpdateNotice(CURRENT_VERSION, CURRENT_VERSION);

		expect(decision.installedVersion).toBeUndefined();
		// Nothing changed, so there is no reason to rewrite the marker.
		expect(decision.persistCurrentVersion).toBe(false);
	});

	test("stays quiet on a fresh install but records the version", () => {
		// No marker means nobody has run this before. That is not an update, and
		// greeting a new user with news about a release they never ran is wrong.
		const decision = decideUpdateNotice(undefined, CURRENT_VERSION);

		expect(decision.installedVersion).toBeUndefined();
		expect(decision.persistCurrentVersion).toBe(true);
	});

	test("stays quiet on a downgrade and records the version", () => {
		// Re-announcing every launch would be worse than saying nothing, so the
		// marker moves down to match what is actually running.
		const decision = decideUpdateNotice("3.0.0", "2.0.0");

		expect(decision.installedVersion).toBeUndefined();
		expect(decision.persistCurrentVersion).toBe(true);
	});

	test("treats an unreadable marker as a fresh install", () => {
		const decision = decideUpdateNotice("not-a-version", CURRENT_VERSION);

		expect(decision.installedVersion).toBeUndefined();
		expect(decision.persistCurrentVersion).toBe(true);
	});

	test("does not advance the marker for a non-release build", () => {
		// Advancing to a dev/prerelease string would swallow the notice for the
		// next real release.
		const decision = decideUpdateNotice("1.9.0", "2.0.0-dev.3");

		expect(decision.installedVersion).toBeUndefined();
		expect(decision.persistCurrentVersion).toBe(false);
	});

	test("announces once, then stays quiet on the next launch", () => {
		const first = decideUpdateNotice("1.9.0", CURRENT_VERSION);
		expect(first.installedVersion).toBe(CURRENT_VERSION);

		// The first launch persisted the version, so the second sees a matching marker.
		const second = decideUpdateNotice(CURRENT_VERSION, CURRENT_VERSION);
		expect(second.installedVersion).toBeUndefined();
	});
});

describe("last changelog marker", () => {
	test("reads a missing marker as undefined and writes the current version in the supplied agent dir", async () => {
		await withTempAgentDir(async agentDir => {
			expect(await readLastChangelogVersion(agentDir)).toBeUndefined();

			await writeLastChangelogVersion(CURRENT_VERSION, agentDir);

			expect(await readLastChangelogVersion(agentDir)).toBe(CURRENT_VERSION);
			expect(await Bun.file(path.join(agentDir, "last-changelog-version")).text()).toBe(CURRENT_VERSION);
		});
	});
});

/**
 * compareVersions, parseChangelogVersion, and parseChangelog are the version math and
 * CHANGELOG scanner that decideUpdateNotice and `/changelog` build on. They had no
 * direct coverage. A regression in the scanner would let a `## Unreleased` section (or
 * intro prose above the first release) leak into the rendered notes, and a loose
 * version parse would let a dev/prerelease string be treated as a real release.
 */
describe("compareVersions", () => {
	const v = (major: number, minor: number, patch: number): ChangelogEntry => ({ major, minor, patch, content: "" });
	test("orders by major, then minor, then patch", () => {
		expect(compareVersions(v(2, 0, 0), v(1, 9, 9))).toBe(1);
		expect(compareVersions(v(1, 1, 0), v(1, 2, 0))).toBe(-1);
		expect(compareVersions(v(1, 2, 3), v(1, 2, 3))).toBe(0);
		expect(compareVersions(v(1, 2, 5), v(1, 2, 4))).toBe(1);
	});
});

describe("parseChangelogVersion", () => {
	test("parses a strict x.y.z string and rejects everything else", () => {
		expect(parseChangelogVersion("3.4.5")).toEqual({ major: 3, minor: 4, patch: 5, content: "" });
		expect(parseChangelogVersion("3.4")).toBeUndefined();
		expect(parseChangelogVersion("1.2.3-dev")).toBeUndefined();
		expect(parseChangelogVersion(undefined)).toBeUndefined();
	});
});

describe("parseChangelog", () => {
	test("collects each ## [x.y.z] block and drops content outside a version heading", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-changelog-parse-"));
		try {
			const changelogPath = path.join(dir, "CHANGELOG.md");
			await fs.writeFile(
				changelogPath,
				"# Changelog\n\nintro dropped\n\n## [1.2.0] - 2026\n- feat A\n- feat B\n\n## Unreleased\nignored\n\n## [1.1.0]\n- fix C\n",
			);
			expect(await parseChangelog(changelogPath)).toEqual([
				{ major: 1, minor: 2, patch: 0, content: "## [1.2.0] - 2026\n- feat A\n- feat B" },
				{ major: 1, minor: 1, patch: 0, content: "## [1.1.0]\n- fix C" },
			]);
			expect(await parseChangelog(path.join(dir, "does-not-exist.md"))).toEqual([]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("returns [] for an undefined path", async () => {
		expect(await parseChangelog(undefined)).toEqual([]);
	});
});

describe.skipIf(!hasPtyHarness)("interactive startup changelog PTY smoke", () => {
	test("never renders changelog history on startup (release notes live on the web)", async () => {
		await withTempAgentDir(async agentDir => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-changelog-pty-"));
			try {
				await fs.mkdir(path.join(root, "xdg-config"), { recursive: true });
				await fs.mkdir(path.join(root, "xdg-state"), { recursive: true });
				await fs.mkdir(path.join(root, "xdg-data"), { recursive: true });
				await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 1\n");

				const proc = Bun.spawn(
					["timeout", "6s", "script", "-q", "-c", `bun ${JSON.stringify(cliEntry)}`, "/dev/null"],
					{
						cwd: repoRoot,
						stdout: "pipe",
						stderr: "pipe",
						env: {
							...process.env,
							HOME: root,
							XDG_CONFIG_HOME: path.join(root, "xdg-config"),
							XDG_STATE_HOME: path.join(root, "xdg-state"),
							XDG_DATA_HOME: path.join(root, "xdg-data"),
							VEYYON_CODING_AGENT_DIR: agentDir,
							VEYYON_PACKAGE_DIR: packageDir,
							VEYYON_NO_TITLE: "1",
							NO_COLOR: "1",
							TERM: "xterm-256color",
						},
					},
				);

				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).arrayBuffer(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				const output = Buffer.from(stdout).toString("utf8");

				expect(exitCode).toBe(124);
				expect(Buffer.byteLength(output)).toBeLessThan(PTY_STARTUP_OUTPUT_CEILING);
				// The changelog body is gone from the CLI entirely — no version
				// headers, no "What's New", and no pointer at a `/changelog full`
				// subcommand that does not exist.
				expect(output).not.toContain("## [");
				expect(output).not.toContain("What's New");
				expect(output).not.toContain("/changelog full");
				// A fresh agent dir has no marker, so this is a first install: it
				// records the version silently rather than announcing an update.
				expect(output).not.toContain("Updated to");
				expect(stderr).not.toContain("Cannot find module");
			} finally {
				await removeWithRetries(root);
			}
		});
	}, 15_000);
});
