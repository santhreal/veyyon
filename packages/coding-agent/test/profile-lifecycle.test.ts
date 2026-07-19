import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	getProfileRootDir,
	listProfiles,
	profileExists,
	removeWithRetries,
	resolveGlobalDefaultProfile,
	setProfile,
} from "@veyyon/utils";
import { Snowflake } from "@veyyon/utils/snowflake";
import { YAML } from "bun";
import { createProfile, removeProfile, runProfileCommand } from "../src/cli/profile-cli";

describe("profile lifecycle CLI", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		configDir = `.veyyon-profile-lifecycle-${Snowflake.next()}`;
		process.env.VEYYON_CONFIG_DIR = configDir;
		setProfile(undefined);
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		if (originalProfile) setProfile(originalProfile);
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("lists default and named profiles with paths", async () => {
		await createProfile("work", "blank");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({ action: "list" });

		const output = logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("default");
		expect(output).toContain("work");
		expect(output).toContain(path.join(os.homedir(), configDir, "profiles", "work"));
	});

	it("creates a profile seeded from default config and keybindings", async () => {
		const defaultAgentDir = path.join(os.homedir(), configDir, "profiles", "default", "agent");
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(path.join(defaultAgentDir, "config.yml"), YAML.stringify({ theme: "dark" }, null, 2));
		await Bun.write(
			path.join(defaultAgentDir, "keybindings.yml"),
			YAML.stringify({ "app.session.fork": "ctrl+f" }, null, 2),
		);

		await runProfileCommand({ action: "new", name: "work", from: "default" });

		const workConfig = YAML.parse(
			await Bun.file(path.join(getProfileRootDir("work"), "agent", "config.yml")).text(),
		) as { theme?: string };
		expect(workConfig.theme).toBe("dark");
		const workBindings = YAML.parse(
			await Bun.file(path.join(getProfileRootDir("work"), "agent", "keybindings.yml")).text(),
		) as Record<string, string>;
		expect(workBindings["app.session.fork"]).toBe("ctrl+f");

		workConfig.theme = "light";
		await Bun.write(path.join(getProfileRootDir("work"), "agent", "config.yml"), YAML.stringify(workConfig, null, 2));
		const defaultConfig = YAML.parse(await Bun.file(path.join(defaultAgentDir, "config.yml")).text()) as {
			theme?: string;
		};
		expect(defaultConfig.theme).toBe("dark");
	});

	it("refuses --from a nonexistent profile", async () => {
		await expect(createProfile("work", "missing")).rejects.toThrow('Seed profile "missing" does not exist');
		expect(profileExists("work")).toBe(false);
	});

	it("does not copy sessions or blobs when seeding from default", async () => {
		const defaultAgentDir = path.join(os.homedir(), configDir, "profiles", "default", "agent");
		await fs.mkdir(path.join(defaultAgentDir, "sessions"), { recursive: true });
		await fs.mkdir(path.join(defaultAgentDir, "blobs"), { recursive: true });
		await Bun.write(path.join(defaultAgentDir, "sessions", "old.jsonl"), '{"id":"old"}\n');
		await Bun.write(path.join(defaultAgentDir, "blobs", "deadbeef"), "blob");

		await createProfile("work", "default");

		const workAgentDir = path.join(getProfileRootDir("work"), "agent");
		expect(await Bun.file(path.join(workAgentDir, "sessions", "old.jsonl")).exists()).toBe(false);
		expect(await Bun.file(path.join(workAgentDir, "blobs", "deadbeef")).exists()).toBe(false);
	});

	it("refuses to remove default, active, or without --yes", async () => {
		await createProfile("work", "blank");
		await expect(removeProfile("default")).rejects.toThrow("default");
		await expect(removeProfile("work")).rejects.toThrow("--yes");

		setProfile("work");
		await expect(removeProfile("work", { yes: true })).rejects.toThrow("active");
	});

	it("copies exactly the selected items when seeding with an item set", async () => {
		const defaultAgentDir = path.join(os.homedir(), configDir, "profiles", "default", "agent");
		await fs.mkdir(path.join(defaultAgentDir, "skills", "demo"), { recursive: true });
		await fs.mkdir(path.join(defaultAgentDir, "commands"), { recursive: true });
		await Bun.write(path.join(defaultAgentDir, "AGENTS.md"), "# agents\n");
		await Bun.write(path.join(defaultAgentDir, "mcp.json"), '{"mcpServers":{}}');
		await Bun.write(path.join(defaultAgentDir, "skills", "demo", "SKILL.md"), "# demo\n");
		await Bun.write(path.join(defaultAgentDir, "commands", "go.md"), "go\n");
		await Bun.write(path.join(defaultAgentDir, "config.yml"), YAML.stringify({ theme: "dark" }, null, 2));

		await createProfile("work", "default", new Set(["agents", "skills"]));

		const workAgentDir = path.join(getProfileRootDir("work"), "agent");
		expect(await Bun.file(path.join(workAgentDir, "AGENTS.md")).text()).toBe("# agents\n");
		expect(await Bun.file(path.join(workAgentDir, "skills", "demo", "SKILL.md")).text()).toBe("# demo\n");
		expect(await Bun.file(path.join(workAgentDir, "mcp.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(workAgentDir, "commands", "go.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(workAgentDir, "config.yml")).exists()).toBe(false);
	});

	it("clears the copied display name so two profiles never share one", async () => {
		const defaultAgentDir = path.join(os.homedir(), configDir, "profiles", "default", "agent");
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(
			path.join(defaultAgentDir, "config.yml"),
			YAML.stringify({ theme: "dark", profile: { displayName: "Main" } }, null, 2),
		);

		await createProfile("work", "default");

		const workConfig = YAML.parse(
			await Bun.file(path.join(getProfileRootDir("work"), "agent", "config.yml")).text(),
		) as { theme?: string; profile?: { displayName?: string } };
		expect(workConfig.theme).toBe("dark");
		expect(workConfig.profile?.displayName ?? "").toBe("");
	});

	it("removes a named profile with --yes", async () => {
		await createProfile("work", "blank");
		expect(profileExists("work")).toBe(true);
		await removeProfile("work", { yes: true });
		expect(profileExists("work")).toBe(false);
		expect(listProfiles().map(profile => profile.name)).not.toContain("work");
	});

	it("clears the global launch default when its profile is removed", async () => {
		await createProfile("work", "blank");
		await runProfileCommand({ action: "default", name: "work" });
		expect(resolveGlobalDefaultProfile()).toBe("work");

		// Removing the launch-default profile (from the base profile, so it is not
		// active) must not leave defaultProfile dangling at a deleted directory.
		await removeProfile("work", { yes: true });
		expect(profileExists("work")).toBe(false);
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});

	it("leaves the launch default untouched when a different profile is removed", async () => {
		await createProfile("work", "blank");
		await createProfile("spare", "blank");
		await runProfileCommand({ action: "default", name: "work" });
		expect(resolveGlobalDefaultProfile()).toBe("work");

		await removeProfile("spare", { yes: true });
		expect(resolveGlobalDefaultProfile()).toBe("work");
	});
});

describe("profile keybindings isolation", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		configDir = `.veyyon-profile-kb-${Snowflake.next()}`;
		process.env.VEYYON_CONFIG_DIR = configDir;
		setProfile(undefined);
	});

	afterEach(async () => {
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		if (originalProfile) setProfile(originalProfile);
		__resetProfileSnapshotForTests();
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("keeps keybindings isolated between profiles after seed-once", async () => {
		const defaultAgentDir = path.join(os.homedir(), configDir, "profiles", "default", "agent");
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(
			path.join(defaultAgentDir, "keybindings.yml"),
			YAML.stringify({ "app.session.fork": "ctrl+f" }, null, 2),
		);

		await createProfile("a", "default");
		await createProfile("b", "blank");
		const bAgentDir = path.join(getProfileRootDir("b"), "agent");
		await Bun.write(
			path.join(bAgentDir, "keybindings.yml"),
			YAML.stringify({ "app.session.fork": "alt+b" }, null, 2),
		);

		setProfile("a");
		const managerA = KeybindingsManager.create(getAgentDir(), { seedFromDefault: false });
		expect(managerA.getKeys("app.session.fork")).toEqual(["ctrl+f"]);

		setProfile("b");
		const managerB = KeybindingsManager.create(getAgentDir(), { seedFromDefault: false });
		expect(managerB.getKeys("app.session.fork")).toEqual(["alt+b"]);
	});
});

describe("profile default command", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		configDir = `.veyyon-profile-default-${Snowflake.next()}`;
		process.env.VEYYON_CONFIG_DIR = configDir;
		setProfile(undefined);
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		if (originalProfile) setProfile(originalProfile);
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("sets, shows, and clears the global default profile", async () => {
		await createProfile("work", "blank");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({ action: "default", name: "work" });
		expect(resolveGlobalDefaultProfile()).toBe("work");
		// The write lands in the GLOBAL config root, not a profile.
		const globalConfig = path.join(os.homedir(), configDir, "config.yml");
		expect(await Bun.file(globalConfig).text()).toContain("defaultProfile: work");

		logSpy.mockClear();
		await runProfileCommand({ action: "default", json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({ defaultProfile: "work" });

		await runProfileCommand({ action: "default", clear: true });
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});

	it("refuses a nonexistent profile", async () => {
		await expect(runProfileCommand({ action: "default", name: "missing" })).rejects.toThrow(
			'Profile "missing" does not exist',
		);
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});
});

describe("profile list launch-default marker", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		configDir = `.veyyon-profile-launchdef-${Snowflake.next()}`;
		process.env.VEYYON_CONFIG_DIR = configDir;
		setProfile(undefined);
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		if (originalProfile) setProfile(originalProfile);
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("marks the global launch default in list output and JSON", async () => {
		await createProfile("work", "blank");
		await runProfileCommand({ action: "default", name: "work" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({ action: "list" });
		const text = logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(text).toContain("[launch default]");
		expect(text.split("\n").find(line => line.includes("[launch default]"))).toContain("work");

		logSpy.mockClear();
		await runProfileCommand({ action: "list", json: true });
		const rows = JSON.parse(logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")) as {
			name: string;
			launchDefault: boolean;
		}[];
		expect(rows.find(row => row.name === "work")?.launchDefault).toBe(true);
		expect(rows.find(row => row.name === "default")?.launchDefault).toBe(false);
	});
});
