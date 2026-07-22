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
import { createProfile, removeProfile, runProfileCommand, writeProfileDisplayName } from "../src/cli/profile-cli";

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

	it("seeds the dev preset with ultra instrumentation and argot on", async () => {
		await createProfile("dev", "dev");

		const config = YAML.parse(await Bun.file(path.join(getProfileRootDir("dev"), "agent", "config.yml")).text()) as {
			session?: { instrumentation?: string };
			argot?: { enabled?: boolean };
			profile?: { displayName?: string };
		};
		// The preset writes real settings-schema keys through the Settings
		// singleton, so they land as nested YAML, not dotted strings.
		expect(config.session?.instrumentation).toBe("ultra");
		expect(config.argot?.enabled).toBe(true);
		expect(config.profile?.displayName).toBe("Dev (study)");
	});

	it("dev preset settings load back through Settings at their preset values", async () => {
		const { Settings } = await import("../src/config/settings");
		await createProfile("dev", "dev");

		const settings = await Settings.loadReadOnly({
			agentDir: path.join(getProfileRootDir("dev"), "agent"),
		});
		expect(settings.get("session.instrumentation")).toBe("ultra");
		expect(settings.get("argot.enabled")).toBe(true);
	});

	it("leaves no profile directory behind when seeding fails partway", async () => {
		// Seed from a source whose config.yml is invalid YAML: files copy into the
		// staging dir, then clearCopiedDisplayName throws while parsing it. The
		// profile must not exist and no staging directory may linger, so the user
		// can simply retry rather than being stuck with a corrupt half-profile.
		await createProfile("src", "blank");
		await Bun.write(path.join(getProfileRootDir("src"), "agent", "config.yml"), "profile: [unclosed\n");

		await expect(createProfile("work", "src")).rejects.toThrow("not valid YAML");

		expect(profileExists("work")).toBe(false);
		const profilesDir = path.join(os.homedir(), configDir, "profiles");
		const leftovers = (await fs.readdir(profilesDir)).filter(name => name.includes("work"));
		expect(leftovers).toEqual([]);
	});

	it("refuses to recreate an existing profile and never disturbs its tree", async () => {
		await createProfile("work", "blank");
		// Drop a marker the recreate attempt must not touch.
		const marker = path.join(getProfileRootDir("work"), "agent", "MARKER");
		await Bun.write(marker, "keep-me");

		await expect(createProfile("work", "blank")).rejects.toThrow('Profile "work" already exists');

		// The existing tree survives untouched and no staging dir leaks.
		expect(await Bun.file(marker).text()).toBe("keep-me");
		const profilesDir = path.join(os.homedir(), configDir, "profiles");
		const leftovers = (await fs.readdir(profilesDir)).filter(name => name.startsWith("."));
		expect(leftovers).toEqual([]);
	});

	it("fs.rename onto a non-empty directory fails loud (the create-race backstop)", async () => {
		// createProfile's catch relies on rename REJECTING when the destination is
		// a populated directory (a concurrent create won the TOCTOU race), so the
		// loser cleans up staging and rethrows instead of clobbering the winner.
		// Pin that platform contract: replacing a non-empty dir must reject.
		const base = path.join(os.homedir(), configDir, "rename-backstop");
		const winner = path.join(base, "winner");
		const loser = path.join(base, "loser");
		await fs.mkdir(winner, { recursive: true });
		await Bun.write(path.join(winner, "populated"), "x");
		await fs.mkdir(loser, { recursive: true });

		await expect(fs.rename(loser, winner)).rejects.toMatchObject({ code: "ENOTEMPTY" });
		// The winner's contents are untouched by the failed rename.
		expect(await Bun.file(path.join(winner, "populated")).text()).toBe("x");
	});

	it("renaming the active profile updates the live settings cache immediately", async () => {
		const { Settings, resetSettingsForTest } = await import("../src/config/settings");
		resetSettingsForTest();
		await createProfile("work", "blank");
		setProfile("work");
		const agentDir = path.join(getProfileRootDir("work"), "agent");
		await Settings.init({ agentDir });
		try {
			expect(Settings.instance.get("profile.displayName") ?? "").toBe("");

			await writeProfileDisplayName("work", "Renamed Work");

			// The live singleton reflects the new name with no reload — a rename of
			// the CURRENT profile must not read stale until the next save.
			expect(Settings.instance.get("profile.displayName")).toBe("Renamed Work");
			// And it is persisted to the profile's own config on disk.
			const onDisk = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
				profile?: { displayName?: string };
			};
			expect(onDisk.profile?.displayName).toBe("Renamed Work");
		} finally {
			resetSettingsForTest();
		}
	});

	it("renaming a NON-active profile does not disturb the live singleton", async () => {
		const { Settings, resetSettingsForTest } = await import("../src/config/settings");
		resetSettingsForTest();
		await createProfile("work", "blank");
		await createProfile("spare", "blank");
		setProfile("work");
		await Settings.init({ agentDir: path.join(getProfileRootDir("work"), "agent") });
		try {
			// Rename the OTHER profile; the active singleton's name stays empty and
			// the change lands only in spare's own config file.
			await writeProfileDisplayName("spare", "Spare Name");
			expect(Settings.instance.get("profile.displayName") ?? "").toBe("");
			const spareOnDisk = YAML.parse(
				await Bun.file(path.join(getProfileRootDir("spare"), "agent", "config.yml")).text(),
			) as { profile?: { displayName?: string } };
			expect(spareOnDisk.profile?.displayName).toBe("Spare Name");
		} finally {
			resetSettingsForTest();
		}
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
