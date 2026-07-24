/**
 * End-to-end coverage of `installRelease` — the full self-update pipeline:
 * resolve target from PATH → download the release binary → verify the .sha256
 * sidecar → swap atomically with backup → subprocess `--version` verification
 * → stale-backup sweep → "Checksum verified" / "Updated to X" reporting.
 *
 * Why this suite exists: every PIECE of the pipeline had unit tests
 * (verifyDownloadChecksum, parseSha256Sidecar, replaceBinaryForUpdate,
 * formatBinaryDownloadFailure), but nothing proved the WIRING — that the
 * checksum gate sits before the swap, that each failure path removes the
 * partial download and leaves the installed binary untouched, and that the
 * success path actually reports the security gate ran. A mis-ordered pipeline
 * (swap before verify) would pass every unit test and ship a tampered binary.
 *
 * The seams are exactly the real ones: `$which` is spied to point PATH at a
 * temp "installed" script, `fetch` is mocked per-URL with real bytes and a
 * real sha256 sidecar, and the post-swap `--version` check runs the swapped
 * file as a genuine subprocess. Skipped on Windows: the fake binaries are
 * `#!/bin/sh` scripts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installRelease } from "@veyyon/coding-agent/cli/update-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as veyUtils from "@veyyon/utils";

const isWindows = process.platform === "win32";

beforeAll(async () => {
	// The success reporter renders `theme.status.success`; without an initialized
	// theme the happy path crashes before it can report.
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-install-release-e2e-"));
	tempDirs.push(dir);
	return dir;
}

/** An executable stand-in for a veyyon binary reporting `veyyon/<version>`. */
function fakeBinaryScript(version: string): string {
	return `#!/bin/sh\necho "veyyon/${version}"\n`;
}

function sha256Hex(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

/** The platform asset name `getBinaryName()` resolves on this host. */
function binaryName(): string {
	const osName = process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `veyyon-${osName}-${arch}`;
}

interface InstallHarness {
	targetPath: string;
	reported: string[];
	fetched: string[];
	run(version: string): Promise<void>;
}

/**
 * Stand up the full harness: an "installed" old binary on a fake PATH, and a
 * fetch mock serving `responses` keyed by URL suffix (the binary asset name or
 * `<asset>.sha256`). Unknown URLs 404 so an unexpected request fails loudly
 * instead of hitting the network.
 */
async function makeHarness(responses: Record<string, Response | (() => Response)>): Promise<InstallHarness> {
	const dir = await makeTempDir();
	const targetPath = path.join(dir, "veyyon");
	await fs.writeFile(targetPath, fakeBinaryScript("1.0.0"), { mode: 0o755 });

	vi.spyOn(veyUtils, "$which").mockImplementation(bin => (bin === "veyyon" ? targetPath : null));

	const fetched: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		fetched.push(url);
		for (const [suffix, resp] of Object.entries(responses)) {
			if (url.endsWith(suffix)) return typeof resp === "function" ? resp() : resp.clone();
		}
		return new Response("Not Found", { status: 404, statusText: "Not Found" });
	}) as typeof fetch);

	const reported: string[] = [];
	return {
		targetPath,
		reported,
		fetched,
		run: version => installRelease(version, false, line => reported.push(line)),
	};
}

describe.skipIf(isWindows)("installRelease end to end (binary self-update pipeline)", () => {
	/** The whole happy path in one pass: the downloaded script replaces the old
	 * binary on disk, the swapped file's own `--version` subprocess output is
	 * what proves the install, and the reporter narrates the checksum gate and
	 * the final version. */
	it("downloads, checksum-verifies, swaps, and subprocess-verifies the new version", async () => {
		const asset = binaryName();
		const newBinary = fakeBinaryScript("9.9.9");
		const harness = await makeHarness({
			[`${asset}.sha256`]: new Response(`${sha256Hex(newBinary)}  ${asset}\n`),
			[asset]: new Response(newBinary),
		});

		await harness.run("9.9.9");

		// The installed file is byte-for-byte the downloaded release.
		expect(await fs.readFile(harness.targetPath, "utf8")).toBe(newBinary);
		// And it runs: the swap kept the executable bit.
		const result = await Bun.$`${harness.targetPath} --version`.quiet();
		expect(result.text().trim()).toBe("veyyon/9.9.9");
		// The security gate announced itself (v1.0.36 contract: a control that
		// only speaks on failure leaves the user unsure it ran).
		expect(harness.reported.some(line => line.includes("Checksum verified"))).toBe(true);
		expect(harness.reported.some(line => line.includes("Updated to 9.9.9"))).toBe(true);
		// No leftover working files: neither the .new download nor a .bak backup.
		const leftovers = (await fs.readdir(path.dirname(harness.targetPath))).filter(f => f !== "veyyon");
		expect(leftovers).toEqual([]);
		// The binary and its sidecar were fetched from the pinned release tag.
		expect(harness.fetched.some(u => u.includes("/releases/download/v9.9.9/"))).toBe(true);
	});

	/** Sidecar 404 = fail closed BEFORE the swap: install.sh refuses without a
	 * sidecar and the self-updater must match. The old binary must be untouched
	 * and the partial download removed. */
	it("aborts on a missing .sha256 sidecar, leaving the old binary and no temp file", async () => {
		const asset = binaryName();
		const newBinary = fakeBinaryScript("9.9.9");
		const harness = await makeHarness({
			// No sidecar entry: the harness 404s it.
			[asset]: new Response(newBinary),
		});

		await expect(harness.run("9.9.9")).rejects.toThrow(/sha256|sidecar|checksum/i);

		expect(await fs.readFile(harness.targetPath, "utf8")).toBe(fakeBinaryScript("1.0.0"));
		const leftovers = (await fs.readdir(path.dirname(harness.targetPath))).filter(f => f !== "veyyon");
		expect(leftovers).toEqual([]);
		expect(harness.reported.some(line => line.includes("Checksum verified"))).toBe(false);
	});

	/** A tampered download (sidecar hash != bytes) must never reach the swap:
	 * this is the exact supply-chain case the gate exists for. */
	it("aborts on a checksum mismatch, leaving the old binary and no temp file", async () => {
		const asset = binaryName();
		const newBinary = fakeBinaryScript("9.9.9");
		const harness = await makeHarness({
			[`${asset}.sha256`]: new Response(`${sha256Hex("different bytes entirely")}  ${asset}\n`),
			[asset]: new Response(newBinary),
		});

		await expect(harness.run("9.9.9")).rejects.toThrow(/checksum mismatch/i);

		expect(await fs.readFile(harness.targetPath, "utf8")).toBe(fakeBinaryScript("1.0.0"));
		const leftovers = (await fs.readdir(path.dirname(harness.targetPath))).filter(f => f !== "veyyon");
		expect(leftovers).toEqual([]);
	});

	/** A 404 on the binary itself surfaces the rich download-failure message
	 * (release yanked / platform asset missing), not a bare HTTP status. */
	it("fails a missing binary asset with the rich download-failure message", async () => {
		const harness = await makeHarness({});

		await expect(harness.run("9.9.9")).rejects.toThrow(/9\.9\.9/);
		await expect(harness.run("9.9.9")).rejects.toThrow(/404/);

		expect(await fs.readFile(harness.targetPath, "utf8")).toBe(fakeBinaryScript("1.0.0"));
	});

	/** The post-swap subprocess check is the last line of defense: a binary that
	 * downloads and checksums fine but reports the WRONG version (wrong-commit
	 * build) must be rolled back to the previous binary. */
	it("rolls back to the previous binary when the swapped file reports the wrong version", async () => {
		const asset = binaryName();
		// Valid bytes + matching sidecar, but the script reports 1.2.3, not 9.9.9.
		const wrongVersionBinary = fakeBinaryScript("1.2.3");
		const harness = await makeHarness({
			[`${asset}.sha256`]: new Response(`${sha256Hex(wrongVersionBinary)}  ${asset}\n`),
			[asset]: new Response(wrongVersionBinary),
		});

		await expect(harness.run("9.9.9")).rejects.toThrow(/still reports 1\.2\.3.*restored previous/i);

		// Rollback restored the original binary and it still runs.
		expect(await fs.readFile(harness.targetPath, "utf8")).toBe(fakeBinaryScript("1.0.0"));
		const result = await Bun.$`${harness.targetPath} --version`.quiet();
		expect(result.text().trim()).toBe("veyyon/1.0.0");
		const leftovers = (await fs.readdir(path.dirname(harness.targetPath))).filter(f => f !== "veyyon");
		expect(leftovers).toEqual([]);
	});

	/** A source install (PATH resolves into the checkout launcher) must refuse
	 * the binary swap outright — before any network request happens. */
	it("refuses to self-update a source install without fetching anything", async () => {
		const dir = await makeTempDir();
		// The real source-launcher suffix: packages/coding-agent/scripts/veyyon.
		const launcherDir = path.join(dir, "checkout", "packages", "coding-agent", "scripts");
		await fs.mkdir(launcherDir, { recursive: true });
		const launcherPath = path.join(launcherDir, "veyyon");
		await fs.writeFile(launcherPath, fakeBinaryScript("1.0.0"), { mode: 0o755 });
		vi.spyOn(veyUtils, "$which").mockImplementation(bin => (bin === "veyyon" ? launcherPath : null));
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(installRelease("9.9.9", false, () => {})).rejects.toThrow(/installed from source|git pull/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
