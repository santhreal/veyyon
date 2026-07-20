import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { applySessionWorkdir, applyStartupCwd } from "@veyyon/coding-agent/cli/startup-cwd";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getProjectDir, normalizePathForComparison, setProjectDir, TempDir } from "@veyyon/utils";

const originalProjectDir = getProjectDir();
const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	setProjectDir(originalProjectDir);
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("launch cwd precedence: CLI > session.workdir > process.cwd", () => {
	it("applies profile session.workdir when --cwd is absent", async () => {
		const launchDir = makeTempDir("@pi-workdir-launch-");
		const workdir = makeTempDir("@pi-workdir-profile-");
		setProjectDir(launchDir);

		const settings = Settings.isolated({ "session.workdir": workdir });
		const parsed = parseArgs(["hello"]);
		await applyStartupCwd(parsed);
		expect(getProjectDir()).toBe(launchDir);

		const changed = await applySessionWorkdir(settings, parsed.cwd);
		expect(changed).toBe(true);
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(workdir));
	});

	it("keeps explicit --cwd over session.workdir", async () => {
		const launchDir = makeTempDir("@pi-workdir-launch-");
		const cliDir = makeTempDir("@pi-workdir-cli-");
		const workdir = makeTempDir("@pi-workdir-profile-");
		setProjectDir(launchDir);

		const settings = Settings.isolated({ "session.workdir": workdir });
		const parsed = parseArgs(["--cwd", cliDir, "hello"]);
		await applyStartupCwd(parsed);
		expect(getProjectDir()).toBe(cliDir);

		const changed = await applySessionWorkdir(settings, parsed.cwd);
		expect(changed).toBe(false);
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(cliDir));
		expect(normalizePathForComparison(getProjectDir())).not.toBe(normalizePathForComparison(workdir));
	});

	it("leaves process cwd alone when session.workdir is unset", async () => {
		const launchDir = makeTempDir("@pi-workdir-launch-");
		setProjectDir(launchDir);

		const settings = Settings.isolated({});
		const parsed = parseArgs(["hello"]);
		await applyStartupCwd(parsed);
		const changed = await applySessionWorkdir(settings, parsed.cwd);
		expect(changed).toBe(false);
		expect(getProjectDir()).toBe(launchDir);
	});

	it("fails loudly for a relative session.workdir", async () => {
		const launchDir = makeTempDir("@pi-workdir-launch-");
		setProjectDir(launchDir);

		const settings = Settings.isolated({ "session.workdir": "relative/path" });
		await expect(applySessionWorkdir(settings, undefined)).rejects.toThrow(
			/session\.workdir must be an absolute or ~-relative path/,
		);
		expect(getProjectDir()).toBe(launchDir);
	});

	it("fails loudly when session.workdir points at a missing directory", async () => {
		const launchDir = makeTempDir("@pi-workdir-launch-");
		const missing = path.join(os.tmpdir(), `veyyon-workdir-missing-${Date.now()}-${Math.random()}`);
		setProjectDir(launchDir);

		const settings = Settings.isolated({ "session.workdir": missing });
		await expect(applySessionWorkdir(settings, undefined)).rejects.toThrow(
			/session\.workdir points at a missing directory/,
		);
		expect(getProjectDir()).toBe(launchDir);
		expect(fs.existsSync(missing)).toBe(false);
	});
});
