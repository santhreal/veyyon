/**
 * Locks out the bare `catch {}` around the plugin commands `fs.stat` in
 * `discovery/claude-plugins.ts`.
 *
 * The catch existed for the legitimate case: a plugin that declares no commands
 * directory. But it swallowed every stat error alike, so a commands path that
 * exists and cannot be read (a permission denial, a path component that is a
 * file rather than a directory, a broken mount) produced the same result as a
 * plugin with no commands at all: zero items and zero warnings. The operator's
 * plugin slash commands simply stopped existing, with nothing in `warnings`
 * naming the path or the reason.
 *
 * If this regresses, an unreadable plugin commands path becomes silent again and
 * the only symptom is a slash command that is missing from the menu.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings, loadCapability } from "@veyyon/coding-agent/capability";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import type { SlashCommand } from "@veyyon/coding-agent/capability/slash-command";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@veyyon/coding-agent/discovery/helpers";
import { removeWithRetries } from "@veyyon/utils";
import "@veyyon/coding-agent/discovery/claude-plugins";

let tempDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
	// claude-plugins is a foreign provider behind the default-off master toggle.
	initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": true }));
	clearClaudePluginRootsCache();
	clearFsCache();
	originalHome = process.env.HOME;
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-unreadable-"));
	process.env.HOME = tempDir;
	vi.spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(async () => {
	clearClaudePluginRootsCache();
	clearFsCache();
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await removeWithRetries(tempDir);
	initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": false }));
});

/**
 * Install one plugin whose manifest points `slash-commands` at `commandsEntry`,
 * plus a second, healthy plugin so the "other plugins still load" half of the
 * contract has something to assert on.
 */
async function installPlugins(commandsEntry: string): Promise<void> {
	const pluginsDir = path.join(tempDir, ".claude", "plugins");
	const brokenPath = path.join(tempDir, "plugins", "broken-commands");
	const healthyPath = path.join(tempDir, "plugins", "healthy-commands");
	await fs.mkdir(pluginsDir, { recursive: true });
	await fs.mkdir(path.join(brokenPath, ".claude-plugin"), { recursive: true });
	await fs.mkdir(path.join(healthyPath, "commands"), { recursive: true });

	// A regular file where the manifest expects a directory component, so
	// `fs.stat` fails with ENOTDIR rather than ENOENT.
	await fs.writeFile(path.join(brokenPath, "not-a-dir"), "this is a file\n");
	await fs.writeFile(
		path.join(brokenPath, ".claude-plugin", "plugin.json"),
		JSON.stringify({ "slash-commands": commandsEntry }),
	);
	await fs.writeFile(path.join(healthyPath, "commands", "deploy.md"), "Deploy it\n");

	const registry = {
		version: 2,
		plugins: {
			"broken-commands@market": [
				{
					scope: "user",
					installPath: brokenPath,
					version: "1.0.0",
					installedAt: "2025-01-01T00:00:00Z",
					lastUpdated: "2025-01-01T00:00:00Z",
				},
			],
			"healthy-commands@market": [
				{
					scope: "user",
					installPath: healthyPath,
					version: "1.0.0",
					installedAt: "2025-01-01T00:00:00Z",
					lastUpdated: "2025-01-01T00:00:00Z",
				},
			],
		},
	};
	await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
}

describe("An unreadable plugin commands path is reported, not read as an empty plugin", () => {
	test("warns with the path and the reason", async () => {
		await installPlugins("./not-a-dir/commands");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });

		const reported = result.warnings.filter(w => w.includes("Failed to read plugin commands path"));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain(path.join("not-a-dir", "commands"));
		expect(reported[0]).toContain("ENOTDIR");
	});

	/** Fail-soft: the broken plugin must not cost the healthy one its commands. */
	test("still loads the other plugins", async () => {
		await installPlugins("./not-a-dir/commands");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });

		expect(result.all.find(command => command.name === "healthy-commands:deploy")).toBeDefined();
	});

	/**
	 * The expected case that the catch was there for in the first place: a plugin
	 * that declares a commands directory it does not ship is not an error, and
	 * must not produce a warning.
	 */
	test("says nothing when the commands directory is merely absent", async () => {
		await installPlugins("./no-such-directory");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });

		expect(result.warnings.filter(w => w.includes("Failed to read plugin commands path"))).toEqual([]);
		expect(result.all.find(command => command.name === "healthy-commands:deploy")).toBeDefined();
	});
});
