import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { formatPublishDate, formatReleaseList, runRollbackToVersion } from "@veyyon/coding-agent/cli/rollback-cli";
import {
	canRollbackVia,
	formatInstallCompletion,
	type PackumentShape,
	parseReleaseListings,
	previousVersionFromHistory,
	resolveNpmRegistry,
	rollbackToVersion,
	type UpdateHistoryEntry,
} from "@veyyon/coding-agent/cli/update-cli";
import { rollbackRowDate, rollbackRowLabel } from "@veyyon/coding-agent/modes/components/rollback-picker";
import { APP_NAME, VERSION } from "@veyyon/utils";

/**
 * Rollback surface (GALLERY-unrelated; the `veyyon rollback` / version-picker
 * feature). These lock the PURE pieces the interactive picker and the CLI both
 * depend on, so a regression in version ordering, date parsing, the "current"
 * marker, the brew rollback ban, or the guard rails shows up here with a
 * concrete value rather than as a broken picker no test noticed.
 */

/** A realistic npm packument slice: out-of-order versions, pseudo-keys, junk. */
const PACKUMENT: PackumentShape = {
	versions: {
		"1.9.0": {},
		"1.10.0": {},
		"1.0.12": {},
		"1.0.9": {},
		"2.0.0-rc.1": {},
		"not-a-version": {},
	},
	time: {
		created: "2024-01-01T00:00:00.000Z",
		modified: "2026-07-20T00:00:00.000Z",
		"1.9.0": "2026-06-01T12:00:00.000Z",
		"1.10.0": "2026-07-01T09:30:00.000Z",
		"1.0.12": "2026-05-15T00:00:00.000Z",
		"1.0.9": "2026-04-01T00:00:00.000Z",
		"2.0.0-rc.1": "2026-07-19T00:00:00.000Z",
	},
};

describe("parseReleaseListings", () => {
	it("keeps only semver version keys, dropping created/modified pseudo-keys and junk", () => {
		const versions = parseReleaseListings(PACKUMENT).map(r => r.version);
		expect(versions).not.toContain("not-a-version");
		expect(versions).not.toContain("created");
		expect(versions).not.toContain("modified");
	});

	it("sorts newest-first by SEMVER, not lexicographically (1.10.0 above 1.9.0)", () => {
		const versions = parseReleaseListings(PACKUMENT).map(r => r.version);
		expect(versions).toEqual(["2.0.0-rc.1", "1.10.0", "1.9.0", "1.0.12", "1.0.9"]);
	});

	it("attaches the publish timestamp and tag from the time map", () => {
		const ten = parseReleaseListings(PACKUMENT).find(r => r.version === "1.10.0");
		expect(ten).toBeDefined();
		expect(ten?.tag).toBe("v1.10.0");
		expect(ten?.publishedAt).toBe("2026-07-01T09:30:00.000Z");
	});

	it("returns an empty list for a packument with no versions (never throws)", () => {
		expect(parseReleaseListings({})).toEqual([]);
		expect(parseReleaseListings({ versions: {} })).toEqual([]);
	});

	/**
	 * A stable release outranks its own prerelease: 2.0.0 must sit ABOVE
	 * 2.0.0-rc.1, and 1.5.0 above 1.5.0-beta.2. A rollback list that put the rc
	 * above the final would offer to "roll back" to a preview of a version you
	 * already have — the ordering has to encode release-precedence, not just the
	 * numeric core.
	 */
	it("orders a stable release above its own prerelease", () => {
		const versions = parseReleaseListings({
			versions: { "2.0.0": {}, "2.0.0-rc.1": {}, "1.5.0": {}, "1.5.0-beta.2": {} },
			time: {},
		}).map(r => r.version);
		expect(versions).toEqual(["2.0.0", "2.0.0-rc.1", "1.5.0", "1.5.0-beta.2"]);
	});

	/**
	 * npm's `time` map can lag its `versions` map (a just-published version, or a
	 * mirror that trimmed old timestamps). A version present in `versions` but
	 * absent from `time` must still be listed, with `publishedAt` undefined rather
	 * than crashing or being dropped — a missing date is not a missing version.
	 */
	it("lists a version missing from the time map with an undefined date, never dropping it", () => {
		const listings = parseReleaseListings({
			versions: { "3.1.0": {}, "3.0.0": {} },
			time: { "3.0.0": "2026-01-01T00:00:00.000Z" }, // 3.1.0 has no timestamp
		});
		expect(listings.map(r => r.version)).toEqual(["3.1.0", "3.0.0"]);
		expect(listings.find(r => r.version === "3.1.0")?.publishedAt).toBeUndefined();
		expect(listings.find(r => r.version === "3.0.0")?.publishedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	/** Timestamps present in `time` for pseudo-keys or non-semver junk must never
	 *  leak in as phantom releases; only real version keys drive the list. */
	it("ignores time-map entries that are not real version keys", () => {
		const listings = parseReleaseListings({
			versions: { "1.0.0": {} },
			time: { created: "x", modified: "y", "not-a-version": "z", "1.0.0": "2026-02-02T00:00:00.000Z" },
		});
		expect(listings.map(r => r.version)).toEqual(["1.0.0"]);
	});
});

describe("formatPublishDate", () => {
	it("reduces an ISO-8601 timestamp to its YYYY-MM-DD date", () => {
		expect(formatPublishDate("2026-07-01T09:30:00.000Z")).toBe("2026-07-01");
	});

	it("returns empty for a missing or malformed timestamp rather than a wrong date", () => {
		expect(formatPublishDate(undefined)).toBe("");
		expect(formatPublishDate("last week")).toBe("");
	});
});

describe("formatReleaseList", () => {
	it("renders newest-first with dates and marks exactly the current version", () => {
		const list = formatReleaseList(parseReleaseListings(PACKUMENT), "1.0.12");
		const lines = list.split("\n");
		expect(lines[0]).toBe("2.0.0-rc.1  2026-07-19");
		expect(lines).toContain("1.0.12  2026-05-15  (current)");
		// Exactly one line carries the current marker.
		expect(lines.filter(l => l.includes("(current)"))).toHaveLength(1);
	});

	it("states plainly when there are no versions", () => {
		expect(formatReleaseList([], "1.0.0")).toBe("No published versions found.");
	});
});

describe("canRollbackVia", () => {
	it("permits version-pinnable methods and refuses brew (latest-only formula)", () => {
		expect(canRollbackVia("bun")).toBe(true);
		expect(canRollbackVia("npm")).toBe(true);
		expect(canRollbackVia("mise")).toBe(true);
		expect(canRollbackVia("binary")).toBe(true);
		expect(canRollbackVia("brew")).toBe(false);
	});
});

describe("rollbackToVersion guards (before any install)", () => {
	it("refuses a non-semver target loudly", async () => {
		await expect(rollbackToVersion("banana")).rejects.toThrow(/Not a valid version to roll back to: banana/);
	});

	it("refuses rolling back to the version already running", async () => {
		await expect(rollbackToVersion(VERSION)).rejects.toThrow(new RegExp(`Already on veyyon ${VERSION}`));
	});
});

/**
 * The current/previous marker rides the LEFT label, not the right-aligned date,
 * so the narrow description column can never clip it (a real bug the first
 * screenshot caught: "· current" was truncated to "· "). The date stays the
 * right-hand description on its own.
 */
describe("rollbackRowLabel", () => {
	const release = { version: "1.0.12", tag: "v1.0.12", publishedAt: "2026-05-15T00:00:00.000Z" };

	it("is the bare version for an ordinary row", () => {
		expect(rollbackRowLabel(release, "2.0.0", undefined)).toBe("1.0.12");
	});

	it("marks the current version in the label", () => {
		expect(rollbackRowLabel(release, "1.0.12", undefined)).toBe("1.0.12 · current");
	});

	it("marks the previous version when it is not the current one", () => {
		expect(rollbackRowLabel(release, "2.0.0", "1.0.12")).toBe("1.0.12 · previous");
	});

	it("prefers the current marker when a version is somehow both", () => {
		expect(rollbackRowLabel(release, "1.0.12", "1.0.12")).toBe("1.0.12 · current");
	});
});

describe("rollbackRowDate", () => {
	it("formats the publish timestamp as YYYY-MM-DD", () => {
		expect(rollbackRowDate({ version: "1.0.12", tag: "v1.0.12", publishedAt: "2026-05-15T09:30:00.000Z" })).toBe(
			"2026-05-15",
		);
	});

	it("is undefined when the registry reported no date", () => {
		expect(rollbackRowDate({ version: "1.0.12", tag: "v1.0.12" })).toBeUndefined();
	});
});

/**
 * The `previous` marker is only trustworthy if it names the version the install
 * was actually on before the current one. These lock that it reads the newest
 * transition INTO the current version (not just the newest transition, which
 * could be a later forward-update), and that a fresh install with no such record
 * has no previous version rather than a wrong one.
 */
describe("previousVersionFromHistory", () => {
	const at = "2026-05-15T00:00:00.000Z";

	it("returns the from of the newest transition that landed on current", () => {
		const history: UpdateHistoryEntry[] = [
			{ from: "1.0.9", to: "1.0.10", at },
			{ from: "1.0.10", to: "1.0.12", at },
		];
		// Current is 1.0.12; the step that reached it came from 1.0.10.
		expect(previousVersionFromHistory(history, "1.0.12")).toBe("1.0.10");
	});

	it("ignores transitions that did not land on the current version", () => {
		const history: UpdateHistoryEntry[] = [
			{ from: "1.0.10", to: "1.0.12", at },
			{ from: "1.0.12", to: "2.0.0", at }, // a later forward-update, then rolled back
		];
		// Running 1.0.12 again: the relevant step is the one that reached 1.0.12,
		// not the newest row overall (which reached 2.0.0).
		expect(previousVersionFromHistory(history, "1.0.12")).toBe("1.0.10");
	});

	it("has no previous version on a fresh install", () => {
		expect(previousVersionFromHistory([], "1.0.12")).toBeUndefined();
	});

	it("does not report the current version as its own previous", () => {
		// A malformed self-transition must never mark current as previous.
		const history: UpdateHistoryEntry[] = [{ from: "1.0.12", to: "1.0.12", at }];
		expect(previousVersionFromHistory(history, "1.0.12")).toBeUndefined();
	});
});

/**
 * The registry origin is a single resolver so the version list the picker shows
 * and the catalog the install pulls from can never disagree. It honors a
 * VEYYON_NPM_REGISTRY override (mirror / air-gap / test fixture) and always
 * yields a trailing slash so callers append the package name directly.
 */
describe("resolveNpmRegistry", () => {
	const original = process.env.VEYYON_NPM_REGISTRY;
	const restore = () => {
		if (original === undefined) delete process.env.VEYYON_NPM_REGISTRY;
		else process.env.VEYYON_NPM_REGISTRY = original;
	};

	it("defaults to the official registry when unset", () => {
		delete process.env.VEYYON_NPM_REGISTRY;
		expect(resolveNpmRegistry()).toBe("https://registry.npmjs.org/");
		restore();
	});

	it("uses the override and normalizes a missing trailing slash", () => {
		process.env.VEYYON_NPM_REGISTRY = "http://127.0.0.1:4873";
		// No trailing slash in → one out, so `${registry}${PACKAGE}` is well-formed.
		expect(resolveNpmRegistry()).toBe("http://127.0.0.1:4873/");
		restore();
	});

	it("ignores a blank override", () => {
		process.env.VEYYON_NPM_REGISTRY = "   ";
		expect(resolveNpmRegistry()).toBe("https://registry.npmjs.org/");
		restore();
	});
});

describe("formatInstallCompletion", () => {
	/**
	 * The bug this locks out: rolling back to an older version printed
	 * "Updated to X" because the success line lived in the shared update path and
	 * knew only one verb. A rollback moves BACKWARD, so its completion must read
	 * "Rolled back to X"; an update must still read "Updated to X". The verb is
	 * the whole point of threading the action through the one completion owner.
	 */
	it("uses 'Rolled back to' for a rollback and 'Updated to' for an update", () => {
		expect(formatInstallCompletion("1.0.10", "rollback").success).toBe(`Rolled back to ${APP_NAME} 1.0.10`);
		expect(formatInstallCompletion("1.0.13", "update").success).toBe(`Updated to ${APP_NAME} 1.0.13`);
	});

	/**
	 * Every method (bun/npm/brew/mise/binary) and both flows now end with the
	 * restart reminder, not only the binary path as before. The running process
	 * keeps the old version until relaunch, so the reminder must always be there.
	 */
	it("always includes the restart reminder, regardless of action", () => {
		expect(formatInstallCompletion("1.0.10", "rollback").restart).toBe(`Restart ${APP_NAME} to use it`);
		expect(formatInstallCompletion("1.0.13", "update").restart).toBe(`Restart ${APP_NAME} to use it`);
	});

	/** The exact target version appears in the success line for both actions, so
	 *  the operator can confirm which version landed. */
	it("names the exact target version in the success line", () => {
		expect(formatInstallCompletion("1.0.9", "rollback").success).toContain("1.0.9");
		expect(formatInstallCompletion("2.4.1", "update").success).toContain("2.4.1");
	});
});

describe("runRollbackToVersion (scriptable `veyyon rollback <version>`)", () => {
	// getAllReleases is driven by a mocked registry fetch; the packument always
	// includes the running VERSION so "valid" and "unknown" are both exercised
	// without a real install. process.exitCode is a global side effect, so reset
	// it after each case.
	const packument = (versions: string[]) =>
		Response.json({ versions: Object.fromEntries(versions.map(v => [v, {}])), time: {} });

	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore?.();
		process.exitCode = 0;
	});

	/**
	 * A typo must fail loudly and NEVER reach the installer: an unknown version
	 * exits non-zero, names the bad version, and points at `--list`. The absence
	 * of any installer/guard message proves the version check short-circuited
	 * before rollbackToVersion.
	 */
	it("rejects an unknown version with a --list pointer and exit code 1, before any install", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(packument([VERSION, "1.0.9"]));
		const errs: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(((s: string) => {
			errs.push(String(s));
			return true;
		}) as never);

		await runRollbackToVersion("9.9.9");

		expect(process.exitCode).toBe(1);
		const combined = errs.join("");
		expect(combined).toContain("Unknown version '9.9.9'");
		expect(combined).toContain("rollback --list");
		// It never reached rollbackToVersion, so no install/guard message appears.
		expect(combined).not.toContain("Already on");
		stderr.mockRestore();
	});

	/**
	 * A version that IS in the published set is handed to rollbackToVersion. Using
	 * the currently-running VERSION lets us prove the hand-off happened (its
	 * no-op guard fires with "Already on …") without performing a real install.
	 */
	it("hands a known version to rollbackToVersion (proven via the current-version guard)", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(packument([VERSION, "1.0.9"]));
		const errs: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(((s: string) => {
			errs.push(String(s));
			return true;
		}) as never);

		await runRollbackToVersion(VERSION);

		expect(process.exitCode).toBe(1);
		// The message is rollbackToVersion's own no-op guard, so control reached it.
		expect(errs.join("")).toContain(`Already on ${APP_NAME} ${VERSION}`);
		stderr.mockRestore();
	});
});
