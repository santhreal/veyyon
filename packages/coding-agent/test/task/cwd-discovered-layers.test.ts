/**
 * Contract: which of the layers a spawn forwards are discovered from the WORKING DIRECTORY,
 * and which no longer have a project scope at all.
 *
 * WHY THIS SUITE EXISTS. The cwd guards in `task/inherited-collections.ts` and
 * `task/context-inheritance.ts` drop the parent's resolved layer when the child runs somewhere
 * else, so the child re-discovers. That is only load-bearing while the layer really is
 * project-rooted, and the answer has changed under it. Context files and prompt templates still
 * resolve per tree, so for those the guard is the difference between a child reading its own
 * tree and reading its parent's. Rules and skills lost every project scope when `<cwd>/.veyyon`
 * stopped being a capability source, so for those the guard is a no-op: the child re-derives
 * exactly the list it was handed.
 *
 * Each case is a differential across two real trees with distinct bytes on disk, because both
 * failure directions are silent. A cwd-sensitive layer that stops re-resolving gives the child
 * its parent's tree while the prompt claims otherwise. A layer that regains a project scope
 * gives a cloned repository a way to configure the agent reading it, and nothing errors: a rule
 * or a skill simply appears.
 *
 * IF THE LAST TWO REGRESS, it is the second kind, and it is a security regression rather than a
 * tidiness one. Do not "fix" them by re-adding the project scope.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { ruleCapability } from "@veyyon/coding-agent/capability/rule";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { discoverContextFiles, discoverPromptTemplates, discoverSkills } from "@veyyon/coding-agent/sdk";
import { GLOBAL_BODY, PROFILE_BODY, useContextScopeFixture } from "../helpers/context-scope-fixture";

const fixture = useContextScopeFixture("cwd-layers-");

const PROJECT_A_AGENTS = "# Tree A rules\n\nA-only marker: alpha-agents-body.\n";
const PROJECT_B_AGENTS = "# Tree B rules\n\nB-only marker: beta-agents-body.\n";

interface TwoTrees {
	/** The fixture's own project cwd, carrying the "alpha" flavour of every layer. */
	treeA: string;
	/** A second project root under the same isolated home, carrying the "beta" flavour. */
	treeB: string;
	/** Active profile agent dir, the same for both trees. */
	agentDir: string;
	globalAgentsPath: string;
	profileAgentsPath: string;
	/** Tree A's project AGENTS.md, at the repo root one level above `treeA`. */
	treeAAgentsPath: string;
	/** Tree B's project AGENTS.md, at its own root, which is also its cwd. */
	treeBAgentsPath: string;
	resetCaches: () => void;
}

/**
 * Two complete project trees under one isolated home, each carrying its own AGENTS.md,
 * prompt template, rule, and skill (the last through a project-declared extension root, which
 * is the only project scope a session's skill allowlist actually reads).
 */
function twoTrees(profile: string): TwoTrees {
	const f = fixture(profile);
	const treeA = f.cwd;
	const treeB = path.join(f.home, "other-workspace");
	fs.mkdirSync(path.join(treeB, ".git"), { recursive: true });

	f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
	f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
	f.writeFile(f.rootAgentsPath, PROJECT_A_AGENTS);
	const treeBAgentsPath = f.writeFile(path.join(treeB, "AGENTS.md"), PROJECT_B_AGENTS);

	f.writeFile(path.join(treeA, ".veyyon", "prompts", "alpha-prompt.md"), "Alpha project prompt body.\n");
	f.writeFile(path.join(treeB, ".veyyon", "prompts", "beta-prompt.md"), "Beta project prompt body.\n");

	f.writeFile(path.join(treeA, ".veyyon", "rules", "alpha-rule.md"), "Alpha project rule body.\n");
	f.writeFile(path.join(treeB, ".veyyon", "rules", "beta-rule.md"), "Beta project rule body.\n");

	f.writeFile(path.join(treeA, ".veyyon", "settings.json"), JSON.stringify({ extensions: ["./ext"] }));
	f.writeFile(path.join(treeB, ".veyyon", "settings.json"), JSON.stringify({ extensions: ["./ext"] }));
	f.writeFile(
		path.join(treeA, "ext", "skills", "alpha-skill", "SKILL.md"),
		"---\nname: alpha-skill\ndescription: Alpha tree skill\n---\n\nAlpha skill body.\n",
	);
	f.writeFile(
		path.join(treeB, "ext", "skills", "beta-skill", "SKILL.md"),
		"---\nname: beta-skill\ndescription: Beta tree skill\n---\n\nBeta skill body.\n",
	);

	// The profile-rooted half of three of the layers. A cwd change must NOT cost these.
	f.writeFile(
		path.join(f.agentDir, "skills", "profile-skill", "SKILL.md"),
		"---\nname: profile-skill\ndescription: Profile scoped skill\n---\n\nProfile skill body.\n",
	);
	f.writeFile(path.join(f.agentDir, "prompts", "profile-prompt.md"), "Profile prompt body.\n");
	f.writeFile(path.join(f.agentDir, "rules", "profile-rule.md"), "Profile rule body.\n");

	return {
		treeA,
		treeB,
		agentDir: f.agentDir,
		globalAgentsPath: f.globalAgentsPath,
		profileAgentsPath: f.profileAgentsPath,
		treeAAgentsPath: f.rootAgentsPath,
		treeBAgentsPath,
		resetCaches: f.resetCaches,
	};
}

describe("the layers a spawn forwards are cwd-discovered", () => {
	/**
	 * LOCKS OUT: dropping the cwd guard on context files, on the theory that the scopes are
	 * home-rooted and a child can inherit them anywhere. The project scope is a different FILE
	 * per tree, so a child handed the parent's list in another tree reads the wrong project's
	 * rules while the prompt tells it every AGENTS.md is already inlined.
	 *
	 * The two home scopes are asserted present from BOTH trees: that is what makes forcing
	 * rediscovery safe instead of starving the child of its global and profile rules.
	 */
	it("resolves a different project AGENTS.md for each tree, and keeps both home scopes", async () => {
		const t = twoTrees("layers-context-files");

		const fromA = await discoverContextFiles(t.treeA, t.agentDir);
		t.resetCaches();
		const fromB = await discoverContextFiles(t.treeB, t.agentDir);

		// Narrowest first, broadest last. The order is load-bearing rather than
		// cosmetic: the scopes are concatenated in this sequence and the LATER
		// entry wins a conflict, which is what makes "broadest wins, a project
		// file never overrides a home instruction" true. Reverse it and a cloned
		// repository's AGENTS.md silently outranks the operator's own.
		expect(fromA.map(file => file.path)).toEqual([t.treeAAgentsPath, t.profileAgentsPath, t.globalAgentsPath]);
		expect(fromB.map(file => file.path)).toEqual([t.treeBAgentsPath, t.profileAgentsPath, t.globalAgentsPath]);
		expect(fromA.map(file => file.content)).toContain(PROJECT_A_AGENTS);
		expect(fromA.map(file => file.content)).not.toContain(PROJECT_B_AGENTS);
		expect(fromB.map(file => file.content)).toContain(PROJECT_B_AGENTS);
		expect(fromB.map(file => file.content)).not.toContain(PROJECT_A_AGENTS);
	});

	/**
	 * LOCKS OUT: a cwd guard on prompt templates being removed as unnecessary.
	 *
	 * Also pins the no-starvation half: the profile template is present from BOTH trees, so a
	 * child forced to re-discover loses nothing it could not re-derive.
	 */
	it("resolves a different project prompt template for each tree, and keeps the profile one", async () => {
		const t = twoTrees("layers-prompt-templates");

		const fromA = (await discoverPromptTemplates(t.treeA, t.agentDir)).map(template => template.name).sort();
		const fromB = (await discoverPromptTemplates(t.treeB, t.agentDir)).map(template => template.name).sort();

		expect(fromA).toEqual(["alpha-prompt", "profile-prompt"]);
		expect(fromB).toEqual(["beta-prompt", "profile-prompt"]);
	});

	/**
	 * LOCKS IN: rules have NO project scope, so a checked-out tree cannot add one.
	 *
	 * This case used to assert the opposite, and it is the more valuable half of the
	 * pair now. `<cwd>/.veyyon` was a capability source for six kinds of thing, rules
	 * among them, which meant one file in a repository you cloned configured the
	 * agent that was about to read it. `getConfigDirs` returns the profile dir and
	 * nothing else today, and `.cursor/rules`, `.clinerules` and `.agent[s]/rules`
	 * went with it.
	 *
	 * Written as a differential across two real trees because that is what a
	 * regression would look like: not an error, just one tree's rule quietly
	 * appearing. Both trees have a rule file on disk and neither is loaded, while the
	 * profile rule is loaded from both.
	 */
	it("loads no rule out of either project tree, and the same profile rule from both", async () => {
		const t = twoTrees("layers-rules");

		const namesFor = async (cwd: string): Promise<string[]> => {
			t.resetCaches();
			const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
			return result.items.map(rule => rule.name).sort();
		};

		const fromA = await namesFor(t.treeA);
		const fromB = await namesFor(t.treeB);

		expect(fromA).not.toContain("alpha-rule");
		expect(fromB).not.toContain("beta-rule");
		expect(fromA).toContain("profile-rule");
		expect(fromB).toContain("profile-rule");
		// Identical from both trees, which is the property that makes the cwd guard
		// in `inherited-collections.ts` a no-op for rules rather than a correctness
		// requirement: a child that re-discovers gets exactly what it was handed.
		expect(fromA).toEqual(fromB);
	});

	/**
	 * LOCKS IN: a project cannot reach a session's skills by any route.
	 *
	 * Project `.veyyon/skills` was never scanned. The route that DID exist was
	 * `<cwd>/.veyyon/settings.json#extensions`, which named arbitrary package roots
	 * whose `skills/`, `commands/`, `rules/`, `prompts/`, `hooks/`, `tools/` and MCP
	 * were then all loaded. It was the worst instance of the repo-configures-the-agent
	 * defect and it is gone, along with the project settings layer that fed it.
	 *
	 * Both trees declare an extension in their project settings and ship a skill
	 * inside it. Neither is loaded. That is the assertion: the fixture is the attack.
	 */
	it("loads no skill through either tree's project extension settings", async () => {
		const t = twoTrees("layers-skills");

		const namesFor = async (cwd: string): Promise<string[]> => {
			t.resetCaches();
			const result = await discoverSkills(cwd, t.agentDir);
			return result.skills.map(skill => skill.name).sort();
		};

		const fromA = await namesFor(t.treeA);
		const fromB = await namesFor(t.treeB);

		expect(fromA).toEqual(["profile-skill"]);
		expect(fromB).toEqual(["profile-skill"]);
	});
});
