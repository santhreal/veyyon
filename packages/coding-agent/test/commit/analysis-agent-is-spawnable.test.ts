import { describe, expect, it } from "bun:test";
import { commitAnalysisSpawnTarget, createCommitTools } from "@veyyon/coding-agent/commit/agentic/tools";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import { resolveEnabledSubagents } from "@veyyon/coding-agent/task/subagent-settings";

/**
 * The commit agent fans file analysis out to subagents, and the only thing that
 * has to be true of the agent it names is that this profile can actually spawn
 * it.
 *
 * It named the literal `sonic`, three times over: as the session's `spawns`
 * capability, as the `agent` field of every spawn, and in the tool description.
 * `sonic` is a bundled specialist, so it ships DISABLED, which means the default
 * profile was already the broken configuration. The spawn was permitted by the
 * capability and then refused by the enablement check, once per file, and the
 * refusals were flattened into the analysis text the commit message gets written
 * from. A commit still came out. It came out without the evidence it presents
 * itself as based on, and nothing anywhere said so.
 *
 * So these assert MEMBERSHIP, never equality against a name. A test pinning the
 * answer to `sonic`, or to `deep`, would pass today and rot at the next rename,
 * which is the same mistake as the literal it is meant to guard. The property is
 * stated twice at two depths:
 *
 *  - the name is in the enabled catalog for those settings; and
 *  - the commit session's own spawn policy, which is that single name, still
 *    intersects the enabled catalog. That intersection is what was empty before.
 *    Checking only the first would pass on a `spawns` capability that named
 *    something else, which is exactly the two-literals-drift the fix removes.
 *
 * The empty case is the other half of "not a silent no-op": when nothing at all
 * is spawnable there is no substitute to fall back to, so `analyze_files` must
 * not be in the tool set. Offering a tool whose every call is refused is the
 * defect; withholding it makes the commit agent work from the diff it already
 * has.
 */

const AUTH_STORAGE = {} as unknown as AuthStorage;
const MODEL_REGISTRY = {} as unknown as ModelRegistry;

/** The agent names this profile will actually spawn, from the one authority on that. */
function enabledNames(settings: Settings): string[] {
	return resolveEnabledSubagents({ settings, agents: loadBundledAgents() }).agents.map(agent => agent.name);
}

/** Build the commit tool set the way `runCommitAgentSession` does, and name the tools. */
function commitToolNames(settings: Settings): string[] {
	return createCommitTools({
		cwd: "/tmp",
		authStorage: AUTH_STORAGE,
		modelRegistry: MODEL_REGISTRY,
		settings,
		state: { diffText: "" },
		changelogTargets: [],
		enableAnalyzeFiles: true,
	}).map(tool => tool.name);
}

describe("the agent the commit flow analyzes files with", () => {
	it.each([
		["the shipped default, where the old literal was already disabled", {}],
		["sonic explicitly on", { sonic: { enabled: true } }],
		["sonic off and a specialist on instead", { sonic: { enabled: false }, scout: { enabled: true } }],
		[
			"sonic off, the default worker off, one specialist left",
			{ deep: { enabled: false }, librarian: { enabled: true } },
		],
		["a single specialist and nothing else", { deep: { enabled: false }, designer: { enabled: true } }],
	])("is one this profile can spawn: %s", (_label, agents) => {
		const settings = Settings.isolated({ "subagent.agents": agents });
		const enabled = enabledNames(settings);

		const target = commitAnalysisSpawnTarget(settings);

		expect(target).toBeDefined();
		expect(enabled).toContain(target as string);
		// The session's spawn capability is that one name. Resolving the catalog
		// through it has to leave something, or the commit agent is a session
		// permitted to spawn exactly one agent it is then refused.
		const throughTheCapability = resolveEnabledSubagents({
			settings,
			agents: loadBundledAgents(),
			parentSpawns: target,
		});
		expect(throughTheCapability.agents.map(agent => agent.name)).toEqual([target as string]);
		expect(commitToolNames(settings)).toContain("analyze_files");
	});

	it("prefers the cheap lane when the operator has it on, since one file is all it summarizes", () => {
		const settings = Settings.isolated({ "subagent.agents": { sonic: { enabled: true } } });
		const target = commitAnalysisSpawnTarget(settings);

		expect(target).toBe("sonic");
		expect(enabledNames(settings)).toContain("sonic");
	});

	it.each([
		[
			"every bundled agent turned off",
			{ "subagent.agents": Object.fromEntries(loadBundledAgents().map(a => [a.name, { enabled: false }])) },
		],
		["subagents disabled wholesale", { "subagent.enabled": false }],
	])("withholds the tool rather than offering one every call is refused: %s", (_label, overrides) => {
		const settings = Settings.isolated(overrides);

		expect(enabledNames(settings)).toEqual([]);
		expect(commitAnalysisSpawnTarget(settings)).toBeUndefined();
		expect(commitToolNames(settings)).not.toContain("analyze_files");
	});
});
