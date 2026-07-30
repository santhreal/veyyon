/**
 * The release catalog and the guards around moving between versions.
 *
 * Rollback is the one command that can move an install BACKWARD, so every way it
 * can be quietly wrong is a way to strand somebody on a version they did not
 * choose. The three failure shapes these tests exist to lock out:
 *
 *   1. A SHORT OR EMPTY list. A picker showing five versions when fifty are
 *      published looks like a working picker. So the listing must page, must
 *      sort newest-first by semver rather than by the order GitHub returned, and
 *      must throw rather than return `[]`.
 *   2. A version that is not installable being offered. Drafts and prereleases
 *      are excluded by `releases/latest`, so offering them here would let you
 *      roll INTO a version `veyyon update` immediately rolls you out of.
 *   3. A refusal that is not a refusal. A method that cannot pin a version must
 *      fail loudly, never reinstall latest and print success (Law 10).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	getAllReleases,
	isRollbackSupported,
	readVersionMoves,
	recordVersionMove,
	rollbackToVersion,
	rollbackUnsupportedReason,
} from "@veyyon/coding-agent/cli/update-cli";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface FakeRelease {
	tag_name: string;
	draft?: boolean;
	prerelease?: boolean;
	published_at?: string;
}

/** Serve the given pages in order, then empty pages, recording the URLs asked for. */
function serveReleasePages(pages: FakeRelease[][]): { urls: string[] } {
	const urls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		const url = String(input);
		urls.push(url);
		const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
		const body = pages[page - 1] ?? [];
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { urls };
}

describe("getAllReleases", () => {
	it("returns every published version, newest first by semver", async () => {
		// GitHub returns creation order, which is NOT semver order once a patch is
		// cut on an older line. Sorting by what arrived would put 1.9.0 above 1.10.0
		// and offer the wrong "previous version".
		serveReleasePages([[{ tag_name: "v1.9.0" }, { tag_name: "v1.10.0" }, { tag_name: "v1.2.3" }]]);

		const releases = await getAllReleases();

		expect(releases.map(r => r.version)).toEqual(["1.10.0", "1.9.0", "1.2.3"]);
	});

	it("carries the publish date and the v-prefixed tag", async () => {
		serveReleasePages([[{ tag_name: "v2.0.1", published_at: "2026-03-04T05:06:07Z" }]]);

		const [release] = await getAllReleases();

		expect(release).toEqual({ tag: "v2.0.1", version: "2.0.1", publishedAt: "2026-03-04T05:06:07Z" });
	});

	it("normalizes a tag published without the v prefix", async () => {
		// Both spellings exist in real release histories, and a picker that shows
		// one row as `1.0.0` and another as `v1.0.0` looks like two versions.
		serveReleasePages([[{ tag_name: "3.1.0" }]]);

		expect((await getAllReleases())[0]).toMatchObject({ tag: "v3.1.0", version: "3.1.0" });
	});

	it("excludes drafts and prereleases, which `veyyon update` would not install", async () => {
		serveReleasePages([
			[{ tag_name: "v5.0.0", draft: true }, { tag_name: "v4.9.0", prerelease: true }, { tag_name: "v4.8.0" }],
		]);

		expect((await getAllReleases()).map(r => r.version)).toEqual(["4.8.0"]);
	});

	it("skips one unusable tag instead of losing the whole history", async () => {
		// A single mis-tagged release (`nightly`, `release-2024`) is somebody's old
		// mistake. Throwing on it would deny every other version for no reason.
		serveReleasePages([[{ tag_name: "nightly" }, { tag_name: "v1.1.0" }, { tag_name: "" }]]);

		expect((await getAllReleases()).map(r => r.version)).toEqual(["1.1.0"]);
	});

	it("keeps paging while a full page comes back", async () => {
		const full = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v2.0.${99 - i}` }));
		const { urls } = serveReleasePages([full, [{ tag_name: "v1.0.0" }]]);

		const releases = await getAllReleases();

		expect(releases.length).toBe(101);
		expect(releases[releases.length - 1]?.version).toBe("1.0.0");
		expect(urls[0]).toContain("page=1");
		expect(urls[1]).toContain("page=2");
	});

	/**
	 * Filtering is not pagination. GitHub can return a full raw page containing a
	 * draft, prerelease, or malformed tag; the next page still exists even though
	 * only 99 installable rows survive locally.
	 */
	it("keeps paging when filtering makes a full raw page look short", async () => {
		const rawFull = [
			{ tag_name: "v3.0.0", prerelease: true },
			...Array.from({ length: 99 }, (_, i) => ({ tag_name: `v2.0.${98 - i}` })),
		];
		const { urls } = serveReleasePages([rawFull, [{ tag_name: "v1.0.0" }]]);

		const versions = (await getAllReleases()).map(release => release.version);

		expect(versions).toContain("1.0.0");
		expect(urls.map(url => /[?&]page=(\d+)/.exec(url)?.[1])).toEqual(["1", "2"]);
	});

	it("stops paging on the first short page", async () => {
		// A short page means the end of the list. Continuing would spend a request
		// per empty page against a rate-limited API on every single launch.
		const { urls } = serveReleasePages([[{ tag_name: "v1.0.0" }]]);

		await getAllReleases();

		expect(urls.length).toBe(1);
	});

	it("keeps the first sighting when a tag repeats across pages", async () => {
		// Publishing a release mid-walk shifts the pagination window and re-serves
		// an entry. A duplicated row in a picker is a version you can select twice.
		const full = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v3.0.${99 - i}` }));
		serveReleasePages([full, [{ tag_name: "v3.0.99" }, { tag_name: "v1.0.0" }]]);

		const versions = (await getAllReleases()).map(r => r.version);

		expect(versions.filter(v => v === "3.0.99").length).toBe(1);
	});

	it("throws rather than returning an empty list", async () => {
		// This is the whole point: `[]` renders as a picker with nothing in it,
		// which reads as "there is nothing to roll back to" rather than "the
		// request did not work".
		serveReleasePages([[]]);

		expect(getAllReleases()).rejects.toThrow(/No published releases/);
	});

	/**
	 * The version list is the ONLY thing that still spends the GitHub API budget:
	 * the startup check and `veyyon update` resolve their version from a redirect
	 * on `github.com`, which is not on that budget. So a rate limit here means the
	 * picker is unavailable and updating forward still works, and the message has
	 * to say so — otherwise it reads as "veyyon cannot reach GitHub" and the user
	 * stops trying. It also has to say the limit belongs to the ADDRESS, since the
	 * traffic that spent it was probably not theirs.
	 */
	it("names the rate limit when GitHub returns 403, and what still works", async () => {
		globalThis.fetch = (async () =>
			new Response("", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;

		expect(getAllReleases()).rejects.toThrow(/rate-limiting this address/);
		expect(getAllReleases()).rejects.toThrow(/per address and shared/);
		expect(getAllReleases()).rejects.toThrow(/`veyyon update`, which does not use the API/);
	});

	it("reports the status for any other failure", async () => {
		globalThis.fetch = (async () =>
			new Response("", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;

		expect(getAllReleases()).rejects.toThrow(/HTTP 500 Server Error/);
	});

	it("refuses a response that is not a list", async () => {
		// A proxy or captive portal answering with an HTML page or an object would
		// otherwise flow into `.flatMap` on a non-array and fail somewhere less
		// legible than the fetch that caused it.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "Not Found" }), { status: 200 })) as unknown as typeof fetch;

		expect(getAllReleases()).rejects.toThrow(/Expected a list of releases/);
	});
});

describe("rollbackUnsupportedReason", () => {
	it("allows a binary install, which downloads the exact tag", () => {
		expect(rollbackUnsupportedReason("binary")).toBeUndefined();
	});

	it("refuses a source install and says why fast-forward cannot go back", () => {
		// The refusal has to teach, not just deny: the reason a source checkout
		// cannot roll back is structural, and a bare "not supported" would read as
		// an oversight somebody should file a bug about.
		const reason = rollbackUnsupportedReason("source");

		expect(reason).toContain("source install");
		expect(reason).toContain("fast-forward");
		expect(reason).toContain("install script");
	});
});

describe("isRollbackSupported", () => {
	it("says yes for a binary install", async () => {
		expect(await isRollbackSupported(async () => "binary")).toBe(true);
	});

	it("says no for a source checkout", async () => {
		// This is what keeps the `/settings` row off a source install. The row's
		// own contract is that it appears ONLY where it can do something: a row
		// that opens a picker and then refuses to install reads as broken rather
		// than as inapplicable.
		expect(await isRollbackSupported(async () => "source")).toBe(false);
	});

	it("says yes when the install method cannot be determined", async () => {
		// Deliberate, and the opposite of what a "fail closed" reflex suggests.
		// Hiding the row on a lookup failure removes a working feature and leaves
		// the operator nothing to act on; letting them try surfaces the real
		// reason loudly instead (Law 10).
		expect(
			await isRollbackSupported(async () => {
				throw new Error("no veyyon on PATH");
			}),
		).toBe(true);
	});
});

describe("rollbackToVersion guards", () => {
	it("refuses a string that is not a version", async () => {
		expect(rollbackToVersion("latest", () => {}, "1.0.0")).rejects.toThrow(/not a version number/);
	});

	it("refuses rolling back to the version already running", async () => {
		// A reinstall that changes nothing and prints success reads exactly like a
		// rollback that worked, so somebody debugging keeps reporting the same bug
		// against the version they thought they had left.
		expect(rollbackToVersion("1.4.2", () => {}, "1.4.2")).rejects.toThrow(/Already running 1\.4\.2/);
	});

	it("points at the list when it refuses", async () => {
		expect(rollbackToVersion("1.4.2", () => {}, "1.4.2")).rejects.toThrow(/rollback --list/);
	});
});

describe("version move history", () => {
	// The history file's PARENT is what leaks here: `recordVersionMove` creates the
	// directory on the way to writing the file, and this used to hand it a path under
	// `os.tmpdir()` that nothing ever deleted, one per case. Making the directory up
	// front through the tracked factory means the same path is used and the same code
	// path is exercised, and the directory goes away with the file.
	const makeHistoryDir = useTrackedTempDirs("veyyon-rollback-history-");

	function tempHistory(): string {
		return path.join(makeHistoryDir(), "update-history.json");
	}

	it("records a move and reads it back whole", async () => {
		const historyPath = tempHistory();
		await recordVersionMove({ from: "1.2.0", to: "1.1.0", at: "2026-07-25T00:00:00.000Z" }, historyPath);

		expect(await readVersionMoves(historyPath)).toEqual([
			{ from: "1.2.0", to: "1.1.0", at: "2026-07-25T00:00:00.000Z" },
		]);
	});

	it("appends rather than replacing, so the trail survives", async () => {
		// The picker's "previously run" marker is only useful across several moves.
		const historyPath = tempHistory();
		await recordVersionMove({ from: "1.2.0", to: "1.1.0", at: "2026-07-25T00:00:00.000Z" }, historyPath);
		await recordVersionMove({ from: "1.1.0", to: "1.3.0", at: "2026-07-25T01:00:00.000Z" }, historyPath);

		expect((await readVersionMoves(historyPath)).map(entry => entry.to)).toEqual(["1.1.0", "1.3.0"]);
	});

	it("reads a missing history as no moves, not as an error", async () => {
		// Never having rolled back is the normal state, and it must not make the
		// picker fail to open.
		expect(await readVersionMoves(tempHistory())).toEqual([]);
	});

	it("starts a new list over a corrupt file instead of refusing forever", async () => {
		// A half-written file must not permanently break recording; the warning is
		// what makes it non-silent.
		const historyPath = tempHistory();
		await Bun.write(historyPath, "{not json");
		await recordVersionMove({ from: "2.0.0", to: "1.9.0", at: "2026-07-25T02:00:00.000Z" }, historyPath);

		expect((await readVersionMoves(historyPath)).map(entry => entry.from)).toEqual(["2.0.0"]);
	});
});
