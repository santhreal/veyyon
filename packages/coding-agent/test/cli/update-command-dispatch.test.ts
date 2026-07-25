/**
 * `veyyon update` must actually attempt the install, on both install methods.
 *
 * The source-install updater (fast-forward, reinstall, regen, refresh the
 * native addon) shipped and was unreachable: `runUpdateCommand` returned early
 * with the old manual advice whenever the install was a source checkout, so the
 * only command a user runs never reached `installRelease`, which owns the
 * binary-vs-source dispatch. The advice it printed instead is the advice that
 * stranded a user in the first place, because `git pull` alone skips the
 * dependency reinstall and the build-artifact regen and leaves a checkout that
 * does not boot.
 *
 * These drive the real command with the release lookup stubbed and the
 * installer injected, so they assert what the command DOES, not how it reads.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as updateCli from "@veyyon/coding-agent/cli/update-cli";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

// The command styles its output through the global theme, which the CLI
// initializes before dispatching any subcommand. Tests have to do the same or
// they exercise a state production never reaches.
beforeAll(async () => {
	await initTheme();
});

/**
 * Put a veyyon on PATH shaped like a source install: the launcher lives at
 * `<checkout>/packages/coding-agent/scripts/veyyon` and PATH holds a symlink to
 * it, exactly as `install.sh --source` wires it.
 */
function withSourceInstallOnPath<T>(run: () => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-update-dispatch-"));
	const launcher = path.join(root, "checkout", "packages", "coding-agent", "scripts", "veyyon");
	const binDir = path.join(root, "bin");
	fs.mkdirSync(path.dirname(launcher), { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(launcher, 0o755);
	fs.symlinkSync(launcher, path.join(binDir, "veyyon"));

	const previousPath = process.env.PATH;
	process.env.PATH = binDir;
	try {
		return run();
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** Stub the release lookup so the command sees a newer version to install. */
function stubLatestRelease(version: string): void {
	spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ tag_name: `v${version}` }) as never);
}

describe("runUpdateCommand reaches the installer", () => {
	it("installs on a source checkout instead of printing manual git advice", async () => {
		const logs: string[] = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		stubLatestRelease("999.0.0");
		const calls: { version: string; force: boolean }[] = [];

		await withSourceInstallOnPath(async () => {
			await updateCli.runUpdateCommand({ force: false, check: false }, async (version, force) => {
				calls.push({ version, force });
			});
		});

		expect(calls).toEqual([{ version: "999.0.0", force: false }]);
		// And the dead-end advice must be gone from the success path entirely.
		expect(logs.join("\n")).not.toContain("git pull && bun install");
	});

	it("passes --force through to the installer", async () => {
		spyOn(console, "log").mockImplementation(() => {});
		stubLatestRelease("999.0.0");
		const calls: { version: string; force: boolean }[] = [];

		await updateCli.runUpdateCommand({ force: true, check: false }, async (version, force) => {
			calls.push({ version, force });
		});

		expect(calls).toEqual([{ version: "999.0.0", force: true }]);
	});

	it("installs nothing in --check mode", async () => {
		// --check is a question, not an action. Reaching the installer here would
		// update a machine whose user only asked whether an update exists.
		spyOn(console, "log").mockImplementation(() => {});
		stubLatestRelease("999.0.0");
		let called = false;

		await updateCli.runUpdateCommand({ force: false, check: true }, async () => {
			called = true;
		});

		expect(called).toBe(false);
	});

	it("installs nothing when already up to date without --force", async () => {
		spyOn(console, "log").mockImplementation(() => {});
		stubLatestRelease("0.0.1");
		let called = false;

		await updateCli.runUpdateCommand({ force: false, check: false }, async () => {
			called = true;
		});

		expect(called).toBe(false);
	});
});

describe("the manual source-update guidance is still available where it belongs", () => {
	it("names the checkout's launcher and both recovery routes", () => {
		// It is no longer the answer to `veyyon update`, but it is still what every
		// source-update FAILURE appends, so the text has to stay correct.
		const guidance = updateCli.sourceInstallUpdateGuidance("/opt/checkout/packages/coding-agent/scripts/veyyon");
		expect(guidance).toContain("/opt/checkout/packages/coding-agent/scripts/veyyon");
		expect(guidance).toContain("git pull && bun install");
		expect(guidance).toContain("--source");
	});
});
