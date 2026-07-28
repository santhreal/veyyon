import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createSubagentSettingsForCwd } from "@veyyon/coding-agent/task/executor";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";

async function writeProjectSettings(cwd: string, values: Record<string, unknown>): Promise<void> {
	const projectAgentDir = getProjectAgentDir(cwd);
	await fs.mkdir(projectAgentDir, { recursive: true });
	await fs.writeFile(path.join(projectAgentDir, "settings.json"), JSON.stringify(values));
}

describe("subagent cwd settings provenance", () => {
	let root: TempDir;
	let projectA: string;
	let projectB: string;
	let agentDir: string;

	beforeEach(async () => {
		root = TempDir.createSync("subagent-settings-cwd-");
		projectA = path.resolve(root.join("project-a"));
		projectB = path.resolve(root.join("project-b"));
		agentDir = path.resolve(root.join("agent"));
		await Promise.all([
			fs.mkdir(projectA, { recursive: true }),
			fs.mkdir(projectB, { recursive: true }),
			fs.mkdir(agentDir, { recursive: true }),
		]);
		await Promise.all([
			writeProjectSettings(projectA, {
				secrets: { enabled: true },
				compaction: { enabled: true },
				read: { summarize: { enabled: false } },
			}),
			writeProjectSettings(projectB, {
				secrets: { enabled: false },
				compaction: { enabled: true },
				read: { summarize: { enabled: false } },
			}),
		]);
	});

	afterEach(async () => {
		await root.remove();
	});

	it("lets a parent in B revive a child in A without importing the parent's project policy", async () => {
		const parentB = await Settings.loadReadOnly({
			cwd: projectB,
			agentDir,
			overrides: { "tools.approvalMode": "ask" },
		});
		expect(parentB.get("secrets.enabled")).toBe(false);

		const childA = await createSubagentSettingsForCwd(parentB, projectA);
		expect(childA.getCwd()).toBe(path.normalize(projectA));
		expect(childA.get("secrets.enabled")).toBe(true);
		expect(childA.get("tools.approvalMode")).toBe("yolo");
		expect(parentB.getCwd()).toBe(path.normalize(projectB));
		expect(parentB.get("secrets.enabled")).toBe(false);
		expect(parentB.get("tools.approvalMode")).toBe("ask");
	});

	it("replaces only project provenance on a live A→B move and keeps the parent in A", async () => {
		const parentA = await Settings.loadReadOnly({ cwd: projectA, agentDir });
		const childA = await createSubagentSettingsForCwd(parentA, projectA);
		expect(childA.get("secrets.enabled")).toBe(true);

		const childB = await childA.cloneForCwd(projectB);
		expect(childB.getCwd()).toBe(path.normalize(projectB));
		expect(childB.get("secrets.enabled")).toBe(false);
		expect(childB.get("async.enabled")).toBe(false);
		expect(childB.get("bash.autoBackground.enabled")).toBe(false);
		expect(childB.get("tools.approvalMode")).toBe("yolo");
		expect(parentA.getCwd()).toBe(path.normalize(projectA));
		expect(parentA.get("secrets.enabled")).toBe(true);
	});

	it("preserves CLI and runtime override provenance while destination project values replace source values", async () => {
		const overlay = path.resolve(root.join("cli-overlay.yml"));
		await fs.writeFile(overlay, "compaction:\n  enabled: false\n");
		const parentA = await Settings.loadReadOnly({
			cwd: projectA,
			agentDir,
			configFiles: [overlay],
			overrides: { "read.summarize.enabled": true },
		});

		const childB = await createSubagentSettingsForCwd(parentA, projectB);
		// Destination project policy replaces A because it was never flattened
		// into an override.
		expect(childB.get("secrets.enabled")).toBe(false);
		// A CLI overlay and a runtime override are genuine higher-precedence layers
		// and therefore survive the destination change.
		expect(childB.get("compaction.enabled")).toBe(false);
		expect(childB.get("read.summarize.enabled")).toBe(true);
	});

	it("retains same-cwd policy as the negative twin", async () => {
		const parentA = await Settings.loadReadOnly({ cwd: projectA, agentDir });
		const childA = await createSubagentSettingsForCwd(parentA, projectA);
		const sameCwd = await childA.cloneForCwd(projectA);

		expect(sameCwd.getCwd()).toBe(path.normalize(projectA));
		expect(sameCwd.get("secrets.enabled")).toBe(true);
		expect(sameCwd.get("read.summarize.enabled")).toBe(false);
	});
});
