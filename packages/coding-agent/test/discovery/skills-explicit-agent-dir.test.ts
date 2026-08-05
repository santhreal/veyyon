/**
 * `discoverSkills(cwd, agentDir, settings)` used to declare an agent dir, document
 * itself as "Discover skills from cwd and agentDir", and then drop the value on the
 * floor (`_agentDir`), forwarding only `cwd` to the loader. Every caller that named a
 * non-active agent dir, which is every spawned agent rooted in another profile, got
 * whichever profile the PROCESS booted with instead: a stranger's skills, or none.
 * Nothing failed, nothing warned, the skills just were not the operator's.
 *
 * Threading the parameter alone is not enough, which is the second half of what these
 * tests lock. Three providers are profile-rooted (`native` reading `<agentDir>/skills`,
 * `veyyon-managed` reading `<agentDir>/managed-skills`, `veyyon-plugins` reading
 * `<agentDir>/settings.json#extensions` and that profile's installed plugins), and every
 * one of them used to resolve the directory from the process-global `getAgentDir()`.
 * `loadSkills` forwards the value as `LoadOptions.agentDir`, which `loadCapability` puts
 * on the `LoadContext` each provider receives, and each provider reads it from there. It
 * does NOT re-resolve or post-filter those scopes: a filter would be a second source of
 * truth for the same question.
 *
 * If this regresses: an agent spawned against another profile silently runs with the
 * booting profile's skill set. Assertions below are exact sets, not "contains", so a
 * leak of the active profile's skills fails just as loudly as a miss of the named
 * profile's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { loadSkills } from "@veyyon/coding-agent/extensibility/skills";
import { discoverSkills } from "@veyyon/coding-agent/sdk";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("skills honor an explicitly named agent dir", () => {
	let settingsState: SettingsTestState | undefined;
	let projectDir = "";
	let activeRoot = "";
	let namedRoot = "";
	let activeProfile = "";
	let namedProfile = "";

	async function writeSkill(agentDir: string, subdir: string, name: string): Promise<string> {
		const file = path.join(agentDir, subdir, name, "SKILL.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `---\nname: ${name}\ndescription: Skill ${name}.\n---\nBody of ${name}.\n`);
		return file;
	}

	/** An extension package directory shipping one skill, the `veyyon-plugins` shape. */
	async function writePluginPackage(root: string, pkgName: string, skillName: string): Promise<string> {
		const dir = path.join(root, pkgName);
		await fs.mkdir(path.join(dir, "skills", skillName), { recursive: true });
		await fs.writeFile(
			path.join(dir, "skills", skillName, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: Skill ${skillName}.\n---\nBody of ${skillName}.\n`,
		);
		return dir;
	}

	async function declareExtensions(agentDir: string, packagePaths: string[]): Promise<void> {
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: packagePaths }));
	}

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-explicit-project-"));
		// Real profile layout: `<profile root>/agent` beside `<profile root>/plugins`, which is
		// what the plugin scope's agent-dir derivation relies on.
		activeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-explicit-active-"));
		namedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-explicit-named-"));
		activeProfile = path.join(activeRoot, "agent");
		namedProfile = path.join(namedRoot, "agent");
		await fs.mkdir(activeProfile, { recursive: true });
		await fs.mkdir(namedProfile, { recursive: true });
		// The process boots into `activeProfile`; every test below names the other one.
		setAgentDir(activeProfile);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(projectDir);
		await removeWithRetries(activeRoot);
		await removeWithRetries(namedRoot);
	});

	test("discoverSkills loads the NAMED agent dir's skills, not the active one's", async () => {
		const named = await writeSkill(namedProfile, "skills", "named-profile-skill");
		await writeSkill(activeProfile, "skills", "active-profile-skill");

		const { skills } = await discoverSkills(projectDir, namedProfile);

		// Exact identity: the skill resolves to the file written under the NAMED dir.
		expect(skills.map(skill => skill.name)).toEqual(["named-profile-skill"]);
		expect(skills[0].filePath).toBe(named);
	});

	test("passing an explicit agent dir CHANGES the result", async () => {
		await writeSkill(namedProfile, "skills", "named-profile-skill");
		await writeSkill(activeProfile, "skills", "active-profile-skill");

		// The defaulted call and the explicit call must not agree. Before the fix they
		// were identical, which is exactly how the parameter went unnoticed.
		const defaulted = await discoverSkills(projectDir);
		const explicit = await discoverSkills(projectDir, namedProfile);

		expect(defaulted.skills.map(s => s.name)).toEqual(["active-profile-skill"]);
		expect(explicit.skills.map(s => s.name)).toEqual(["named-profile-skill"]);
	});

	test("auto-learn managed skills follow the named agent dir too", async () => {
		// `managed-skills/` is the second directory rooted in the agent dir, and it is a
		// separate provider, so it can regress independently of `skills/`.
		await writeSkill(namedProfile, "managed-skills", "named-managed");
		await writeSkill(activeProfile, "managed-skills", "active-managed");

		const { skills } = await loadSkills({ cwd: projectDir, agentDir: namedProfile });

		expect(skills.map(skill => skill.name)).toEqual(["named-managed"]);
	});

	test("plugin-shipped skills follow the named agent dir, and passing it CHANGES the result", async () => {
		// `veyyon-plugins` is the third profile-scoped skill provider and the last one to be
		// threaded. Its roots come from `<agentDir>/settings.json#extensions` plus that
		// profile's installed plugins, both of which resolved the process-global agent dir,
		// so a redirected load used to get the booted profile's plugin packages.
		const namedPackage = await writePluginPackage(namedRoot, "named-pkg", "named-plugin-skill");
		const activePackage = await writePluginPackage(activeRoot, "active-pkg", "active-plugin-skill");
		await declareExtensions(namedProfile, [namedPackage]);
		await declareExtensions(activeProfile, [activePackage]);

		const defaulted = await loadSkills({ cwd: projectDir });
		const explicit = await loadSkills({ cwd: projectDir, agentDir: namedProfile });

		expect(defaulted.skills.map(skill => skill.name)).toEqual(["active-plugin-skill"]);
		expect(explicit.skills.map(skill => skill.name)).toEqual(["named-plugin-skill"]);
	});

	test("a project-scoped plugin package survives a redirected load", async () => {
		// The redirect must move only the PROFILE scope. A package declared in
		// `<cwd>/.veyyon/settings.json` belongs to the repository, so naming another agent
		// dir must not drop it: that would trade one silent loss for another.
		const projectPackage = await writePluginPackage(projectDir, "project-pkg", "project-plugin-skill");
		await fs.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".veyyon", "settings.json"),
			JSON.stringify({ extensions: [projectPackage] }),
		);

		const { skills } = await loadSkills({ cwd: projectDir, agentDir: namedProfile });

		expect(skills.map(skill => skill.name)).toEqual(["project-plugin-skill"]);
	});

	test("a named agent dir with no skills at all yields nothing, never the active profile's", async () => {
		await writeSkill(activeProfile, "skills", "active-profile-skill");

		const { skills } = await discoverSkills(projectDir, namedProfile);

		// The empty-set case is the one a fallback would quietly "fix" by serving the
		// active profile instead, which is the failure mode this whole class describes.
		expect(skills).toEqual([]);
	});

	test("omitting the agent dir keeps the active profile behavior unchanged", async () => {
		const active = await writeSkill(activeProfile, "skills", "active-profile-skill");

		const { skills } = await discoverSkills(projectDir);

		expect(skills.map(skill => skill.name)).toEqual(["active-profile-skill"]);
		expect(skills[0].filePath).toBe(active);
	});
});
