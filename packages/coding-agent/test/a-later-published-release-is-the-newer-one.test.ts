/**
 * Releases are ordered by publication date, not semantic version numbers.
 *
 * WHY THIS EXISTS. Releases were previously ordered by comparing semver strings
 * numerically. A project resetting its version line (for example cutting v0.0.1
 * after v1.4.0) caused update checks, auto-update, update dispatch, release listing,
 * and rollback row construction to judge the new release as "older" than the running
 * build, refusing updates and mis-ranking rollback rows.
 *
 * THE CLASS: every surface deciding whether a release is newer, latest, previous,
 * or where you stand in release history must compare publication timestamps rather
 * than version numbers. Version strings are labels.
 *
 * WHAT THIS DOES NOT CATCH: non-product scripts or third-party package managers
 * that independently sort semver numbers.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkForNewVersion } from "../src/main";
import { buildRollbackRows } from "../src/cli/rollback-cli";
import { getAllReleases, runAutoUpdate, runUpdateCommand } from "../src/cli/update-cli";
import { Settings } from "../src/config/settings";

const realFetch = globalThis.fetch;
let tempDir = "";

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-pubdate-test-"));
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function stubGithubRedirect(version: string): void {
	globalThis.fetch = (async () =>
		new Response(null, {
			status: 302,
			headers: { location: `https://github.com/santhreal/veyyon/releases/tag/v${version}` },
		})) as unknown as typeof fetch;
}

describe("startup update check: checkForNewVersion", () => {
	it("offers 0.0.1 as an update when running 1.4.0", async () => {
		stubGithubRedirect("0.0.1");

		const release = await checkForNewVersion("1.4.0");

		expect(release).toEqual({ tag: "v0.0.1", version: "0.0.1" });
	});

	it("returns undefined when the latest release matches the running version", async () => {
		stubGithubRedirect("1.4.0");

		const release = await checkForNewVersion("1.4.0");

		expect(release).toBeUndefined();
	});
});

describe("auto-update: runAutoUpdate", () => {
	it("attempts update when latest release is 0.0.1 over running 1.4.0", async () => {
		const installed: string[] = [];
		const outcome = await runAutoUpdate(
			"1.4.0",
			{ tag: "v0.0.1", version: "0.0.1" },
			path.join(tempDir, "auto-update.json"),
			() => "binary",
			async (version) => {
				installed.push(version);
				return { warnings: [] };
			},
		);

		expect(outcome.status).toBe("updated");
		expect(installed).toEqual(["0.0.1"]);
	});

	it("returns up-to-date when latest release is equal to running version", async () => {
		const installed: string[] = [];
		const outcome = await runAutoUpdate(
			"1.4.0",
			{ tag: "v1.4.0", version: "1.4.0" },
			path.join(tempDir, "auto-update.json"),
			() => "binary",
			async (version) => {
				installed.push(version);
				return { warnings: [] };
			},
		);

		expect(outcome.status).toBe("up-to-date");
		expect(installed).toEqual([]);
	});
});

describe("update command: runUpdateCommand", () => {
	it("installs 0.0.1 when latest release is 0.0.1 and running version is not 0.0.1", async () => {
		const logs: string[] = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		stubGithubRedirect("0.0.1");
		const installed: string[] = [];

		await runUpdateCommand({ force: false, check: false }, async (version) => {
			installed.push(version);
		});

		// When VERSION is 1.4.0 and latest is 0.0.1, it announces new version and installs
		expect(installed).toEqual(["0.0.1"]);
		expect(logs.join("\n")).toContain("New version available: 0.0.1");
	});
});

describe("release catalog: getAllReleases", () => {
	it("orders 0.0.1 published later above 1.4.0 published earlier", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{ tag_name: "v1.4.0", published_at: "2026-08-01T00:00:00Z" },
					{ tag_name: "v0.0.1", published_at: "2026-09-01T00:00:00Z" },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		const releases = await getAllReleases();

		expect(releases.map((r) => r.version)).toEqual(["0.0.1", "1.4.0"]);
	});

	it("preserves API order for undated entries", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{ tag_name: "v1.4.0" },
					{ tag_name: "v0.0.1" },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		const releases = await getAllReleases();

		expect(releases.map((r) => r.version)).toEqual(["1.4.0", "0.0.1"]);
	});
});

describe("rollback rows: buildRollbackRows", () => {
	const releases = [
		{ tag: "v0.0.1", version: "0.0.1", publishedAt: "2026-09-01T00:00:00Z" },
		{ tag: "v1.4.0", version: "1.4.0", publishedAt: "2026-08-01T00:00:00Z" },
		{ tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-07-01T00:00:00Z" },
	];

	it("marks 0.0.1 newer than running 1.4.0 when its published date is later", () => {
		const rows = buildRollbackRows(releases, "1.4.0");
		const row001 = rows.find((r) => r.version === "0.0.1");
		const row140 = rows.find((r) => r.version === "1.4.0");
		const row130 = rows.find((r) => r.version === "1.3.0");

		expect(row001?.newer).toBe(true);
		expect(row140?.newer).toBe(false);
		expect(row130?.newer).toBe(false);
	});

	it("never marks any release newer when the running version is absent from the catalog", () => {
		const rows = buildRollbackRows(releases, "2.0.0");

		for (const row of rows) {
			expect(row.newer).toBe(false);
		}
	});

	it("never marks a release newer when its publishedAt or the running version's publishedAt is missing", () => {
		const mixedReleases = [
			{ tag: "v0.0.1", version: "0.0.1" },
			{ tag: "v1.4.0", version: "1.4.0" },
		];
		const rows = buildRollbackRows(mixedReleases, "1.4.0");

		for (const row of rows) {
			expect(row.newer).toBe(false);
		}
	});
});
