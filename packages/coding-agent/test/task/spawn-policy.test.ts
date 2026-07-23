import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import { DEFAULT_SPAWN_AGENT, resolveSpawnPolicy } from "../../src/task/spawn-policy";
import type { AgentDefinition } from "../../src/task/types";
import { getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { makeToolSession } from "../helpers/tool-session";

/**
 * resolveSpawnPolicy is the single interpreter of a parent agent's `spawns`
 * frontmatter. Every spawn-gating decision (whether a subagent may be spawned,
 * which agent answers an omitted agent field, and the exact allow-list text used
 * in rejection messages and prompt descriptions) flows through it, so its
 * branch table must be pinned exactly. These tests were missing.
 *
 * The contract has three shapes, and a regression in any one silently changes
 * who can spawn what:
 *   - unrestricted (`true`/`null`/`undefined`/`"*"`, whitespace-tolerant):
 *     enabled, defaultAgent = "task", allowedAgents = null (sentinel for "no
 *     restriction", distinct from an empty list), allowedErrorText = "*", and NO
 *     allowedPromptText key.
 *   - disabled (`false`, `""`, or all-whitespace): NOT enabled, allowedAgents =
 *     [] (empty list, not null), a human "none ..." error string, and no prompt
 *     text.
 *   - explicit list: enabled, defaultAgent = the FIRST listed agent, entries
 *     trimmed and empties dropped, error text = comma-joined, prompt text =
 *     backtick-quoted comma-space-joined.
 *
 * The null-vs-[] distinction for allowedAgents is load-bearing: callers treat
 * null as "allow any" and [] as "allow none", so the assertions use toEqual on
 * the whole object to catch a branch that returns the wrong empty value or leaks
 * an allowedPromptText key where there should be none.
 */

describe("resolveSpawnPolicy", () => {
	it("exposes 'task' as the default spawn agent", () => {
		expect(DEFAULT_SPAWN_AGENT).toBe("task");
	});

	describe("unrestricted policy", () => {
		const unrestricted = {
			enabled: true,
			defaultAgent: "task",
			allowedAgents: null,
			allowedErrorText: "*",
		};

		it("treats boolean true as unrestricted", () => {
			expect(resolveSpawnPolicy(true)).toEqual(unrestricted);
		});

		it("treats null as unrestricted (frontmatter key present but empty)", () => {
			expect(resolveSpawnPolicy(null)).toEqual(unrestricted);
		});

		it("treats undefined (no frontmatter key) as unrestricted", () => {
			expect(resolveSpawnPolicy(undefined)).toEqual(unrestricted);
		});

		it("treats a literal '*' as unrestricted", () => {
			expect(resolveSpawnPolicy("*")).toEqual(unrestricted);
		});

		it("trims surrounding whitespace before matching '*'", () => {
			expect(resolveSpawnPolicy("  *  ")).toEqual(unrestricted);
		});

		it("does not carry an allowedPromptText key when unrestricted", () => {
			expect("allowedPromptText" in resolveSpawnPolicy(true)).toBe(false);
		});
	});

	describe("disabled policy", () => {
		const disabled = {
			enabled: false,
			defaultAgent: "task",
			allowedAgents: [],
			allowedErrorText: "none (spawns disabled for this agent)",
		};

		it("disables spawning for boolean false", () => {
			expect(resolveSpawnPolicy(false)).toEqual(disabled);
		});

		it("disables spawning for an empty string", () => {
			expect(resolveSpawnPolicy("")).toEqual(disabled);
		});

		it("disables spawning for an all-whitespace string", () => {
			expect(resolveSpawnPolicy("   ")).toEqual(disabled);
		});

		it("returns an empty array (not null) for allowedAgents when disabled", () => {
			// null means "allow any"; [] means "allow none". These must not be conflated.
			const policy = resolveSpawnPolicy(false);
			expect(policy.allowedAgents).toEqual([]);
			expect(policy.allowedAgents).not.toBeNull();
		});
	});

	describe("explicit allow-list policy", () => {
		it("parses a comma list, using the first agent as the default", () => {
			expect(resolveSpawnPolicy("code-reviewer, tester")).toEqual({
				enabled: true,
				defaultAgent: "code-reviewer",
				allowedAgents: ["code-reviewer", "tester"],
				allowedErrorText: "code-reviewer,tester",
				allowedPromptText: "`code-reviewer`, `tester`",
			});
		});

		it("trims whitespace around each listed agent", () => {
			expect(resolveSpawnPolicy(" a , b ")).toEqual({
				enabled: true,
				defaultAgent: "a",
				allowedAgents: ["a", "b"],
				allowedErrorText: "a,b",
				allowedPromptText: "`a`, `b`",
			});
		});

		it("drops empty entries produced by consecutive commas", () => {
			expect(resolveSpawnPolicy("foo,,bar")).toEqual({
				enabled: true,
				defaultAgent: "foo",
				allowedAgents: ["foo", "bar"],
				allowedErrorText: "foo,bar",
				allowedPromptText: "`foo`, `bar`",
			});
		});

		it("handles a single-agent allow list", () => {
			expect(resolveSpawnPolicy("foo")).toEqual({
				enabled: true,
				defaultAgent: "foo",
				allowedAgents: ["foo"],
				allowedErrorText: "foo",
				allowedPromptText: "`foo`",
			});
		});
	});
});

/**
 * These pin the two operator-facing surfaces that CONSUME a resolved spawn policy: the task
 * tool's argument schema (the omitted `agent` field must default to the first allowed spawn,
 * not the built-in "task") and the task tool's description text (it must name the restricted
 * default and enumerate the allow-list, and must NOT still advertise the generic `task` worker
 * once a restriction is in place). A regression in resolveSpawnPolicy that produced the wrong
 * default would surface here as a schema/description mismatch. Merged from the former
 * src/task/spawn-policy.test.ts so this module has a single suite.
 */
const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSpawnSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return makeToolSession({
		settings,
		getSessionSpawns: () => spawns,
	});
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });
		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});

	it("renders the restricted spawn default in the task description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSpawnSession("fact-finder,oracle"));
		const description = tool.description;

		expect(description).toContain("the general-purpose worker (`fact-finder`)");
		expect(description).toContain("Current spawn policy allows: `fact-finder`, `oracle`.");
		expect(description).not.toContain("(`task`)");
	});
});
