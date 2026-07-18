import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@veyyon/coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@veyyon/coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@veyyon/utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalVeyyonProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
		originalVeyyonProfileEnv = process.env.VEYYON_PROFILE;
		originalPiProfileEnv = process.env.VEYYON_PROFILE;
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".veyyon", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".veyyon"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".veyyon", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("VEYYON_PROFILE", originalVeyyonProfileEnv);
		restoreEnvValue("VEYYON_PROFILE", originalPiProfileEnv);
		restoreEnvValue("VEYYON_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});
});
