/**
 * Contract: an agent's cwd-discovered layers come from the tree it actually runs in.
 *
 * `task/index.ts` forwards `skills`, `promptTemplates`, and `rules` to a child's session
 * options. All three carry a project scope keyed on the working directory (prompt templates from
 * `<cwd>/.veyyon/prompts`, rules from `loadCapability("rules", { cwd })`, which walks the project
 * for `.veyyon/rules`, `.cursor/rules`, `.clinerules` and friends, and skills from the extension
 * roots a project declares in `<cwd>/.veyyon/settings.json#extensions`, which is the one project
 * scope the session skill allowlist reads: project `.veyyon/skills` is deliberately NOT scanned).
 * `test/task/cwd-discovered-layers.test.ts` proves each of those on disk. `sdk.ts` then gates
 * discovery on PRESENCE, so forwarding the parent's lists to a `task(cwd: other)` child both
 * contaminates it with the parent tree's data and stops it loading its own.
 *
 * `inheritContextFiles` already refused this for context files; these three had no guard.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import * as isolationModule from "@veyyon/coding-agent/task/isolation-runner";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

// A spawn writes a session under the ACTIVE PROFILE's agent dir; without this the suite
// writes into the developer's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

// Two REAL directories, because `resolveSpawnCwd` rejects a path that does not exist. Both
// live under the OS temp dir, never under the operator's home or config root.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-spawn-cwd-layers-"));
const parentCwd = path.join(fixtureRoot, "parent-tree");
const otherCwd = path.join(fixtureRoot, "other-tree");
fs.mkdirSync(parentCwd, { recursive: true });
fs.mkdirSync(otherCwd, { recursive: true });

afterAll(() => {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const parentSkills = [{ name: "parent-skill" }] as unknown as ToolSession["skills"];
const parentPromptTemplates = [{ name: "parent-template" }] as unknown as ToolSession["promptTemplates"];
const parentRules = [{ name: "parent-rule" }] as unknown as ToolSession["rules"];
const parentContextFiles = [{ path: path.join(parentCwd, "AGENTS.md"), content: "# parent rules\n", depth: 0 }];

function makeResult(name: string): SingleResult {
	return {
		index: 0,
		id: name,
		agent: "task",
		task: "Work.",
		output: "done",
		exitCode: 0,
		durationMs: 1,
	} as SingleResult;
}

function createParentSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return makeToolSession({
		cwd: parentCwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		skills: parentSkills,
		promptTemplates: parentPromptTemplates,
		rules: parentRules,
		contextFiles: parentContextFiles,
		...overrides,
	});
}

describe("task spawn layer inheritance across a cwd change", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/**
	 * LOCKS OUT: `skills: inheritResolvedCollection(this.session.skills, ...)` computed before
	 * `spawnCwd` and with no cwd comparison, at `task/index.ts`.
	 *
	 * IF THIS REGRESSES: a `task(cwd: other)` child runs the whole session on the PARENT tree's
	 * skills, prompt templates, and rules, and because a present list disables discovery in
	 * `sdk.ts`, it never loads the ones belonging to the tree it was pointed at. Silent: the
	 * child looks fully configured, with the wrong project's configuration.
	 */
	it("hands a child in another tree no layer at all, so it re-discovers its own", async () => {
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("OtherTree"));
		const tool = await TaskTool.create(createParentSession());

		await tool.execute("tc-other-tree", {
			agent: "task",
			name: "OtherTree",
			task: "Work in the other tree.",
			cwd: otherCwd,
		} as TaskParams);

		const options = spy.mock.calls[0]?.[0];
		expect(options?.cwd).toBe(otherCwd);
		expect(options?.skills).toBeUndefined();
		expect(options?.promptTemplates).toBeUndefined();
		expect(options?.rules).toBeUndefined();
		// The same rule the context-file guard already enforced, checked here so a future edit
		// cannot fix one and drop the other.
		expect(options?.contextFiles).toBeUndefined();
	});

	/**
	 * LOCKS OUT: an over-broad guard that makes EVERY spawn re-discover, which would put a full
	 * skills, prompts, and rules scan on the critical path of every subagent launch.
	 */
	it("still inherits every layer unchanged for a child in the parent's own tree", async () => {
		const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("SameTree"));
		const tool = await TaskTool.create(createParentSession());

		await tool.execute("tc-same-tree", {
			agent: "task",
			name: "SameTree",
			task: "Work here.",
		} as TaskParams);

		const options = spy.mock.calls[0]?.[0];
		expect(options?.cwd).toBe(parentCwd);
		expect(options?.skills).toEqual(parentSkills);
		expect(options?.promptTemplates).toEqual(parentPromptTemplates);
		expect(options?.rules).toEqual(parentRules);
		expect(options?.contextFiles).toEqual(parentContextFiles);
	});

	/**
	 * LOCKS OUT: routing the ISOLATION MOUNT path into the cwd guard, which reads as the obvious
	 * next step ("the child runs somewhere else, so it should re-discover") and is wrong twice.
	 *
	 * An isolation mount's post-start invariant is "mirror lower's live working tree", so the
	 * parent's list describes the same content, not another project's. Rediscovering from the
	 * mount would instead LOSE layers: the mount is rooted at the repo root rather than at
	 * `spawnCwd`, so a nested `<cwd>/AGENTS.md` falls out of the walk, and the git-worktree
	 * seeding path copies untracked files through `ls-files --others --exclude-standard`, so a
	 * gitignored project layer is not in the mount to be found at all.
	 *
	 * IF THIS REGRESSES: every isolated subagent silently drops the nested and gitignored halves
	 * of the operator's project rules, which is the same class of loss as the original
	 * `AGENTS.md` filter.
	 */
	it("inherits every layer for an isolated spawn, whose mount mirrors the parent's own tree", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Isolated"));
		vi.spyOn(isolationModule, "prepareIsolationContext").mockResolvedValue({
			repoRoot: parentCwd,
			baseline: { files: {} } as never,
		});
		vi.spyOn(isolationModule, "mergeIsolatedChanges").mockResolvedValue({
			summary: "",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		} as never);
		vi.spyOn(isolationModule, "applyEligibleNestedPatches").mockResolvedValue("");
		// The runner itself is stubbed rather than driven: materialising a real mount needs the
		// native isolation backends and a git repo, and the subject here is what `task/index.ts`
		// PUT in `baseOptions` before the mount exists, which is exactly what the stub captures.
		const isolationSpy = vi
			.spyOn(isolationModule, "runIsolatedSubprocess")
			.mockImplementation(async opts => executorModule.runSubprocess(opts.baseOptions));

		const tool = await TaskTool.create(
			createParentSession({
				settings: Settings.isolated({ "async.enabled": false, "subagent.isolation.mode": "rcopy" }),
			}),
		);

		await tool.execute("tc-isolated", {
			agent: "task",
			name: "Isolated",
			task: "Work in isolation.",
			isolated: true,
		} as TaskParams);

		expect(isolationSpy).toHaveBeenCalledTimes(1);
		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.cwd).toBe(parentCwd);
		expect(options?.contextFiles).toEqual(parentContextFiles);
		expect(options?.skills).toEqual(parentSkills);
		expect(options?.promptTemplates).toEqual(parentPromptTemplates);
		expect(options?.rules).toEqual(parentRules);
	});
});
