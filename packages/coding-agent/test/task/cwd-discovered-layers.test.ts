/**
 * Contract: the four layers a spawn forwards to a child are discovered from the WORKING
 * DIRECTORY, which is the premise the cwd guard in `task/inherited-collections.ts` and
 * `task/context-inheritance.ts` rests on.
 *
 * WHY THIS SUITE EXISTS. Those guards drop the parent's resolved layer when the child runs
 * somewhere else, so the child re-discovers. That is only correct while the layer really is
 * project-rooted. A guard on an agent-dir-rooted layer would be pure loss: it would throw away
 * a list the child could not re-derive from its own cwd. So each of the four is proved
 * cwd-sensitive here with two real trees and distinct on-disk bytes, and the profile-rooted half
 * of each is proved to SURVIVE the cwd change, which is what makes re-discovery safe rather than
 * starving.
 *
 * IF THIS REGRESSES: either a guard is protecting a layer that has no project scope (the guard
 * should go), or a layer lost its project scope while a guard kept forcing rediscovery of
 * nothing (the guard should go). Both are silent: the child still looks configured.
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

		expect(fromA.map(file => file.path)).toEqual([t.globalAgentsPath, t.treeAAgentsPath, t.profileAgentsPath]);
		expect(fromB.map(file => file.path)).toEqual([t.globalAgentsPath, t.treeBAgentsPath, t.profileAgentsPath]);
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
	 * LOCKS OUT: a cwd guard on rules being removed as unnecessary. `sdk.ts` loads rules as
	 * `loadCapability("rules", { cwd })`, so this is the exact call a child re-runs.
	 */
	it("resolves a different project rule for each tree, and keeps the profile one", async () => {
		const t = twoTrees("layers-rules");

		const namesFor = async (cwd: string): Promise<string[]> => {
			t.resetCaches();
			const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
			return result.items.map(rule => rule.name).sort();
		};

		const fromA = await namesFor(t.treeA);
		const fromB = await namesFor(t.treeB);

		expect(fromA).toContain("alpha-rule");
		expect(fromA).not.toContain("beta-rule");
		expect(fromB).toContain("beta-rule");
		expect(fromB).not.toContain("alpha-rule");
		expect(fromA).toContain("profile-rule");
		expect(fromB).toContain("profile-rule");
	});

	/**
	 * LOCKS OUT: the claim that a session's skills are purely agent-dir-rooted, which would make
	 * the cwd guard on skills a pure loss.
	 *
	 * The session skill allowlist is `native` + `veyyon-managed` + `veyyon-plugins`, and project
	 * `.veyyon/skills` is deliberately NOT scanned. The ONE project scope that reaches a session's
	 * skills is `<cwd>/.veyyon/settings.json#extensions`, whose `skills/` directory is scanned by
	 * the `veyyon-plugins` provider. That is what makes the guard correct, and it is narrow enough
	 * that a refactor could remove it without any other test noticing.
	 */
	it("resolves a different project extension skill for each tree, and keeps the profile one", async () => {
		const t = twoTrees("layers-skills");

		const namesFor = async (cwd: string): Promise<string[]> => {
			t.resetCaches();
			const result = await discoverSkills(cwd, t.agentDir);
			return result.skills.map(skill => skill.name).sort();
		};

		const fromA = await namesFor(t.treeA);
		const fromB = await namesFor(t.treeB);

		expect(fromA).toEqual(["alpha-skill", "profile-skill"]);
		expect(fromB).toEqual(["beta-skill", "profile-skill"]);
	});
});
