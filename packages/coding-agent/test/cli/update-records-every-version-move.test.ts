/**
 * Every version this install moves to is recorded, not only the ones it moved
 * BACK to.
 *
 * WHY THIS SUITE EXISTS. `recordVersionMove` was called from exactly one place,
 * `rollbackToVersion`, so the history file held rollbacks and nothing else. An
 * update that took you from 1.0.30 to 1.0.37 left no trace, which makes the
 * history a record of the times you went backwards rather than of the versions
 * you have run — and the rollback picker reads it to mark rows "previously run",
 * so the version a user is trying to get back to was the one guaranteed not to
 * be marked. The recording moved into `installRelease`, which is the single
 * owner of the install-method dispatch and therefore the one function that sees
 * every move, whether it came from `veyyon update`, the background auto-update,
 * or `veyyon rollback`.
 *
 * These tests drive the real pipeline through the same seams the end-to-end
 * install suite uses (`$which` pointing at a temp binary, `fetch` serving real
 * bytes and a real sha256 sidecar) so what is asserted is what a version move
 * actually writes to disk, not what a mock was told to write.
 *
 * Skipped on Windows: the stand-in binaries are `#!/bin/sh` scripts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installRelease, readVersionMoves, rollbackToVersion } from "@veyyon/coding-agent/cli/update-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as veyUtils from "@veyyon/utils";

const isWindows = process.platform === "win32";

beforeAll(async () => {
	// The success reporter renders a themed status glyph; without an initialized
	// theme the happy path throws before it can record anything.
	await Settings.init({ inMemory: true });
	await initTheme();
});

const tempDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-version-moves-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * A stand-in veyyon that answers both probes the swap makes.
 *
 * `--version` is not enough on its own: a release built for the wrong platform
 * reports its version perfectly and cannot search, so the installer also runs a
 * real `grep` through the swapped file. A stub that only echoed a version would
 * be rolled back, and this suite would be measuring the self-test instead of the
 * recording.
 */
function fakeBinaryScript(version: string): string {
	return [
		"#!/bin/sh",
		'if [ "$1" = "grep" ]; then',
		"  shift",
		'  [ "$1" = "--help" ] && exit 0',
		'  pattern="$1"',
		"  shift",
		'  exec grep -rl "$pattern" "$@"',
		"fi",
		`echo "veyyon/${version}"`,
		"",
	].join("\n");
}

function sha256Hex(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

/** The platform asset name the updater resolves on this host. */
function binaryName(): string {
	const osName = process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `veyyon-${osName}-${arch}`;
}

interface MoveHarness {
	targetPath: string;
	historyPath: string;
}

/**
 * An installed binary on a fake PATH plus a release server for `versions`.
 *
 * Every requested version is served, so one harness can perform several moves in
 * a row and the history can be read as the path the install actually took.
 * Anything not offered 404s, so an unexpected request fails loudly rather than
 * reaching the network.
 */
async function makeHarness(versions: readonly string[]): Promise<MoveHarness> {
	const dir = await makeTempDir();
	const targetPath = path.join(dir, "veyyon");
	await fs.writeFile(targetPath, fakeBinaryScript("1.0.0"), { mode: 0o755 });

	vi.spyOn(veyUtils, "$which").mockImplementation(bin => (bin === "veyyon" ? targetPath : null));

	const asset = binaryName();
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		for (const version of versions) {
			const body = fakeBinaryScript(version);
			if (url.endsWith(`/v${version}/${asset}.sha256`)) return new Response(`${sha256Hex(body)}  ${asset}\n`);
			if (url.endsWith(`/v${version}/${asset}`)) return new Response(body);
		}
		return new Response("Not Found", { status: 404, statusText: "Not Found" });
	}) as typeof fetch);

	return { targetPath, historyPath: path.join(dir, "history.json") };
}

describe.skipIf(isWindows)("installRelease records the move", () => {
	/**
	 * The bug this suite exists for. An ordinary forward update is a version move,
	 * and before the fix it wrote nothing at all: the history only ever grew when
	 * someone rolled back.
	 */
	it("records a forward update, which used to leave no trace", async () => {
		const harness = await makeHarness(["2.0.0"]);

		await installRelease("2.0.0", false, () => {}, "1.0.0", harness.historyPath);

		const moves = await readVersionMoves(harness.historyPath);
		expect(moves.map(move => ({ from: move.from, to: move.to }))).toEqual([{ from: "1.0.0", to: "2.0.0" }]);
	});

	/** The timestamp is ISO 8601, so a reader does not need the writer's locale. */
	it("stamps the move with a parseable ISO 8601 instant", async () => {
		const harness = await makeHarness(["2.0.0"]);

		await installRelease("2.0.0", false, () => {}, "1.0.0", harness.historyPath);

		const [move] = await readVersionMoves(harness.historyPath);
		expect(move?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Number.isNaN(new Date(move?.at ?? "").getTime())).toBe(false);
	});

	/**
	 * `veyyon update --force` reinstalls the version already running. That is not a
	 * move, and a history of `2.0.0 -> 2.0.0` rows describes nothing while pushing
	 * the real moves out of view.
	 */
	it("does not record a forced reinstall of the version already running", async () => {
		const harness = await makeHarness(["2.0.0"]);

		await installRelease("2.0.0", true, () => {}, "2.0.0", harness.historyPath);

		expect(await readVersionMoves(harness.historyPath)).toEqual([]);
	});

	/**
	 * A move that failed did not happen. Recording it would make the picker offer
	 * to return you to a version you were never on.
	 */
	it("records nothing when the install fails", async () => {
		// 3.0.0 is not served, so the download 404s and the swap never runs.
		const harness = await makeHarness(["2.0.0"]);

		await expect(installRelease("3.0.0", false, () => {}, "1.0.0", harness.historyPath)).rejects.toThrow();

		expect(await readVersionMoves(harness.historyPath)).toEqual([]);
	});

	/**
	 * The history is the sequence of versions this install has been on, so several
	 * moves accumulate in the order they happened rather than replacing each other.
	 */
	it("appends successive moves oldest first", async () => {
		const harness = await makeHarness(["2.0.0", "3.0.0"]);

		await installRelease("2.0.0", false, () => {}, "1.0.0", harness.historyPath);
		await installRelease("3.0.0", false, () => {}, "2.0.0", harness.historyPath);

		const moves = await readVersionMoves(harness.historyPath);
		expect(moves.map(move => `${move.from}->${move.to}`)).toEqual(["1.0.0->2.0.0", "2.0.0->3.0.0"]);
	});
});

describe.skipIf(isWindows)("rollbackToVersion records exactly one move", () => {
	/**
	 * `rollbackToVersion` recorded the move itself and then delegated the install
	 * to `installRelease`. Once the recording moved into `installRelease`, leaving
	 * the original call in place would file every rollback twice, which reads in
	 * the picker as having run the version on two separate occasions.
	 */
	it("files one entry, not two, for a single rollback", async () => {
		const harness = await makeHarness(["1.5.0"]);

		await rollbackToVersion("1.5.0", () => {}, "2.0.0", harness.historyPath);

		const moves = await readVersionMoves(harness.historyPath);
		expect(moves.map(move => `${move.from}->${move.to}`)).toEqual(["2.0.0->1.5.0"]);
	});

	/**
	 * Going forward and then back is the sequence the picker's "previously run"
	 * markers are built from, and it only reads correctly if both directions are
	 * recorded by the same owner.
	 */
	it("keeps an update and the rollback that undoes it in one history", async () => {
		const harness = await makeHarness(["2.0.0", "1.0.0"]);

		await installRelease("2.0.0", false, () => {}, "1.0.0", harness.historyPath);
		await rollbackToVersion("1.0.0", () => {}, "2.0.0", harness.historyPath);

		const moves = await readVersionMoves(harness.historyPath);
		expect(moves.map(move => `${move.from}->${move.to}`)).toEqual(["1.0.0->2.0.0", "2.0.0->1.0.0"]);
	});
});
