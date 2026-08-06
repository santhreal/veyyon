/**
 * Regression tests for top-level `RULES.md` sticky rules.
 *
 * `RULES.md` (singular, top-level) is loaded as a sticky always-apply rule from
 * the loading profile's agent dir (`<agentDir>/RULES.md`) and from NOWHERE ELSE.
 *
 * A repository's `.veyyon/RULES.md` was honored at level "project" until
 * eea8680b6 / 0adabd386 ("never load configuration from the working tree"): a
 * checked-out tree is content the operator may not have written, and a sticky
 * rule is the strongest grant in the system — re-injected next to every single
 * turn. `getConfigDirs` is user-scope only now and `loadStickyRulesFile` takes a
 * literal `"user"` level, so the `RULES@project` rule no longer exists. The
 * negative cases below pin that door shut at the loader that owns it; the
 * whole-repo sweep lives in
 * `test/security/the-working-tree-does-not-configure-the-agent.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@veyyon/coding-agent/capability";
import { clearCache } from "@veyyon/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@veyyon/coding-agent/capability/rule";
import type { LoadContext } from "@veyyon/coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeSyncWithRetries, setAgentDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
let tempDir: string;
let home: string;
let project: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNativeRules(ctx: LoadContext): Promise<Rule[]> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native rules provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

async function loadRulesCapability(cwd: string): Promise<Rule[]> {
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd, providers: ["native"] });
	return result.items;
}

beforeEach(() => {
	settingsState = beginSettingsTest();
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-md-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	setAgentDir(path.join(home, ".veyyon", "agent"));
});

afterEach(() => {
	clearCache();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	removeSyncWithRetries(tempDir);
});

test("user ~/.veyyon/agent/RULES.md becomes an alwaysApply rule", async () => {
	writeFile(
		path.join(home, ".veyyon", "agent", "RULES.md"),
		"**CRITICAL**: You _MUST_ use beads task tracker for any project\n",
	);

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule).toBeDefined();
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("beads task tracker");
});

test("a repository's .veyyon contributes no rule at all", async () => {
	writeFile(path.join(project, ".veyyon", "RULES.md"), "# Project rule\nAlways say hi.\n");
	writeFile(path.join(project, ".veyyon", "rules", "checked-in.md"), "# Checked in\nAlso say bye.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.filter(r => r._source.level === "project")).toEqual([]);
	const allContent = rules.map(r => r.content).join("\n");
	expect(allContent).not.toContain("Always say hi.");
	expect(allContent).not.toContain("Also say bye.");
});

test("walking up from a sub-package cwd does not reach a repo .veyyon/RULES.md", async () => {
	const subPkg = path.join(project, "packages", "app");
	fs.mkdirSync(subPkg, { recursive: true });
	writeFile(path.join(project, ".veyyon", "RULES.md"), "# Repo-wide sticky rule\n");
	writeFile(path.join(subPkg, ".veyyon", "RULES.md"), "# Sub-package sticky rule\n");

	const rules = await loadNativeRules({ cwd: subPkg, home, repoRoot: project });

	expect(rules.map(r => r.path)).not.toContain(path.join(project, ".veyyon", "RULES.md"));
	expect(rules.map(r => r.path)).not.toContain(path.join(subPkg, ".veyyon", "RULES.md"));
});

test("the user sticky RULES.md survives public capability dedup and is the only one", async () => {
	const userRulesPath = path.join(home, ".veyyon", "agent", "RULES.md");
	const projectRulesPath = path.join(project, ".veyyon", "RULES.md");
	const userRuleText = "User sticky rule: keep the personal safety checklist active.\n";
	const projectRuleText = "Project sticky rule: require repo-local release notes.\n";
	writeFile(userRulesPath, userRuleText);
	writeFile(projectRulesPath, projectRuleText);

	const rules = await loadRulesCapability(project);

	const stickyRules = rules.filter(rule => rule.path === userRulesPath || rule.path === projectRulesPath);
	expect(stickyRules.map(rule => rule.path)).toEqual([userRulesPath]);

	const userRule = stickyRules[0];
	expect(userRule.name).toBe("RULES");
	expect(userRule._source.level).toBe("user");
	expect(userRule._source.path).toBe(userRulesPath);
	expect(userRule.alwaysApply).toBe(true);
	expect(userRule.content).toContain(userRuleText.trim());
	expect(userRule.content).not.toContain(projectRuleText.trim());
	expect("_shadowed" in userRule).toBe(false);
});

test("alwaysApply is forced even when frontmatter says false", async () => {
	writeFile(path.join(home, ".veyyon", "agent", "RULES.md"), "---\nalwaysApply: false\n---\nStick around anyway.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("Stick around anyway.");
});

test("absent RULES.md does not produce a rule", async () => {
	// No RULES.md anywhere — only a sibling .veyyon/rules/ to make sure the directory exists.
	writeFile(path.join(home, ".veyyon", "agent", "rules", "other.md"), "# Unrelated rule\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.find(r => r.name === "RULES")).toBeUndefined();
});
