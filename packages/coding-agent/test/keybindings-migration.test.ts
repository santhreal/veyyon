import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager, profileHasKeybindingsFile } from "@veyyon/coding-agent/config/keybindings";
import { matchesAppFollowUp } from "@veyyon/coding-agent/modes/utils/keybinding-matchers";
import { type KeybindingsConfig, resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";
import { __resetDirsFromEnvForTests, removeWithRetries, setProfile } from "@veyyon/utils";
import { YAML } from "bun";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

async function writeKeybindingsYaml(agentDir: string, config: KeybindingsConfig): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "keybindings.yml"), YAML.stringify(config, null, 2));
}

describe("KeybindingsManager.create", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		resetKeybindingsForTests();
	});

	it("preserves an unparseable keybindings.yml instead of losing the user's map", async () => {
		// REGRESSION, data loss. A hand-edited keybindings.yml with a syntax error
		// used to load as "no config" with only a debug log, and the migration
		// writer would then put defaults on disk in its place. The user's whole
		// custom map disappeared at the moment they were fixing the file by hand.
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-corrupt-"));
		const ymlPath = path.join(agentDir, "keybindings.yml");
		const broken = ["fork: ctrl+f", "selectConfirm: enter: extra"].join("\n");
		await Bun.write(ymlPath, broken);

		try {
			KeybindingsManager.create(agentDir);

			expect(await Bun.file(`${ymlPath}.corrupt`).text()).toBe(broken);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates legacy keybinding JSON to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`${JSON.stringify(
				{
					fork: "ctrl+f",
					selectConfirm: "enter",
					cursorUp: "ctrl+p",
					selectModelTemporary: "alt+y",
				},
				null,
				2,
			)}\n`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.model.selectTemporary")).toEqual(["alt+y"]);
			expect(writtenConfig).toEqual({
				"app.model.selectTemporary": "alt+y",
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(writtenConfig).not.toHaveProperty("selectModelTemporary");
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates legacy keybinding JSON with comments to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`{
	// Legacy config files may contain comments from hand-edited examples.
	"fork": "ctrl+f",
	"selectConfirm": "enter",
	"cursorUp": "ctrl+p",
	"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"]
}
`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
			expect(writtenConfig).toEqual({
				"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("loads keybindings.yml directly", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const configPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			configPath,
			YAML.stringify(
				{
					"app.session.fork": "ctrl+f",
					"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("accepts keybindings.yaml when present", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const yamlPath = path.join(agentDir, "keybindings.yaml");
		const canonicalPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			yamlPath,
			YAML.stringify(
				{
					"app.plan.toggle": "alt+shift+p",
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.plan.toggle")).toEqual(["alt+shift+p"]);
			expect(await Bun.file(canonicalPath).exists()).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("does not inherit default user keybindings for a named profile without its own file", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { seedFromDefault: false });

			expect(manager.getKeys("app.session.fork")).toEqual([]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("uses only profile keybindings when both default and profile files exist", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"app.session.new": "ctrl+n",
		});
		await writeKeybindingsYaml(profileAgentDir, {
			"app.session.fork": "alt+f",
			"app.clipboard.copyLine": "alt+l",
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { seedFromDefault: false });

			expect(manager.getKeys("app.session.new")).toEqual([]);
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("seeds default keybindings into a named profile on first create when missing", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "profiles", "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
		});
		await fs.mkdir(profileAgentDir, { recursive: true });

		const originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		try {
			process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), rootDir);
			__resetDirsFromEnvForTests();
			setProfile("work");

			const manager = KeybindingsManager.create();
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(await Bun.file(path.join(profileAgentDir, "keybindings.yml")).exists()).toBe(true);
		} finally {
			if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
			else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
			setProfile(undefined);
			__resetDirsFromEnvForTests();
			await removeWithRetries(rootDir);
		}
	});

	it("does not re-seed profile keybindings on second create", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, { "app.session.fork": "ctrl+f" });
		await fs.mkdir(profileAgentDir, { recursive: true });

		const originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		try {
			process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), rootDir);
			__resetDirsFromEnvForTests();
			setProfile("work");

			KeybindingsManager.create();
			await Bun.write(
				path.join(profileAgentDir, "keybindings.yml"),
				YAML.stringify({ "app.session.fork": "alt+f" }, null, 2),
			);

			const manager = KeybindingsManager.create();
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
		} finally {
			if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
			else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
			setProfile(undefined);
			__resetDirsFromEnvForTests();
			await removeWithRetries(rootDir);
		}
	});

	it("defaults model selection to Alt+M and display reset to Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory();

		expect(manager.getKeys("app.model.select")).toEqual(["alt+m"]);
		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("keeps the Ctrl+L display reset default when an old model remap still claims Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory({
			"app.model.select": "ctrl+l",
		});

		expect(manager.getKeys("app.model.select")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
		expect(manager.getEffectiveConfig()["app.display.reset"]).toBe("ctrl+l");
	});

	it("keeps Ctrl+L when the user explicitly assigns it to display reset", () => {
		const manager = KeybindingsManager.inMemory({
			"app.display.reset": "ctrl+l",
		});

		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("defaults the follow-up shortcut to both Ctrl+Q and Ctrl+Enter (#1903)", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));

		try {
			const manager = KeybindingsManager.create(agentDir);

			// Both chords must be registered so Windows Terminal users (which swallow
			// Ctrl+Enter at the terminal layer) get a working follow-up binding out
			// of the box, without breaking users on Kitty/iTerm2/WezTerm/Ghostty.
			expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("removes the Ctrl+Q follow-up default when a user remap already claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.plan.toggle": "ctrl+q",
		});
		setKeybindings(manager);

		expect(manager.getKeys("app.plan.toggle")).toEqual(["ctrl+q"]);
		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+enter"]);
		expect(manager.getDisplayString("app.message.followUp")).toBe("Ctrl+Enter");
		expect(manager.getEffectiveConfig()["app.message.followUp"]).toBe("ctrl+enter");
		expect(matchesAppFollowUp(ctrl("q"))).toBe(false);
		expect(matchesAppFollowUp("\x1b[13;5u")).toBe(true);
	});

	it("keeps the Ctrl+Q follow-up default when only an unknown config key claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"unknown.action": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
	});

	it("keeps Ctrl+Q when the user explicitly assigns it to follow-up (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.message.followUp": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q"]);
	});

	it("writes the migrated keybindings file atomically (owner-only, no temp leftover)", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-atomic-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		// A legacy JSON triggers the write-back to keybindings.yml on create().
		await Bun.write(jsonPath, `${JSON.stringify({ fork: "ctrl+f" }, null, 2)}\n`);

		try {
			const manager = KeybindingsManager.create(agentDir);
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);

			// The atomic sync writer defaults to mode 0o600 (owner-only). A raw
			// fs.writeFileSync would have created the file at the umask default
			// (~0o644), so the exact mode proves the atomic path was taken.
			const stat = await fs.stat(ymlPath);
			expect(stat.mode & 0o777).toBe(0o600);

			// The temp file the atomic write stages under is renamed into place,
			// so no stray sibling may linger in the agent dir.
			const entries = await fs.readdir(agentDir);
			expect(entries.sort()).toEqual(["keybindings.json", "keybindings.yml"]);

			// The file is complete and parses to the exact migrated config.
			const written = YAML.parse(await Bun.file(ymlPath).text());
			expect(written).toEqual({ "app.session.fork": "ctrl+f" });
		} finally {
			await removeWithRetries(agentDir);
		}
	});
});

/**
 * profileHasKeybindingsFile is the discovery predicate that decides whether a profile directory
 * already carries a user keybindings file. It accepts three names: the current keybindings.yml, the
 * alternate keybindings.yaml spelling, and the legacy keybindings.json. It had no direct test. A
 * regression that dropped any one of these names would make the profile look empty and silently
 * overwrite the user's real bindings with defaults (the same data-loss class the migration tests
 * above guard). An empty directory must report false.
 */
describe("profileHasKeybindingsFile", () => {
	it("returns false for a directory with no keybindings file", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-kb-none-"));
		try {
			expect(profileHasKeybindingsFile(agentDir)).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("recognizes each accepted filename: keybindings.yml, keybindings.yaml, and legacy keybindings.json", async () => {
		for (const filename of ["keybindings.yml", "keybindings.yaml", "keybindings.json"]) {
			const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-kb-one-"));
			try {
				await Bun.write(path.join(agentDir, filename), "fork: ctrl+f\n");
				expect(profileHasKeybindingsFile(agentDir)).toBe(true);
			} finally {
				await removeWithRetries(agentDir);
			}
		}
	});

	it("does not treat an unrelated file as a keybindings file", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-kb-other-"));
		try {
			await Bun.write(path.join(agentDir, "settings.yml"), "x: 1\n");
			expect(profileHasKeybindingsFile(agentDir)).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});
});
