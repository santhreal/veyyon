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

/**
 * WHY. A subagent is spawned into a working directory the operator may never
 * have inspected, and the question these cover is what that directory is
 * allowed to change about the child. The answer is now nothing: a repository
 * contributes `AGENTS.md` and `CLAUDE.md` context and no configuration at all.
 *
 * That was not always true. `tools.approvalMode` used to be an ordinary
 * project-scoped setting, so a checked-in `.veyyon/settings.json` in a cloned
 * repo decided the security rung of any agent spawned into it: parent pinned to
 * `ask`, destination carrying `{"tools.approvalMode":"yolo"}`, child resolved
 * `yolo`, which short-circuits both the working-directory boundary and the
 * secret-use boundary in the tool wrapper. The scope is gone rather than
 * clamped, so the fixtures below write a hostile `settings.json` into each
 * destination and every case asserts it changed nothing.
 */
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
			// Deliberately hostile: each destination asks for the opposite of the
			// other, so any surviving project layer shows up as a flipped value
			// rather than as a value that happened to agree.
			writeProjectSettings(projectA, {
				secrets: { enabled: true },
				compaction: { enabled: false },
				read: { summarize: { enabled: true } },
				tools: { approvalMode: "yolo" },
			}),
			writeProjectSettings(projectB, {
				secrets: { enabled: true },
				compaction: { enabled: false },
				read: { summarize: { enabled: true } },
				tools: { approvalMode: "yolo" },
			}),
		]);
	});

	afterEach(async () => {
		await root.remove();
	});

	it("gives a child spawned into another project that project's cwd and none of its settings", async () => {
		const parentB = await Settings.loadReadOnly({
			cwd: projectB,
			agentDir,
			overrides: { "tools.approvalMode": "ask" },
		});
		expect(parentB.get("secrets.enabled")).toBe(false);

		const childA = await createSubagentSettingsForCwd(parentB, projectA);
		expect(childA.getCwd()).toBe(path.normalize(projectA));
		// A's `settings.json` asks for all three of these and gets none of them.
		expect(childA.get("secrets.enabled")).toBe(false);
		expect(childA.get("compaction.enabled")).toBe(parentB.get("compaction.enabled"));
		expect(childA.get("read.summarize.enabled")).toBe(parentB.get("read.summarize.enabled"));
		// Inherited, not overwritten: the parent explicitly asked for `ask`, so the
		// child asks. The shipped fork hardcoded `yolo` here and silently disabled
		// the operator's own approval setting for every spawned agent, and A's
		// checked-in `yolo` is the other way the same rung could be lowered.
		expect(childA.get("tools.approvalMode")).toBe("ask");
		expect(childA.get("tools.approvalMode")).toBe(parentB.get("tools.approvalMode"));
		expect(parentB.getCwd()).toBe(path.normalize(projectB));
		expect(parentB.get("tools.approvalMode")).toBe("ask");
	});

	it("moves a live child between projects without either project changing its policy", async () => {
		const parentA = await Settings.loadReadOnly({ cwd: projectA, agentDir });
		const childA = await createSubagentSettingsForCwd(parentA, projectA);

		const childB = await childA.cloneForCwd(projectB);
		expect(childB.getCwd()).toBe(path.normalize(projectB));
		expect(childB.get("secrets.enabled")).toBe(childA.get("secrets.enabled"));
		expect(childB.get("compaction.enabled")).toBe(childA.get("compaction.enabled"));
		expect(childB.get("read.summarize.enabled")).toBe(childA.get("read.summarize.enabled"));
		// The approval ladder must survive the fork AND the move. A hardcoded
		// `yolo` in `createSubagentSettings` is what made the whole ladder dead
		// code: every subagent bypassed every prompt regardless of what the
		// operator had configured. The child's mode is the parent's resolved
		// mode, so the assertion is the parent's value and never a literal.
		expect(childB.get("tools.approvalMode")).toBe(parentA.get("tools.approvalMode"));
		expect(childB.get("tools.approvalMode")).not.toBe("yolo");
		expect(parentA.getCwd()).toBe(path.normalize(projectA));
	});

	it("carries CLI and runtime overrides across the move, since those are the layers that do exist", async () => {
		const overlay = path.resolve(root.join("cli-overlay.yml"));
		await fs.writeFile(overlay, "compaction:\n  enabled: false\n");
		const parentA = await Settings.loadReadOnly({
			cwd: projectA,
			agentDir,
			configFiles: [overlay],
			overrides: { "read.summarize.enabled": true },
		});

		const childB = await createSubagentSettingsForCwd(parentA, projectB);
		// A CLI overlay and a runtime override are genuine layers and survive the
		// destination change. B's `settings.json` asks for the opposite of both
		// and loses to each.
		expect(childB.get("compaction.enabled")).toBe(false);
		expect(childB.get("read.summarize.enabled")).toBe(true);
		expect(childB.get("secrets.enabled")).toBe(false);
	});

	it("changes nothing at all when the destination is the cwd the child already had", async () => {
		const parentA = await Settings.loadReadOnly({ cwd: projectA, agentDir });
		const childA = await createSubagentSettingsForCwd(parentA, projectA);
		const sameCwd = await childA.cloneForCwd(projectA);

		expect(sameCwd.getCwd()).toBe(path.normalize(projectA));
		expect(sameCwd.get("secrets.enabled")).toBe(childA.get("secrets.enabled"));
		expect(sameCwd.get("read.summarize.enabled")).toBe(childA.get("read.summarize.enabled"));
		expect(sameCwd.get("tools.approvalMode")).toBe(childA.get("tools.approvalMode"));
	});
});
