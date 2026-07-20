import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	AgentStorage.resetInstance();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("setCwd does not persist session.workdir", () => {
	it("leaves the profile config.yml session.workdir unchanged after setCwd", async () => {
		const root = makeTempDir("@pi-setcwd-persist-");
		const agentDir = path.join(root, "agent");
		const launchDir = path.join(root, "launch");
		const profileWorkdir = path.join(root, "profile-workdir");
		const liveDir = path.join(root, "live");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(launchDir, { recursive: true });
		fs.mkdirSync(profileWorkdir, { recursive: true });
		fs.mkdirSync(liveDir, { recursive: true });

		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(
			configPath,
			YAML.stringify(
				{
					session: {
						workdir: profileWorkdir,
					},
				},
				null,
				2,
			),
		);

		const settings = await Settings.loadIsolated({ cwd: launchDir, agentDir });
		expect(settings.get("session.workdir")).toBe(profileWorkdir);

		const before = await Bun.file(configPath).text();
		const beforeParsed = YAML.parse(before) as { session?: { workdir?: string } };

		const manager = SessionManager.inMemory(launchDir);
		await manager.setCwd(liveDir, { validate: true });
		expect(manager.getCwd()).toBe(path.resolve(liveDir));

		// Live settings object must also keep the profile value; setCwd never writes it.
		expect(settings.get("session.workdir")).toBe(profileWorkdir);

		const after = await Bun.file(configPath).text();
		const afterParsed = YAML.parse(after) as { session?: { workdir?: string } };
		expect(afterParsed.session?.workdir).toBe(profileWorkdir);
		expect(afterParsed.session?.workdir).toBe(beforeParsed.session?.workdir);
		expect(after).toBe(before);
	});
});
