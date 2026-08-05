/**
 * Contract: an agent's declared `autoloadSkills` names are matched against the skill set the CHILD
 * will actually run with, and the warning about an unmatched name is only ever emitted where that
 * set is known.
 *
 * WHY THIS SUITE EXISTS. Two defects lived in one line at `task/index.ts`, spelled
 * `resolveAutoloadSkills(agent.autoloadSkills, this.session.skills ?? [], agentName)`:
 *
 * 1. The `??` collapsed "the parent never resolved skills" (`undefined`) into "the parent resolved
 *    zero" (`[]`), which is precisely the distinction `inheritResolvedCollection` in the same module
 *    exists to keep. Matching declared names against a set nobody resolved produced the
 *    "no loaded skill matches" warning at EVERY spawn from such a parent, naming a cause that was
 *    not the real one.
 * 2. It ran BEFORE `spawnCwd` was even computed, so the names were matched against the PARENT
 *    tree's skills no matter where the child was pointed. The sibling `inheritedSkills` call
 *    correctly returns `undefined` for a differing `spawnCwd` so the child rediscovers, which left
 *    two paths in one spawn disagreeing about whose tree counts: a `task(cwd: elsewhere)` child's
 *    own skill was reported MISSING and never injected, while the child went on to discover a skill
 *    of that name it was never told to load.
 *
 * IF THIS REGRESSES both are silent in the way that matters. The frontmatter parses, the spawn
 * succeeds, the tests compile, and the declared skill is simply never in the child's context.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import * as skillsModule from "@veyyon/coding-agent/extensibility/skills";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { logger } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";
import { makeToolSession } from "../helpers/tool-session";

// A spawn writes its session under the ACTIVE PROFILE's agent dir, so without this the suite
// creates them inside the developer's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

const MISSING_WARNING = "Agent declares autoloadSkills that no loaded skill matches; those skills will not load";

function skill(name: string, tree: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: path.join(tree, "ext", "skills", name, "SKILL.md"),
		baseDir: path.join(tree, "ext", "skills", name),
		source: "user",
	};
}

describe("autoloadSkills resolve against the child's skill set", () => {
	let parentTree: string;
	let childTree: string;
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-autoload-scope-"));
		parentTree = path.join(root, "parent-tree");
		childTree = path.join(root, "child-tree");
		await fs.mkdir(parentTree, { recursive: true });
		await fs.mkdir(childTree, { recursive: true });
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async injected => ({
			message: `Content of ${injected.name}`,
			details: { name: injected.name, path: injected.filePath, args: undefined, lineCount: 1 },
		}));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.rm(path.dirname(parentTree), { recursive: true, force: true });
	});

	/** The declaring agent, with `autoloadSkills` naming exactly one skill. */
	function agents(autoloadSkills: string[]): AgentDefinition[] {
		return [{ name: "task", description: "Executing worker", systemPrompt: "", source: "bundled", autoloadSkills }];
	}

	function parentSession(skills: Skill[] | undefined): ToolSession {
		return makeToolSession({
			cwd: parentTree,
			hasUI: false,
			skills,
			settings: Settings.isolated({
				"async.enabled": false,
				"subagent.batch": false,
				"subagent.isolation.mode": "none",
				"subagent.maxRuntimeMs": 0,
			}),
			getSessionFile: () => path.join(parentTree, "parent.jsonl"),
			getSessionSpawns: () => "*",
		});
	}

	/**
	 * Run one spawn end to end through the real executor, with the CHILD session faked so its
	 * resolved skill set is a test input. `childSkills` stands in for what the child's own discovery
	 * would find in the tree it was pointed at.
	 */
	async function spawn(args: {
		autoloadSkills: string[];
		parentSkills: Skill[] | undefined;
		childSkills: Skill[];
		cwd?: string;
	}): Promise<Mock<any>> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: agents(args.autoloadSkills),
			projectAgentsDir: null,
		});
		const childSession = createMockSession(
			({ emit }) => {
				emit(yieldSuccessEvent({ ok: true }, "tool-1"));
			},
			{ skills: args.childSkills },
		);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(childSession));

		const tool = await TaskTool.create(parentSession(args.parentSkills));
		const result = await tool.execute("tc", {
			name: "Child",
			agent: "task",
			task: "Do the work.",
			...(args.cwd ? { cwd: args.cwd } : {}),
		});
		expect(result.isError).toBeFalsy();
		return childSession.sendCustomMessage as Mock<any>;
	}

	/**
	 * LOCKS OUT: `resolveAutoloadSkills` running before `spawnCwd` and matching against
	 * `this.session.skills`, while `inheritedSkills` correctly refused to forward the parent's set
	 * across a cwd change.
	 *
	 * IF THIS REGRESSES: a `task(cwd: <another tree>)` spawn naming a skill that exists only in that
	 * tree gets the "no loaded skill matches" warning and no injection, while the child independently
	 * discovers a skill of that exact name and is never told to load it.
	 */
	it("injects a skill that exists only in the child's tree when the spawn cwd differs", async () => {
		const sendCustomMessage = await spawn({
			autoloadSkills: ["beta-skill"],
			parentSkills: [skill("alpha-skill", parentTree)],
			childSkills: [skill("beta-skill", childTree)],
			cwd: childTree,
		});

		expect(warnings.filter(entry => entry.message === MISSING_WARNING)).toEqual([]);
		expect(sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(sendCustomMessage.mock.calls[0]?.[0]).toEqual({
			customType: "skill-prompt",
			content: "Content of beta-skill",
			display: false,
			details: {
				name: "beta-skill",
				path: path.join(childTree, "ext", "skills", "beta-skill", "SKILL.md"),
			},
		});
	});

	/**
	 * LOCKS OUT: the `?? []` at the same call site.
	 *
	 * IF THIS REGRESSES: every spawn from a session whose skills were never resolved warns that the
	 * agent's declared `autoloadSkills` will not load, blaming the operator's frontmatter for a
	 * resolution that had simply not happened, and drops the skill even though the child finds it.
	 */
	it("does not warn when the parent never resolved skills, and still injects what the child finds", async () => {
		const sendCustomMessage = await spawn({
			autoloadSkills: ["review"],
			parentSkills: undefined,
			childSkills: [skill("review", parentTree)],
		});

		expect(warnings.filter(entry => entry.message === MISSING_WARNING)).toEqual([]);
		expect(sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(sendCustomMessage.mock.calls[0]?.[0]).toEqual({
			customType: "skill-prompt",
			content: "Content of review",
			display: false,
			details: { name: "review", path: path.join(parentTree, "ext", "skills", "review", "SKILL.md") },
		});
	});

	/**
	 * The other half of the distinction: a set that really is empty is a resolved answer, so a
	 * declared name matching nothing in it is real news and the warning must still fire, once, with
	 * the count that makes it diagnosable. Without this, "stop warning on `undefined`" could be
	 * satisfied by never warning at all.
	 */
	it("warns once, naming the missing skill, when the child's resolved set is genuinely empty", async () => {
		const sendCustomMessage = await spawn({
			autoloadSkills: ["review"],
			parentSkills: undefined,
			childSkills: [],
		});

		expect(warnings.filter(entry => entry.message === MISSING_WARNING)).toEqual([
			{ message: MISSING_WARNING, fields: { agent: "task", missing: ["review"], availableCount: 0 } },
		]);
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});
});
