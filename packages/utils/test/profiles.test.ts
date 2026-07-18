import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	__resetDirsFromEnvForTests,
	__resetProfileSnapshotForTests,
	APP_NAME,
	getActiveProfile,
	getAgentDbPath,
	getAgentDir,
	getConfigAgentDirName,
	getConfigRootDir,
	getPythonGatewayDir,
	getSessionsDir,
	getStatsDbPath,
	listProfiles,
	normalizeProfileName,
	profileExists,
	resolveProfileEnv,
	setAgentDir,
	setProfile,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";

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

describe("profile directories", () => {
	let tempRoot = "";
	let configDir = "";
	let originalAgentDir = "";
	let originalProfile: string | undefined;
	let originalVeyyonAgentDirEnv: string | undefined;
	let originalConfigDir: string | undefined;
	let originalXdgDataHome: string | undefined;
	let originalXdgStateHome: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalProfile = getActiveProfile();
		originalVeyyonAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "veyyon-utils-profiles", Snowflake.next());
		configDir = `.veyyon-profile-test-${Snowflake.next()}`;
		await fs.mkdir(tempRoot, { recursive: true });
		process.env.VEYYON_CONFIG_DIR = configDir;
		// Other suites that run before this one (e.g. dirs-python-gateway) may have
		// called `setAgentDir`, which permanently mutates the module-level
		// pre-profile snapshot. Reset it here so each test starts from a clean
		// `VEYYON_CODING_AGENT_DIR` baseline matching the env we just configured.
		delete process.env.VEYYON_CODING_AGENT_DIR;
		__resetProfileSnapshotForTests();
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
	});

	afterEach(async () => {
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.VEYYON_CONFIG_DIR;
		} else {
			process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		}
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		if (originalXdgCacheHome === undefined) {
			delete process.env.XDG_CACHE_HOME;
		} else {
			process.env.XDG_CACHE_HOME = originalXdgCacheHome;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalVeyyonAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		if (originalVeyyonAgentDirEnv === undefined) {
			delete process.env.VEYYON_CODING_AGENT_DIR;
		} else {
			process.env.VEYYON_CODING_AGENT_DIR = originalVeyyonAgentDirEnv;
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it("moves agent and root data under the named profile root", () => {
		setProfile("work");

		const root = path.join(os.homedir(), configDir, "profiles", "work");
		const agent = path.join(root, "agent");
		expect(getActiveProfile()).toBe("work");
		expect(getConfigRootDir()).toBe(root);
		expect(getConfigAgentDirName()).toBe(path.join(configDir, "profiles", "work", "agent"));
		expect(getAgentDir()).toBe(agent);
		expect(getAgentDbPath()).toBe(path.join(agent, "agent.db"));
		expect(getSessionsDir()).toBe(path.join(agent, "sessions"));
		expect(getStatsDbPath()).toBe(path.join(root, "stats.db"));
	});

	it("treats the default profile as regular mode", () => {
		setProfile("default");

		const root = path.join(os.homedir(), configDir, "profiles", "default");
		expect(getActiveProfile()).toBeUndefined();
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
	});

	it("lists default and named profiles", async () => {
		const root = path.join(os.homedir(), configDir);
		await fs.mkdir(path.join(root, "profiles", "work", "agent"), { recursive: true });
		const listed = listProfiles();
		expect(listed.map(profile => profile.name)).toEqual(["default", "work"]);
		expect(listed.find(profile => profile.name === "work")?.rootDir).toBe(path.join(root, "profiles", "work"));
	});

	it("reports profile existence", async () => {
		expect(profileExists("default")).toBe(false);
		const root = path.join(os.homedir(), configDir);
		await fs.mkdir(path.join(root, "profiles", "work"), { recursive: true });
		expect(profileExists("work")).toBe(true);
	});

	it("keeps XDG-backed named profile state under profile-specific roots", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		// Named profiles only adopt XDG when their *own* XDG path already exists,
		// so the profile location stays stable across activations.
		await fs.mkdir(path.join(process.env.XDG_DATA_HOME, APP_NAME, "profiles", "work"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, APP_NAME, "profiles", "work"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", "work"), { recursive: true });

		setProfile("work");

		expect(getAgentDbPath()).toBe(path.join(process.env.XDG_DATA_HOME, APP_NAME, "profiles", "work", "agent.db"));
		expect(getSessionsDir()).toBe(path.join(process.env.XDG_DATA_HOME, APP_NAME, "profiles", "work", "sessions"));
		expect(getPythonGatewayDir()).toBe(
			path.join(process.env.XDG_STATE_HOME, APP_NAME, "profiles", "work", "python-gateway"),
		);
	});

	it("does not silently switch a named profile to XDG once the base app dir appears", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");

		// Fresh install: XDG vars are set (typical Linux) but no $XDG/veyyon exists yet.
		// First activation must land in ~/<config-dir>/profiles/work because
		// the profile-specific XDG path does not exist.
		setProfile("work");
		const firstAgentDir = getAgentDir();
		expect(firstAgentDir).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));

		// Later, the base XDG app dir materializes (e.g. via `veyyon config init-xdg`
		// migrating only the default-profile data). The named profile must stay
		// in its original location until the user explicitly migrates it.
		await fs.mkdir(path.join(process.env.XDG_DATA_HOME, APP_NAME), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, APP_NAME), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, APP_NAME), { recursive: true });

		setProfile(undefined);
		setProfile("work");
		expect(getAgentDir()).toBe(firstAgentDir);
	});

	it("rejects path-like profile names", () => {
		expect(() => setProfile("../work")).toThrow("Invalid profile");
		expect(() => setProfile("work/team")).toThrow("Invalid profile");
	});

	it("rejects trailing-dot profile names to avoid Windows path collisions", () => {
		for (const name of ["work.", "work.."]) {
			expect(() => setProfile(name)).toThrow("cannot end with");
		}
	});

	it("restores the pre-profile VEYYON_CODING_AGENT_DIR override on reset", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");
		setAgentDir(customAgentDir);
		expect(getAgentDir()).toBe(customAgentDir);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(customAgentDir);

		setProfile("work");
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).not.toBe(customAgentDir);

		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
		// Critical: reset must restore the user's override, not delete it.
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(customAgentDir);
		expect(getAgentDir()).toBe(customAgentDir);
	});

	it("clears VEYYON_CODING_AGENT_DIR on reset when nothing was set originally", () => {
		delete process.env.VEYYON_CODING_AGENT_DIR;
		// Force a baseline snapshot of "no override" via setProfile so a stale
		// module-load snapshot from a previous test cannot leak in.
		setProfile("work");
		setProfile(undefined);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBeUndefined();
	});

	it("propagates VEYYON_CODING_AGENT_DIR on profile switch and reset, never a legacy PI_ key", () => {
		const customAgentDir = path.join(tempRoot, "propagate-agent");
		setAgentDir(customAgentDir);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(customAgentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();

		setProfile("work");
		const workAgentDir = getAgentDir();
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(workAgentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();

		setProfile(undefined);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(customAgentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
	});

	it("ignores a stray dropped PI_CODING_AGENT_DIR and honors VEYYON_CODING_AGENT_DIR", () => {
		setProfile(undefined);
		const veyyonDir = path.join(tempRoot, "veyyon-agent");
		const strayPiDir = path.join(tempRoot, "pi-legacy-agent");
		process.env.VEYYON_CODING_AGENT_DIR = veyyonDir;
		process.env.PI_CODING_AGENT_DIR = strayPiDir;
		try {
			__resetDirsFromEnvForTests();
			// The dropped PI_ alias is not read at all: the VEYYON_ override wins,
			// and the stray PI_ value has zero effect on the resolved agent dir.
			expect(getAgentDir()).toBe(veyyonDir);
		} finally {
			delete process.env.PI_CODING_AGENT_DIR;
		}
	});

	it("honors VEYYON_CODING_AGENT_DIR alone as the agent-dir override", () => {
		setProfile(undefined);
		const veyyonDir = path.join(tempRoot, "veyyon-only-agent");
		process.env.VEYYON_CODING_AGENT_DIR = veyyonDir;
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(veyyonDir);
	});

	it("rejects Windows reserved device names case-insensitively", () => {
		for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM0", "COM9", "lpt1", "LPT9", "CON.txt", "com1.bak"]) {
			expect(() => setProfile(name)).toThrow("Windows reserved device name");
		}
	});

	it("does not restore a profile-derived agent dir as the default baseline", () => {
		// Reproduces a child process that inherited VEYYON_PROFILE=work plus the
		// profile-derived VEYYON_CODING_AGENT_DIR that setProfile propagates to
		// children. The module-load snapshot must not capture that profile dir as
		// the default baseline, or setProfile(undefined) would resolve default
		// mode into the work profile's agent dir.
		setProfile("work");
		const workAgentDir = path.join(os.homedir(), configDir, "profiles", "work", "agent");
		expect(getAgentDir()).toBe(workAgentDir);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(workAgentDir);

		// Re-snapshot exactly as module load would, now that VEYYON_PROFILE and the
		// profile-derived VEYYON_CODING_AGENT_DIR are present in the environment.
		__resetProfileSnapshotForTests();

		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBeUndefined();
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "default", "agent"));
	});
});

describe("profile env + name validation", () => {
	it("resolves a VEYYON_PROFILE value and treats empty/default as the default profile", () => {
		// A concrete profile name resolves to itself.
		expect(resolveProfileEnv("work")).toBe("work");
		// Empty, whitespace-only, and the literal "default" all select the default
		// profile (represented as undefined). A missing value is also the default.
		expect(resolveProfileEnv("")).toBeUndefined();
		expect(resolveProfileEnv("   ")).toBeUndefined();
		expect(resolveProfileEnv("default")).toBeUndefined();
		expect(resolveProfileEnv(undefined)).toBeUndefined();
	});

	it("rejects uppercase profile names so isolation is filesystem-independent", () => {
		// `work` and `WORK` would collide on case-insensitive macOS/Windows but
		// differ on Linux; reject uppercase to keep profile identity stable.
		expect(() => normalizeProfileName("WORK")).toThrow("Invalid profile");
		expect(() => normalizeProfileName("Work")).toThrow("Invalid profile");
		expect(normalizeProfileName("work")).toBe("work");
		expect(normalizeProfileName("work-2.0_a")).toBe("work-2.0_a");
	});
});

describe("dirs module import behavior", () => {
	it("does not scrub inherited macOS malloc logging env variables on import", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-utils-dirs-import-"));
		try {
			const probePath = path.join(root, "probe.ts");
			const dirsUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "dirs.ts")).href;
			await Bun.write(
				probePath,
				[
					`import ${JSON.stringify(dirsUrl)};`,
					"process.stdout.write(JSON.stringify({",
					"	malloc: process.env.MallocStackLogging,",
					"	compact: process.env.MallocStackLoggingNoCompact,",
					"}));",
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			};
			const proc = Bun.spawn([process.execPath, probePath], {
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
			expect(JSON.parse(stdout)).toEqual({
				malloc: "0",
				compact: "0",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("exposes worker-host without loading agent env", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-utils-worker-host-import-"));
		try {
			const workerHostUrl = import.meta.resolve("@veyyon/utils/worker-host");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, ".env"), "VEYYON_WORKER_HOST_PROBE=from-agent-env\n");
			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { declareWorkerHostEntry, workerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					"declareWorkerHostEntry();",
					"process.stdout.write(JSON.stringify({",
					"	envProbe: process.env.VEYYON_WORKER_HOST_PROBE ?? null,",
					"	hostDeclared: workerHostEntry() === Bun.main,",
					"}));",
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				VEYYON_CODING_AGENT_DIR: agentDir,
			};
			delete childEnv.VEYYON_WORKER_HOST_PROBE;
			const proc = Bun.spawn([process.execPath, probePath], {
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
			expect(JSON.parse(stdout)).toEqual({
				envProbe: null,
				hostDeclared: true,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves the default profile in a subprocess when VEYYON_PROFILE is empty or 'default'", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-utils-dirs-default-profile-"));
		const probeConfigDir = `.veyyon-default-profile-${Snowflake.next()}`;
		try {
			const dirsUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "dirs.ts")).href;
			const defaultAgentDir = path.join(os.homedir(), probeConfigDir, "profiles", "default", "agent");

			// An explicitly-empty or literal "default" VEYYON_PROFILE both select the
			// default profile; neither activates a named profile.
			for (const veyyonProfile of ["", "default"]) {
				const probePath = path.join(root, `default-profile-${veyyonProfile || "empty"}.ts`);
				await Bun.write(
					probePath,
					[
						`import { getActiveProfile, getAgentDir } from ${JSON.stringify(dirsUrl)};`,
						"process.stdout.write(JSON.stringify({",
						"	activeProfile: getActiveProfile() ?? null,",
						"	agentDir: getAgentDir(),",
						"}));",
					].join("\n"),
				);

				const childEnv: Record<string, string | undefined> = {
					...process.env,
					VEYYON_CONFIG_DIR: probeConfigDir,
					VEYYON_PROFILE: veyyonProfile,
				};
				delete childEnv.VEYYON_CODING_AGENT_DIR;
				const proc = Bun.spawn([process.execPath, probePath], {
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
				expect(JSON.parse(stdout)).toEqual({
					activeProfile: null,
					agentDir: defaultAgentDir,
				});
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(path.join(os.homedir(), probeConfigDir), { recursive: true, force: true });
		}
	});

	it("honors XDG dir keys from a profile .env applied after the resolver froze", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-utils-profile-env-xdg-"));
		const homeDir = path.join(root, "home");
		const xdgStateRoot = path.join(root, "xdg-state");
		const profileConfigDir = `.veyyon-env-xdg-${Snowflake.next()}`;
		try {
			const envUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "env.ts")).href;
			const dirsUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "dirs.ts")).href;
			const agentDir = path.join(homeDir, profileConfigDir, "profiles", "work", "agent");
			await fs.mkdir(agentDir, { recursive: true });
			// The profile's agent .env sets a directory-affecting key. env.ts parses
			// and applies it to the environment *after* dirs.ts froze the resolver at
			// import time — the exact ordering refreshDirsFromEnv() guards.
			await Bun.write(path.join(agentDir, ".env"), `XDG_STATE_HOME=${xdgStateRoot}\n`);
			// Named profiles only adopt XDG when their own XDG path already exists.
			const xdgProfileRoot = path.join(xdgStateRoot, APP_NAME, "profiles", "work");
			await fs.mkdir(xdgProfileRoot, { recursive: true });

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import ${JSON.stringify(envUrl)};`,
					`import { getActiveProfile, getAgentDir, getPythonGatewayDir } from ${JSON.stringify(dirsUrl)};`,
					"process.stdout.write(JSON.stringify({",
					"	activeProfile: getActiveProfile() ?? null,",
					"	agentDir: getAgentDir(),",
					"	pythonGateway: getPythonGatewayDir(),",
					"}));",
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: homeDir,
				VEYYON_CONFIG_DIR: profileConfigDir,
				VEYYON_PROFILE: "work",
			};
			delete childEnv.VEYYON_CODING_AGENT_DIR;
			delete childEnv.XDG_DATA_HOME;
			delete childEnv.XDG_STATE_HOME;
			delete childEnv.XDG_CACHE_HOME;
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: root,
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
			// Before the fix the frozen resolver ignored the late XDG_STATE_HOME and
			// python-gateway resolved under the home-based agent dir. After the fix
			// it lands under the profile-specific XDG state root.
			expect(JSON.parse(stdout)).toEqual({
				activeProfile: "work",
				agentDir: path.join(homeDir, profileConfigDir, "profiles", "work", "agent"),
				pythonGateway: path.join(xdgProfileRoot, "python-gateway"),
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
