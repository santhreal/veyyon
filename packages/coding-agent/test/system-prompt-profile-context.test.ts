import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	captureDirOverrides,
	getActiveProfileOrDefault,
	getAgentDir,
	getGlobalConfigRootDir,
	getProfileRootDir,
	restoreDirOverrides,
	setProfile,
	TempDir,
} from "@veyyon/utils";

const temp = TempDir.createSync("system-prompt-profile-context-");

afterAll(async () => {
	await temp.remove();
});
const originalDirs = captureDirOverrides();

afterEach(() => {
	restoreDirOverrides(originalDirs);
});

async function renderProfileContext(agentDir: string): Promise<string> {
	const cwd = temp.join("cwd");
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		agentDir,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		activeRepoContext: null,
	});
	return systemPrompt.join("\n\n");
}

function expectedConfigurationBlock(profile: string, agentDir: string): string {
	return [
		"<agent-configuration>",
		`- Active profile: ${profile}`,
		`- Agent directory: ${agentDir}`,
		`- Skills directory: ${path.join(agentDir, "skills")}`,
		`- Global AGENTS.md: ${path.join(getGlobalConfigRootDir(), "AGENTS.md")}`,
		`- Profile AGENTS.md: ${path.join(getProfileRootDir(profile), "agent", "AGENTS.md")}`,
		"</agent-configuration>",
	].join("\n");
}

describe("system prompt profile context", () => {
	/**
	 * The unnamed startup profile is still a real profile named `default`. The
	 * prompt must expose its resolved configuration paths rather than making the
	 * agent infer them from the working directory.
	 */
	it("renders exact default-profile configuration paths", async () => {
		setProfile(undefined);
		const profile = getActiveProfileOrDefault();
		const agentDir = getAgentDir();
		const prompt = await renderProfileContext(agentDir);

		expect(profile).toBe("default");
		expect(prompt).toContain(expectedConfigurationBlock(profile, agentDir));
	});

	/**
	 * Switching profiles must replace every profile-owned path. This catches the
	 * stale-default bug where the profile name changed but skills and AGENTS.md
	 * still pointed at the default profile.
	 */
	it("renders exact nondefault-profile configuration paths", async () => {
		setProfile("prompt-metadata-test");
		const profile = getActiveProfileOrDefault();
		const agentDir = getAgentDir();
		const prompt = await renderProfileContext(agentDir);
		const defaultProfilePath = path.join(getProfileRootDir(undefined), "agent", "AGENTS.md");

		expect(profile).toBe("prompt-metadata-test");
		expect(prompt).toContain(expectedConfigurationBlock(profile, agentDir));
		expect(prompt).not.toContain(`- Profile AGENTS.md: ${defaultProfilePath}`);
	});
});
