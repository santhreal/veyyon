import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { removeWithRetries } from "@veyyon/utils";
import {
	__resetProfileSnapshotForTests,
	APP_NAME,
	getActiveProfile,
	getAgentDbPath,
	getAgentDir,
	setAgentDir,
	setProfile,
	VERSION,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";
import { runCli } from "../src/cli";
import * as profileAliasCli from "../src/cli/profile-alias";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

describe("global --profile flag", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let originalVeyyonProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
		originalVeyyonProfileEnv = process.env.VEYYON_PROFILE;
		originalPiProfileEnv = process.env.VEYYON_PROFILE;
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		configDir = `.veyyon-profile-cli-test-${Snowflake.next()}`;
		process.env.VEYYON_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.VEYYON_CONFIG_DIR;
		} else {
			process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		if (originalVeyyonProfileEnv === undefined) {
			delete process.env.VEYYON_PROFILE;
		} else {
			process.env.VEYYON_PROFILE = originalVeyyonProfileEnv;
		}
		if (originalPiProfileEnv === undefined) {
			delete process.env.VEYYON_PROFILE;
		} else {
			process.env.VEYYON_PROFILE = originalPiProfileEnv;
		}
		if (originalAgentDirEnv === undefined) {
			delete process.env.VEYYON_CODING_AGENT_DIR;
		} else {
			process.env.VEYYON_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("activates a profile before dispatching root flags", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile=work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
	});

	it("activates a profile inherited from VEYYON_PROFILE at run time", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.VEYYON_PROFILE = "work";

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
		expect(getAgentDbPath()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent", "agent.db"));
	});

	it("accepts the profile flag after other root flags", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--version", "--profile", "office"]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("office");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "office", "agent"));
	});

	it("installs a shell alias and exits before command dispatch", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "vey-work",
			profile: "work",
			command: "veyyon --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "work", "--alias", "vey-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "vey-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created vey-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when launch is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "vey-work",
			profile: "work",
			command: "veyyon --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["launch", "--profile", "work", "--alias", "vey-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "vey-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created vey-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when acp is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "vey-work",
			profile: "work",
			command: "veyyon --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["acp", "--profile", "work", "--alias", "vey-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "vey-work",
			}),
		);
		expect(getActiveProfile()).toBe("work");
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created vey-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("rejects missing profile values without dispatching", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "--version"]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			"--profile requires a profile name",
		);
		expect(outSpy).not.toHaveBeenCalled();
	});

	it("loads profile agent .env before command modules import pi-utils env", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-profile-cli-env-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".veyyon-profile-cli-env";
			// Plant the "default" sentinel where the default profile actually
			// resolves (profiles/default/agent), not the legacy bare <configDir>/agent
			// path. That way the negative assertion below proves the work profile
			// wins over a genuinely loadable default .env, not over an empty dir.
			const defaultAgentDir = path.join(home, configDir, "profiles", "default", "agent");
			const profileAgentDir = path.join(home, configDir, "profiles", "work", "agent");
			await fs.mkdir(defaultAgentDir, { recursive: true });
			await fs.mkdir(profileAgentDir, { recursive: true });
			await Bun.write(path.join(defaultAgentDir, ".env"), "VEYYON_PROFILE_BOOTSTRAP_SENTINEL=default\n");
			await Bun.write(path.join(profileAgentDir, ".env"), "VEYYON_PROFILE_BOOTSTRAP_SENTINEL=work\n");

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--profile", "work", "--help"]);',
					'process.stdout.write("\\nSENTINEL=" + (Bun.env.VEYYON_PROFILE_BOOTSTRAP_SENTINEL ?? ""));',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				VEYYON_CONFIG_DIR: configDir,
				VEYYON_NO_TITLE: "1",
				NO_COLOR: "1",
			};
			delete childEnv.VEYYON_PROFILE;
			delete childEnv.VEYYON_PROFILE;
			delete childEnv.VEYYON_CODING_AGENT_DIR;
			delete childEnv.VEYYON_PROFILE_BOOTSTRAP_SENTINEL;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("SENTINEL=work");
			expect(stdout).not.toContain("SENTINEL=default");
		} finally {
			await removeWithRetries(root);
		}
	});

	it("cli.ts imports no top-level @veyyon/utils barrel (would eager-load .env before setProfile)", async () => {
		// Fast source lock guarding the ordering the test above proves behaviorally:
		// the "@veyyon/utils" barrel re-exports ./env, which parses the agent-dir
		// .env at import time. cli.ts must reach every utils symbol through a subpath
		// (e.g. @veyyon/utils/type-guards, /dirs) so nothing loads the agent .env
		// before runCli() calls setProfile(). A bare-barrel static import here
		// silently reintroduces the wrong-profile-.env bug, so fail on it.
		const cliSource = await fs.readFile(path.join(import.meta.dir, "..", "src", "cli.ts"), "utf-8");
		const barrelImports = cliSource
			.split("\n")
			.filter(line => /^\s*import\b/.test(line) && /from\s+["']@veyyon\/utils["']/.test(line));
		expect(barrelImports).toEqual([]);
	});

	it("importing cli.ts (whole static graph) loads no agent .env before setProfile runs", async () => {
		// Stronger than the source lock above: the source lock only inspects cli.ts
		// itself, but the invariant covers the ENTIRE static import graph reachable
		// before runCli() calls setProfile() — any transitively imported module that
		// pulls the "@veyyon/utils" barrel would eager-load the agent .env just the
		// same. This probe imports the cli module WITHOUT calling runCli and asserts
		// a planted default-profile .env never leaked into the process env; if it
		// did, some module in the pre-setProfile graph loaded .env at import time.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-profile-cli-leak-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".veyyon-profile-cli-leak";
			const defaultAgentDir = path.join(home, configDir, "profiles", "default", "agent");
			await fs.mkdir(defaultAgentDir, { recursive: true });
			await Bun.write(path.join(defaultAgentDir, ".env"), "VEYYON_IMPORT_LEAK_SENTINEL=leaked\n");

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					// Import ONLY — never call runCli, so setProfile never runs.
					`import ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'process.stdout.write("LEAK=" + (Bun.env.VEYYON_IMPORT_LEAK_SENTINEL ?? "<none>"));',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				VEYYON_CONFIG_DIR: configDir,
				VEYYON_NO_TITLE: "1",
				NO_COLOR: "1",
			};
			delete childEnv.VEYYON_PROFILE;
			delete childEnv.VEYYON_CODING_AGENT_DIR;
			delete childEnv.VEYYON_IMPORT_LEAK_SENTINEL;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("LEAK=<none>");
		} finally {
			await removeWithRetries(root);
		}
	});

	it("surfaces an invalid VEYYON_PROFILE env as a clean error, not an import crash", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-profile-cli-env-bad-"));
		try {
			const home = path.join(root, "home");
			await fs.mkdir(home, { recursive: true });

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--version"]);',
					// Reached only if the module import did NOT throw — i.e. the invalid
					// env was deferred to runCli's error handler instead of crashing the
					// process during the static import of dirs.ts.
					'process.stdout.write("HANDLED");',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				VEYYON_CONFIG_DIR: ".veyyon-profile-cli-env-bad",
				VEYYON_PROFILE: "..",
				NO_COLOR: "1",
			};
			delete childEnv.VEYYON_CODING_AGENT_DIR;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(stdout, stderr).toContain("HANDLED");
			expect(stderr).toContain("Invalid VEYYON_PROFILE");
			expect(exitCode).toBe(1);
		} finally {
			await removeWithRetries(root);
		}
	});
});
