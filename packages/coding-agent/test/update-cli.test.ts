import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
} from "@veyyon/coding-agent/cli/auto-update-state";
import * as pluginCli from "@veyyon/coding-agent/cli/plugin-cli";
import * as updateCli from "@veyyon/coding-agent/cli/update-cli";
import {
	formatBinaryDownloadFailure,
	parseSha256Sidecar,
	replaceBinaryForUpdate,
	resolveUpdateMethod,
	sweepStaleBackups,
	verifyDownloadChecksum,
} from "@veyyon/coding-agent/cli/update-cli";
import Update from "@veyyon/coding-agent/commands/update";
import { removeWithRetries } from "@veyyon/utils";
import type { CliConfig } from "@veyyon/utils/cli";
import { LATEST_RELEASE_URL, releaseRedirect } from "./helpers/release-redirect";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeCmdShimDir = useTrackedTempDirs("veyyon-cmd-shim-");

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "veyyon",
	version: "0.0.0-test",
	commands: new Map(),
};

/**
 * Version discovery is the link that broke install-then-update: the shipped
 * binary is fetched from GitHub Releases by `install.sh`, but the self-updater
 * used to ask the npm registry, which has no `@veyyon/coding-agent` package and
 * never will (Veyyon ships GitHub-only). A binary installed from GitHub could
 * therefore never see a newer version. These tests lock the source to the
 * GitHub Releases API — the same catalog `install.sh` reads — and prove it fails
 * loudly rather than silently returning a stale or empty answer (Law 10).
 */
describe("getLatestRelease reads GitHub Releases, not npm", () => {
	function mockFetch(response: Response): { calls: Array<{ url: string; init?: RequestInit }> } {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const impl = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return response;
		}) as unknown as typeof fetch;
		spyOn(globalThis, "fetch").mockImplementation(impl);
		return { calls };
	}

	it("resolves the newest version from where releases/latest redirects, with a User-Agent", async () => {
		const { calls } = mockFetch(releaseRedirect("v1.2.3"));

		const release = await updateCli.getLatestRelease(1000);

		expect(release).toEqual({ tag: "v1.2.3", version: "1.2.3" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(LATEST_RELEASE_URL);
		expect(calls[0]?.url).not.toContain("registry.npmjs.org");
		const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers?.["User-Agent"]).toContain("veyyon");
	});

	/**
	 * `api.github.com` allows 60 requests an hour per IP without a token, and that
	 * budget is shared by everyone behind the same address. The startup check
	 * spent one of them on every launch, so an office, a CI fleet or a container
	 * host running several agents exhausted it and then could not update at all,
	 * on machines where nothing was wrong. `github.com` is not part of that
	 * budget. This is the assertion that keeps the API from creeping back in.
	 */
	it("does not touch the rate-limited API host at all", async () => {
		const { calls } = mockFetch(releaseRedirect("v1.2.3"));

		await updateCli.getLatestRelease(1000);

		expect(calls[0]?.url).not.toContain("api.github.com");
	});

	/**
	 * The redirect is the answer, so following it would download the release
	 * page — a few hundred kilobytes of HTML nobody reads — on every startup
	 * check. HEAD for the same reason: even the redirect's own body is waste.
	 */
	it("asks for the redirect itself rather than following it", async () => {
		const { calls } = mockFetch(releaseRedirect("v1.2.3"));

		await updateCli.getLatestRelease(1000);

		expect(calls[0]?.init?.redirect).toBe("manual");
		expect(calls[0]?.init?.method).toBe("HEAD");
	});

	it("normalizes a tag published without a leading v", async () => {
		mockFetch(releaseRedirect("2.0.0"));

		expect(await updateCli.getLatestRelease(1000)).toEqual({ tag: "v2.0.0", version: "2.0.0" });
	});

	it("throws loudly on 404 (draft/untagged release is not a published release), never a silent default", async () => {
		mockFetch(new Response("Not Found", { status: 404, statusText: "Not Found" }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/no published GitHub release yet/);
	});

	/**
	 * Only a tag page is an answer. A redirect anywhere else means GitHub replied
	 * with something other than a release — an interstitial, a moved repository,
	 * a captive portal — and taking the last path segment anyway is how an updater
	 * ends up trying to install the version "latest".
	 */
	it.each([
		["the releases index", "https://github.com/santhreal/veyyon/releases"],
		["a login interstitial", "https://github.com/login?return_to=%2Fsanthreal%2Fveyyon"],
		["a captive portal", "http://wifi.example.net/portal"],
		["a tag page with no tag on it", "https://github.com/santhreal/veyyon/releases/tag/"],
	])("refuses a redirect to %s", async (_name: string, location: string) => {
		mockFetch(new Response(null, { status: 302, headers: { location } }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/names no release tag/);
	});

	/** A response with no redirect at all is a failure, not an empty version. */
	it("throws when there is no redirect to read", async () => {
		mockFetch(new Response("", { status: 200 }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/Could not read the latest release/);
	});

	it("refuses a release whose tag is not a usable semver instead of guessing", async () => {
		mockFetch(releaseRedirect("nightly"));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/names no release tag/);
	});
});

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

/**
 * Veyyon ships GitHub-only: the one thing the updater must get right is telling a
 * standalone binary (safe to swap) from a source checkout (whose PATH entry is a
 * symlink to an in-checkout launcher a swap would destroy). These lock that
 * classification, including that it follows the symlink rather than judging by
 * the PATH string, so a source install is never silently clobbered (Law 10).
 */
describe("resolveUpdateMethod classifies binary vs source installs", () => {
	it("treats a standalone binary path as a binary install", () => {
		expect(resolveUpdateMethod("/home/u/.local/bin/veyyon")).toBe("binary");
	});

	it("treats the in-checkout launcher path as a source install", () => {
		// `bun run setup` links PATH's veyyon at
		// <checkout>/packages/coding-agent/scripts/veyyon.
		expect(resolveUpdateMethod("/home/u/.veyyon/src/packages/coding-agent/scripts/veyyon")).toBe("source");
	});

	it("follows a PATH symlink to the source launcher and still reports source", async () => {
		const dir = await makeTempDir();
		const launcherDir = path.join(dir, "src", "packages", "coding-agent", "scripts");
		await fs.mkdir(launcherDir, { recursive: true });
		const launcher = path.join(launcherDir, "veyyon");
		await Bun.write(launcher, "#!/bin/sh\nexec bun ...\n");
		const linkDir = path.join(dir, "bin");
		await fs.mkdir(linkDir, { recursive: true });
		const link = path.join(linkDir, "veyyon");
		await fs.symlink(launcher, link);

		expect(resolveUpdateMethod(link)).toBe("source");
	});

	it("follows a PATH symlink to a plain binary and reports binary", async () => {
		const dir = await makeTempDir();
		const real = path.join(dir, "opt", "veyyon");
		await fs.mkdir(path.dirname(real), { recursive: true });
		await Bun.write(real, "\x7fELF-ish standalone binary");
		const link = path.join(dir, "veyyon");
		await fs.symlink(real, link);

		expect(resolveUpdateMethod(link)).toBe("binary");
	});

	/**
	 * A Windows source install puts a `.cmd` shim on PATH that forwards to the
	 * in-checkout launcher. The shim is a real file, not a symlink, so realpath
	 * stops at it and the launcher tail never matched: the install classified as
	 * `binary`, and `veyyon update` would overwrite the shim with a downloaded
	 * .exe, converting a source install into a binary one and orphaning the
	 * checkout the user was running from. The shim's forwarded target is read
	 * instead. Separator- and extension-agnostic, and fail-closed: anything that
	 * cannot be read or parsed stays `binary` rather than guessing `source`.
	 */
	it("classifies a Windows .cmd shim forwarding to the launcher as source", () => {
		const shim = "C:\\Users\\u\\AppData\\Local\\veyyon\\veyyon.cmd";
		const launcher = "C:\\Users\\u\\.veyyon\\src\\packages\\coding-agent\\scripts\\veyyon.cmd";
		expect(resolveUpdateMethod(shim, () => `@echo off\r\n"${launcher}" %*`)).toBe("source");
	});

	it("classifies a .cmd shim forwarding to a standalone .exe as binary", () => {
		const shim = "C:\\Users\\u\\AppData\\Local\\veyyon\\veyyon.cmd";
		const exe = "C:\\Users\\u\\AppData\\Local\\veyyon\\veyyon.exe";
		expect(resolveUpdateMethod(shim, () => `@echo off\r\n"${exe}" %*`)).toBe("binary");
	});

	it("classifies the launcher .cmd itself as source without reading anything", () => {
		// When PATH points straight at the in-checkout launcher there is no shim to
		// read; the tail match alone must decide, so the reader is never called.
		const launcher = "C:\\Users\\u\\.veyyon\\src\\packages\\coding-agent\\scripts\\veyyon.cmd";
		let reads = 0;
		expect(
			resolveUpdateMethod(launcher, () => {
				reads += 1;
				return "";
			}),
		).toBe("source");
		expect(reads).toBe(0);
	});

	it("falls back to binary when the shim cannot be read or holds no target", () => {
		const shim = "C:\\Users\\u\\AppData\\Local\\veyyon\\veyyon.cmd";
		// Unreadable (permissions, deleted mid-check) and unparseable (no quoted
		// token) must both stay `binary`: guessing `source` would make the updater
		// try to git-pull a checkout that may not exist.
		expect(resolveUpdateMethod(shim, () => "")).toBe("binary");
		expect(resolveUpdateMethod(shim, () => "@echo off\r\nveyyon.exe %*")).toBe("binary");
	});

	it("reads a real on-disk .cmd shim, not just an injected reader", () => {
		// Proves the default reader is wired correctly, so the production path is
		// covered and not only the injected-seam tests above.
		const dir = makeCmdShimDir();
		const launcher = path.join(dir, "src", "packages", "coding-agent", "scripts", "veyyon.cmd");
		const shim = path.join(dir, "veyyon.cmd");
		nodeFs.writeFileSync(shim, `@echo off\r\n"${launcher}" %*`);
		expect(resolveUpdateMethod(shim)).toBe("source");
	});

	/**
	 * The POSIX half of the shim defect above, which stayed open after the Windows
	 * half was fixed because the fix was gated on a `.cmd` extension.
	 *
	 * A person who wants their own wrapper in front of a source checkout — to
	 * export a variable, to pick a different Bun — writes a shell script at the
	 * PATH entry that execs the checkout's launcher. It is a real file and it has
	 * no extension, so realpath stops at it and the launcher tail never matches:
	 * the install classified as `binary` and `veyyon update` would overwrite the
	 * wrapper with a downloaded release binary, destroying the wrapper and
	 * orphaning the checkout. Exactly the Windows failure, on the other platform.
	 */
	it("classifies a POSIX shell wrapper that execs the launcher as source", () => {
		const wrapper = "/home/u/.local/bin/veyyon";
		const launcher = "/home/u/.veyyon/src/packages/coding-agent/scripts/veyyon";
		expect(resolveUpdateMethod(wrapper, () => `#!/bin/sh\nexec "${launcher}" "$@"\n`)).toBe("source");
	});

	/** The same wrapper written without quotes, which is just as common. */
	it("classifies an unquoted exec of the launcher as source", () => {
		const wrapper = "/home/u/.local/bin/veyyon";
		const launcher = "/home/u/.veyyon/src/packages/coding-agent/scripts/veyyon";
		expect(resolveUpdateMethod(wrapper, () => `#!/usr/bin/env bash\nexport FOO=1\nexec ${launcher} "$@"\n`)).toBe(
			"source",
		);
	});

	/**
	 * Single quotes are the safe POSIX spelling when the checkout path contains
	 * spaces. Missing this form classified the wrapper as a release binary, so an
	 * update overwrote the user's script and orphaned the source checkout.
	 */
	it("classifies a single-quoted POSIX launcher as source", () => {
		const wrapper = "/home/u/.local/bin/veyyon";
		const launcher = "/home/u/source trees/veyyon/packages/coding-agent/scripts/veyyon";
		expect(resolveUpdateMethod(wrapper, () => `#!/bin/sh\nexec '${launcher}' "$@"\n`)).toBe("source");
	});

	/** A wrapper in front of a standalone binary is still a binary install. */
	it("classifies a POSIX wrapper that execs a plain binary as binary", () => {
		const wrapper = "/home/u/.local/bin/veyyon";
		expect(resolveUpdateMethod(wrapper, () => '#!/bin/sh\nexec "/opt/veyyon/veyyon" "$@"\n')).toBe("binary");
	});

	/**
	 * The shebang gate. Without it the classifier would scan the standalone
	 * release binary's own bytes for anything that looks like the launcher path,
	 * and a release that happens to embed one of its own build paths would be
	 * misclassified as a source install, and the updater would then try to git-pull
	 * a checkout that is not there. Only `#!` scripts and `.cmd`/`.bat` are read.
	 *
	 * The NUL in the fixture is written `\x00`, not as a literal byte. A raw
	 * control byte in source is invisible in every editor and diff, so the header
	 * reads as `\x7fELF\x02\x01\x01"` with no separator at all and a reader cannot
	 * see what is being tested. `scripts/a-source-file-that-reads-as-binary-is-invisible.test.ts`
	 * catches it, which is how this one was found.
	 */
	it("never classifies a binary as source from bytes that merely contain the launcher path", () => {
		const binary = "/home/u/.local/bin/veyyon";
		const launcher = "/build/agent/packages/coding-agent/scripts/veyyon";
		expect(resolveUpdateMethod(binary, () => `\x7fELF\x02\x01\x01\x00"${launcher}"`)).toBe("binary");
	});

	it("reads a real on-disk POSIX wrapper, not just an injected reader", () => {
		// The production reader, on the platform where the wrapper has no extension
		// to hint at it: only the shebang tells it apart from the release binary.
		const dir = makeCmdShimDir();
		const launcher = path.join(dir, "src", "packages", "coding-agent", "scripts", "veyyon");
		const wrapper = path.join(dir, "veyyon");
		nodeFs.writeFileSync(wrapper, `#!/bin/sh\nexec "${launcher}" "$@"\n`);
		expect(resolveUpdateMethod(wrapper)).toBe("source");
	});

	/**
	 * The bound on how much of the PATH entry is read. The standalone release
	 * binary is over a hundred megabytes and this runs on every update check, so a
	 * forwarding line past the first 4 KiB is deliberately not found.
	 */
	it("reads only the first 4 KiB of the file on PATH", () => {
		const dir = makeCmdShimDir();
		const wrapper = path.join(dir, "veyyon");
		const launcher = path.join(dir, "src", "packages", "coding-agent", "scripts", "veyyon");
		nodeFs.writeFileSync(wrapper, `#!/bin/sh\n${"# pad\n".repeat(1000)}exec "${launcher}" "$@"\n`);
		expect(resolveUpdateMethod(wrapper)).toBe("binary");

		const near = path.join(dir, "veyyon-near");
		nodeFs.writeFileSync(near, `#!/bin/sh\n${"# pad\n".repeat(100)}exec "${launcher}" "$@"\n`);
		expect(resolveUpdateMethod(near)).toBe("source");
	});

	/**
	 * The guidance is the only thing a user gets when an automatic source update
	 * refuses (dirty tree, diverged branch, missing git), so it must name the
	 * launcher and a command that exists. It used to end with "re-run the
	 * installer with `--source`", and that flag is gone: the installer only ever
	 * installs a prebuilt binary and never clones. Advertising it would send the
	 * user to `Unknown option: --source`.
	 */
	it("guidance for a source install names the launcher and the git-pull remedy", () => {
		const launcher = "/home/u/veyyon/packages/coding-agent/scripts/veyyon";
		const msg = updateCli.sourceInstallUpdateGuidance(launcher);
		expect(msg).toContain(launcher);
		expect(msg).toContain("git pull && bun install");
		expect(msg).not.toContain("--source");
		expect(msg).not.toContain("install.sh");
	});

	/**
	 * Same contract for the rollback refusal, which is a second user-visible
	 * string that named the removed flag. It must explain the fast-forward
	 * constraint without advertising an installer mode that no longer exists.
	 */
	it("rollback refusal explains the checkout constraint without naming a removed flag", () => {
		const msg = updateCli.rollbackUnsupportedReason("source");
		expect(msg).toContain("fast-forward");
		expect(msg).not.toContain("--source");
		expect(updateCli.rollbackUnsupportedReason("binary")).toBeUndefined();
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous veyyon binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});

describe("update-cli release-info errors", () => {
	it("404 from GitHub Releases names the URL, status, and unpublished-release hint without a doubled Error prefix", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));
		const errors: string[] = [];
		spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		spyOn(console, "log").mockImplementation(() => {});
		const exitSentinel = new Error("process.exit sentinel");
		const exitSpy = spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel;
		}) as never);

		await expect(updateCli.runUpdateCommand({ force: false, check: true })).rejects.toBe(exitSentinel);

		expect(exitSpy).toHaveBeenCalledWith(1);
		const combined = errors.join("\n");
		expect(combined).toContain("Failed to check for updates");
		// "Failed to check for updates: Failed to resolve..." read as two failures
		// stacked on one another. The inner message states what it could not do
		// and lets the outer one supply the "failed".
		expect(combined).not.toContain("updates: Failed");
		expect(combined).toContain("github.com/santhreal/veyyon/releases/latest");
		expect(combined).not.toContain("api.github.com");
		expect(combined).not.toContain("registry.npmjs.org");
		expect(combined).toContain("HTTP 404");
		expect(combined).toContain("no published GitHub release yet");
		// `${err}` used to stringify the Error and double the prefix.
		expect(combined).not.toContain("Error: Failed to fetch");
	});
});

describe("runUpdateCommand fetch cancellation", () => {
	// The release-metadata check must never be able to hang forever: runUpdateCommand
	// has to arm the fetch with a timeout AbortSignal so a stalled registry connection
	// fails fast instead of freezing `veyyon update --check`. Merged from the former
	// src/cli/update-cli.test.ts so this module has a single suite.
	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				requestSignal = init?.signal ?? undefined;
				return releaseRedirect("v999.0.0");
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		spyOn(globalThis, "fetch").mockImplementation(fetchStub as never);

		await updateCli.runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("runUpdateCommand --check --force messaging", () => {
	it("reports what --force would do rather than announcing a reinstall in check mode", async () => {
		// --check installs nothing. With --force on an already-up-to-date install the
		// command used to print "Forcing reinstall of X" and then return silently,
		// which reads as a reinstall that broke. In check mode it must instead state
		// that --force WOULD reinstall, so the output matches what actually happens.
		spyOn(globalThis, "fetch").mockResolvedValue(releaseRedirect("v0.0.1"));
		const logs: string[] = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});

		await updateCli.runUpdateCommand({ force: true, check: true });

		const combined = logs.join("\n");
		expect(combined).toContain("Up to date at 0.0.1; --force would reinstall it");
		expect(combined).not.toContain("Forcing reinstall");
	});
});

describe("runAutoUpdate", () => {
	// runAutoUpdate is the form a running TUI session calls: unlike
	// runUpdateCommand it must never write to stdout (that would corrupt the
	// render) and never process.exit (that would kill the user's session). It
	// reports every outcome through its return value instead.
	const stubRegistry = (impl: () => Promise<Response>) => spyOn(globalThis, "fetch").mockImplementation(impl as never);

	// Every call below points the failure record and the install lock at a
	// throwaway file. Without this the suite would write a real backoff into the
	// developer's own state directory, and the recorded failure from one test
	// would suppress the install in the next one.
	const statePath = async (): Promise<string> => path.join(await makeTempDir(), "auto-update-state.json");

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports up-to-date when the registry has nothing newer", async () => {
		stubRegistry(async () => releaseRedirect("v1.2.3"));

		expect(await updateCli.runAutoUpdate("1.2.3", undefined, await statePath(), () => "binary")).toEqual({
			status: "up-to-date",
		});
		// Strictly newer is required, so a registry that has fallen behind the
		// installed build must not trigger a downgrade install.
		expect(await updateCli.runAutoUpdate("2.0.0", undefined, await statePath(), () => "binary")).toEqual({
			status: "up-to-date",
		});
	});

	it("reports the registry failure instead of silently doing nothing", async () => {
		stubRegistry(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary");
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.error).toContain("503");
		// No version is known when the lookup itself failed.
		expect(outcome.status === "failed" && outcome.version).toBeUndefined();
	});

	it("reports a transport error rather than throwing into the session", async () => {
		stubRegistry(async () => {
			throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		});

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary");
		expect(outcome).toEqual({ status: "failed", error: "getaddrinfo ENOTFOUND registry.npmjs.org" });
	});

	it("installs silently, so a live TUI frame is never corrupted", async () => {
		// The install helpers print progress ("Downloading …", "Installing update…")
		// through a reporter. Under a TUI those writes land in the middle of the
		// rendered frame, so runAutoUpdate must pass the silent one. Asserting on
		// the reporter rather than on stdout is what makes this test meaningful:
		// an earlier version only exercised the up-to-date path, which never
		// reaches an install and so could not have caught a console write.
		stubRegistry(async () => releaseRedirect("v9.9.9"));
		const install = spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary");

		expect(outcome).toEqual({ status: "updated", version: "9.9.9", warnings: [] });
		expect(install).toHaveBeenCalledWith("9.9.9", false, updateCli.SILENT_UPDATE_REPORTER);
	});

	it("skips a source install instead of clobbering its launcher with a binary", async () => {
		// A source checkout (install.sh --source) updates via `git pull`; a binary
		// swap would overwrite its launcher. The background updater must SKIP it, not
		// attempt the install and fail-loop every launch (Law 10). The install method
		// is injected so the test does not depend on how veyyon is installed locally.
		stubRegistry(async () => releaseRedirect("v9.9.9"));
		const install = spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "source");

		expect(outcome).toEqual({ status: "skipped", version: "9.9.9", reason: "source-install" });
		expect(install).not.toHaveBeenCalled();
	});

	it("still installs a binary install when the newer version is available", async () => {
		// The companion to the source-skip test: an injected `binary` method takes
		// the normal install path, proving the skip is specific to source installs.
		stubRegistry(async () => releaseRedirect("v9.9.9"));
		const install = spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary");

		expect(outcome).toEqual({ status: "updated", version: "9.9.9", warnings: [] });
		expect(install).toHaveBeenCalledWith("9.9.9", false, updateCli.SILENT_UPDATE_REPORTER);
	});

	it("reports an install failure instead of claiming success", async () => {
		stubRegistry(async () => releaseRedirect("v9.9.9"));
		spyOn(updateCli, "installRelease").mockRejectedValue(new Error("brew exited 1"));

		expect(await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary")).toEqual({
			status: "failed",
			version: "9.9.9",
			error: "brew exited 1",
		});
	});

	it("does not write to stdout on the up-to-date path", async () => {
		stubRegistry(async () => releaseRedirect("v1.0.0"));
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);

		await updateCli.runAutoUpdate("1.0.0", undefined, await statePath(), () => "binary");

		expect(write).not.toHaveBeenCalled();
	});

	describe("guards against repeating work on every launch", () => {
		it("records the failed version so the next launch can see it", async () => {
			// The record is what the backoff reads. If the failure path did not
			// write it, every launch would retry an install that cannot succeed.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			spyOn(updateCli, "installRelease").mockRejectedValue(new Error("EACCES: permission denied"));
			const state = await statePath();

			await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");

			expect(await readAutoUpdateState(state)).toEqual({
				failedVersion: "9.9.9",
				failedAtMs: expect.any(Number),
				failedError: "EACCES: permission denied",
			});
		});

		it("skips the install when that same version failed recently", async () => {
			// A machine that cannot install at all showed the same red error on
			// every launch. It now reports once and backs off, and crucially does
			// not spend a package-manager run reproducing the failure each time.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			const install = spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.9", "EACCES", state, Date.now());

			const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");

			expect(outcome).toEqual({ status: "skipped", version: "9.9.9", reason: "recent-failure" });
			expect(install).not.toHaveBeenCalled();
		});

		it("still installs a different version while an older failure is in its window", async () => {
			// A build that failed is not evidence the next build fails, so a new
			// release must never be held back by the previous one's cooldown.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			const install = spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.8", "bad tarball", state, Date.now());

			const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");

			expect(outcome).toEqual({ status: "updated", version: "9.9.9", warnings: [] });
			expect(install).toHaveBeenCalledTimes(1);
		});

		it("clears the record after a successful install", async () => {
			// Otherwise a machine that recovered keeps a failure on disk that
			// nothing removes, and a later failure is judged against a stale one.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.9", "transient", state, 1_000);

			await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");

			expect(await readAutoUpdateState(state)).toEqual({});
		});

		it("installs once when several sessions launch at the same time", async () => {
			// Opening three terminals at once used to run three concurrent
			// package-manager writes at the same binary. The lock makes the
			// losers stand down instead of racing.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const install = spyOn(updateCli, "installRelease").mockImplementation(async () => {
				started.resolve();
				await finish.promise;
				return { warnings: [] };
			});
			const state = await statePath();

			const first = updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");
			await started.promise;
			const others = await Promise.all([
				updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary"),
				updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary"),
			]);
			finish.resolve();
			const outcomes = [await first, ...others];

			expect(install).toHaveBeenCalledTimes(1);
			expect(outcomes.filter(o => o.status === "updated")).toHaveLength(1);
			expect(outcomes.filter(o => o.status === "skipped")).toHaveLength(2);
			for (const outcome of outcomes) {
				if (outcome.status === "skipped") expect(outcome.reason).toBe("another-process");
			}
		});

		it("releases the lock after an install, so the next launch is not blocked", async () => {
			// A lock left behind by a finished install would stall updates until
			// its staleness window elapsed, which is deliberately fifteen minutes.
			stubRegistry(async () => releaseRedirect("v9.9.9"));
			spyOn(updateCli, "installRelease").mockResolvedValue({ warnings: [] });
			const state = await statePath();

			await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");
			await clearAutoUpdateFailure(state);
			const second = await updateCli.runAutoUpdate("1.0.0", undefined, state, () => "binary");

			expect(second).toEqual({ status: "updated", version: "9.9.9", warnings: [] });
		});
	});
});

/**
 * The binary download is the last hop of every install: `updateViaBinaryAt`
 * fetches a per-version, per-platform asset (`veyyon-<os>-<arch>[.exe]`) from a
 * release tag. Before this, a failed fetch threw `Download failed: ${statusText}`
 * — for a GitHub 404 that is the useless string "Download failed: Not Found",
 * naming neither the version requested nor the asset that was missing. That hurts
 * two real flows: the rollback path installs arbitrary old versions (a mistyped
 * or unpublished version 404s), and a release whose build for one OS/arch failed
 * to upload 404s only for those users. These tests pin the rich message so the
 * operator always learns the URL, the status, the version, and the fix (an error
 * message must carry context and the fix — Engineering Standards). They assert
 * exact substrings, never `!is_empty`.
 */
describe("formatBinaryDownloadFailure names the version, asset, and fix", () => {
	const URL = "https://github.com/santhreal/veyyon/releases/download/v1.0.99/veyyon-linux-x64";

	it("on 404 names the missing asset, the version, and points at update --check", () => {
		// The rollback/old-version case: the version or the platform asset does not
		// exist. The message must say which asset and which version, not just "404".
		const msg = formatBinaryDownloadFailure(404, "Not Found", URL, "1.0.99", "veyyon-linux-x64");
		expect(msg).toBe(
			"Failed to download release binary from " +
				"https://github.com/santhreal/veyyon/releases/download/v1.0.99/veyyon-linux-x64: " +
				"HTTP 404 Not Found — release v1.0.99 has no veyyon-linux-x64 asset. The version " +
				"may not exist, or its build for your platform and architecture was not published. " +
				"Run `veyyon update --check` to see the latest available version.",
		);
	});

	it("on 403/429 gives the rate-limit retry hint, not a bare status", () => {
		// GitHub rate-limits by address; the actionable advice is to wait, so the
		// message must say so rather than leave the user guessing at a 403.
		for (const status of [403, 429] as const) {
			const msg = formatBinaryDownloadFailure(status, "Forbidden", URL, "1.0.99", "veyyon-linux-x64");
			expect(msg).toContain(`HTTP ${status} Forbidden`);
			expect(msg).toContain("rate-limiting this address; retry in a few minutes");
			expect(msg).not.toContain("has no veyyon-linux-x64 asset");
		}
	});

	it("on any other status reports the URL and status with no invented hint", () => {
		// A 500 is neither a missing asset nor a rate limit; inventing either hint
		// would mislead. The message stays factual: URL + status only.
		const msg = formatBinaryDownloadFailure(500, "Internal Server Error", URL, "1.0.99", "veyyon-linux-x64");
		expect(msg).toBe(
			"Failed to download release binary from " +
				"https://github.com/santhreal/veyyon/releases/download/v1.0.99/veyyon-linux-x64: " +
				"HTTP 500 Internal Server Error",
		);
		expect(msg).not.toContain("rate-limiting");
		expect(msg).not.toContain("asset");
	});

	it("omits the trailing space when the response carries no statusText", () => {
		// Some responses have an empty statusText; the message must not render a
		// dangling "HTTP 404 " with a hanging space before the dash.
		const msg = formatBinaryDownloadFailure(404, "", URL, "1.0.99", "veyyon-linux-x64");
		expect(msg).toContain("HTTP 404 — release v1.0.99");
		expect(msg).not.toContain("HTTP 404  ");
	});
});

/**
 * The published `.sha256` sidecars are standard `sha256sum` output
 * (`<64-hex>  <filename>`). This parser is the single reader of that format for
 * the self-updater, and its strictness is a security boundary: anything that is
 * not exactly a 64-hex digest must return null so the caller fails closed rather
 * than comparing a downloaded binary against garbage. These assert the exact
 * digest, never `!is_empty`.
 */
describe("parseSha256Sidecar reads the sha256sum format strictly", () => {
	const HASH = "ab5722f6f0414851db42ca3014f9da3d1ea3afe708a1417bd0441cccd5bf7562";

	it("takes the first token of `<hash>  <filename>` and lowercases it", () => {
		expect(parseSha256Sidecar(`${HASH}  veyyon-linux-x64`)).toBe(HASH);
		expect(parseSha256Sidecar(`${HASH.toUpperCase()}  veyyon-linux-x64`)).toBe(HASH);
	});

	it("accepts a bare digest with surrounding whitespace or a trailing newline", () => {
		expect(parseSha256Sidecar(HASH)).toBe(HASH);
		expect(parseSha256Sidecar(`  ${HASH}\n`)).toBe(HASH);
	});

	it("returns null for anything that is not a 64-hex digest (fail closed)", () => {
		// An empty body, an HTML error page, a truncated file, and an over-long token
		// must all reject so verifyDownloadChecksum refuses rather than trusts them.
		expect(parseSha256Sidecar("")).toBeNull();
		expect(parseSha256Sidecar("   \n  ")).toBeNull();
		expect(parseSha256Sidecar("<!DOCTYPE html><html>Not Found</html>")).toBeNull();
		expect(parseSha256Sidecar(HASH.slice(0, 63))).toBeNull();
		expect(parseSha256Sidecar(`${HASH}0`)).toBeNull();
		expect(parseSha256Sidecar("g".repeat(64))).toBeNull();
	});
});

/**
 * Fresh `curl` and PowerShell installs both refuse a binary whose `.sha256`
 * checksum is missing, unparseable, or mismatched. The self-updater used to
 * download and swap with only a post-install `--version` check, so a corrupted or
 * tampered same-version binary sailed through. verifyDownloadChecksum closes that
 * parity gap. These tests hash a real on-disk file and prove the gate PASSES on a
 * matching sidecar and FAILS CLOSED (throws, so the caller deletes the download)
 * on a mismatch, a 404, and an empty/unparseable body — no silent fallback
 * (Law 10). The mismatch message must name both digests so the operator sees it.
 */
describe("verifyDownloadChecksum is a fail-closed integrity gate", () => {
	const SIDECAR = "https://github.com/santhreal/veyyon/releases/download/v1.0.99/veyyon-linux-x64.sha256";

	async function writeBinary(bytes: string): Promise<{ filePath: string; hash: string }> {
		const dir = await makeTempDir();
		const filePath = path.join(dir, "veyyon-linux-x64");
		await fs.writeFile(filePath, bytes);
		const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		return { filePath, hash };
	}

	it("resolves when the file's digest matches the published sidecar", async () => {
		const { filePath, hash } = await writeBinary("fake-binary-contents-v1.0.99");
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${hash}  veyyon-linux-x64\n`, { status: 200 }));
		await expect(verifyDownloadChecksum(filePath, SIDECAR)).resolves.toBeUndefined();
	});

	it("throws naming both digests when the file does not match (tampered/corrupted)", async () => {
		const { filePath, hash } = await writeBinary("fake-binary-contents-v1.0.99");
		const wrong = "0".repeat(64);
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${wrong}  veyyon-linux-x64\n`, { status: 200 }));
		await expect(verifyDownloadChecksum(filePath, SIDECAR)).rejects.toThrow(
			`Checksum mismatch for the downloaded binary (expected ${wrong}, got ${hash}) — refusing to install a tampered binary`,
		);
	});

	it("refuses when the sidecar 404s instead of silently installing unverified", async () => {
		const { filePath } = await writeBinary("fake-binary");
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));
		await expect(verifyDownloadChecksum(filePath, SIDECAR)).rejects.toThrow(
			/No published checksum at .* \(HTTP 404\) — refusing to install an unverified binary/,
		);
	});

	it("refuses when the sidecar body is empty or unparseable", async () => {
		const { filePath } = await writeBinary("fake-binary");
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
		await expect(verifyDownloadChecksum(filePath, SIDECAR)).rejects.toThrow(
			/empty or unparseable — refusing to install/,
		);
	});
});
