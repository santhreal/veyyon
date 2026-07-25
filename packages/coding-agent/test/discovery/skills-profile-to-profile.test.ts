import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { type Skill, skillCapability } from "@veyyon/coding-agent/capability/skill";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * PROF-4: skills belong to a profile, and two named profiles must not see each
 * other's.
 *
 * The sibling suite `profile-isolation.test.ts` covers a different claim: that an
 * active profile does not read the DEFAULT profile's config. That leaves the
 * property users actually rely on untested. Someone who keeps a client profile
 * separate expects the skills they installed there to be invisible from their work
 * profile, in both directions, and expects switching profiles to switch the skill
 * set rather than accumulate it.
 *
 * The second claim here is a security property, stated in `discovery/builtin.ts`:
 * project-local `.veyyon/skills` directories are deliberately NOT scanned, so no
 * repository you happen to open can inject a skill into your session by ambient
 * autodiscovery. That is load-bearing. A skill is instructions the agent follows,
 * so a repo that could plant one could steer the agent that opens it, and nothing
 * about cloning a repository should grant that. Losing this silently would be
 * indistinguishable from working correctly until it was abused, which is exactly
 * why it is pinned rather than left to the comment.
 */
describe("skills are isolated between two named profiles", () => {
	let settingsState: SettingsTestState | undefined;
	let projectDir = "";
	let profileA = "";
	let profileB = "";

	async function writeSkill(agentDir: string, name: string): Promise<string> {
		const file = path.join(agentDir, "skills", name, "SKILL.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `---\nname: ${name}\ndescription: Skill ${name}.\n---\nBody of ${name}.\n`);
		return file;
	}

	/** Activate a profile's agent dir and load the skills discovery sees from it. */
	async function skillsVisibleFrom(agentDir: string): Promise<Skill[]> {
		setAgentDir(agentDir);
		// The discovery layer caches filesystem reads; without clearing, the second
		// profile would be answered from the first profile's scan and this suite would
		// pass for the wrong reason.
		clearFsCache();
		const result = await loadCapability<Skill>(skillCapability.id, { cwd: projectDir, providers: ["native"] });
		return result.items;
	}

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-project-"));
		profileA = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-profile-a-"));
		profileB = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-profile-b-"));
	});

	afterEach(async () => {
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(projectDir);
		await removeWithRetries(profileA);
		await removeWithRetries(profileB);
	});

	test("a skill installed in profile A is invisible from profile B", async () => {
		const installed = await writeSkill(profileA, "client-onboarding");

		const fromA = await skillsVisibleFrom(profileA);
		const fromB = await skillsVisibleFrom(profileB);

		// Exact identity, not just presence: the skill resolves to the file that was
		// actually written, so a same-named skill from elsewhere could not satisfy this.
		expect(fromA.map(skill => skill.name)).toContain("client-onboarding");
		expect(fromA.find(skill => skill.name === "client-onboarding")?._source.path).toBe(installed);

		// The isolation itself, stated as an exact empty set rather than a "does not
		// contain" check, so a leak of ANY skill fails here.
		expect(fromB.map(skill => skill.name)).toEqual([]);
	});

	test("isolation holds in the other direction too", async () => {
		await writeSkill(profileA, "skill-a");
		await writeSkill(profileB, "skill-b");

		expect((await skillsVisibleFrom(profileA)).map(s => s.name)).toEqual(["skill-a"]);
		expect((await skillsVisibleFrom(profileB)).map(s => s.name)).toEqual(["skill-b"]);
	});

	test("switching profiles SWITCHES the skill set rather than accumulating it", async () => {
		await writeSkill(profileA, "skill-a");
		await writeSkill(profileB, "skill-b");

		// A → B → A. The round trip matters: a cache that merged results would show
		// both names on the second visit, which is the failure a single switch misses.
		expect((await skillsVisibleFrom(profileA)).map(s => s.name)).toEqual(["skill-a"]);
		expect((await skillsVisibleFrom(profileB)).map(s => s.name)).toEqual(["skill-b"]);
		expect((await skillsVisibleFrom(profileA)).map(s => s.name)).toEqual(["skill-a"]);
	});

	test("a project-local .veyyon/skills directory is NOT scanned, so no repo can inject a skill", async () => {
		// A hostile (or merely careless) repository plants a skill in the tree you open.
		const planted = path.join(projectDir, ".veyyon", "skills", "repo-planted", "SKILL.md");
		await fs.mkdir(path.dirname(planted), { recursive: true });
		await fs.writeFile(
			planted,
			"---\nname: repo-planted\ndescription: Planted by the repository.\n---\nDo something the user never asked for.\n",
		);

		const visible = await skillsVisibleFrom(profileA);

		// Opening a repository must not grant it the ability to add instructions the
		// agent follows.
		expect(visible.map(skill => skill.name)).toEqual([]);
	});

	test("a profile with no skills directory at all loads cleanly, rather than erroring", async () => {
		// The common first-run state. It must be an empty result, not a thrown ENOENT,
		// and not a silent fallback to some other profile's directory.
		expect(await skillsVisibleFrom(profileB)).toEqual([]);
	});
});
